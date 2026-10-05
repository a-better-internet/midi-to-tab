/**
 * The analysis pipeline (brief sections 2, 19, 40).
 *
 *   notes -> clusters -> local chord candidates -> key -> sequential context
 *         -> arpeggio detection -> role classification -> chord events
 *
 * Section 40's chain is the spec for this file, in order. Nothing here knows
 * anything about guitars: the output is an instrument-independent description of
 * what the keyboard part is doing musically, which is what lets the same engine
 * drive guitar, bass, ukulele or banjo (section 36).
 *
 * The output keeps a reference to every source note, so the whole analysis is
 * reversible and re-runnable without touching the MIDI again (section 2).
 */

import { clusterNotesAdaptive, DEFAULT_CLUSTER_WEIGHTS } from '../analysis/noteClusterer.js';
import { recognizeChord } from '../analysis/chordRecognizer.js';
import { detectKey } from '../analysis/keyDetector.js';
import { resolveProgression, romanNumeral } from '../analysis/harmonicContext.js';
import {
  classifyNoteRoles, detectArpeggios, extractMelodyLine, ROLES, ROLE_PRIORITY,
} from '../analysis/noteRoleClassifier.js';

export const DEFAULT_ANALYSIS_OPTIONS = {
  chordComplexity: 'extended', // basic | extended | exact
  clusterWeights: DEFAULT_CLUSTER_WEIGHTS,
  groupWindowMs: null, // null = adapt to the performance
  clusterThreshold: 0.52,
  contextWeight: 0.45,
  detectArpeggios: true,
  minHarmonyNotes: 2,
  /** Re-read the harmony once roles are known (section 16). */
  refineWithRoles: true,
};

/**
 * A harmony timeline: which chord is in force at any musical moment.
 * Built from chordal clusters and arpeggio figures, each extending until the
 * next harmonic event begins.
 */
/**
 * How much a note should count toward naming the harmony it sits inside.
 *
 * On the first pass nothing is known, so everything counts equally. On the
 * refinement pass the roles from pass 1 are available, and section 16's rule
 * applies: decoration must not become harmony. A passing tone contributes
 * nothing to the chord name, and a melody note contributes only a little --
 * enough to colour a reading, not enough to rename it.
 */
function harmonicWeightForRole(role) {
  switch (role) {
    case ROLES.PASSING_TONE:
    case ROLES.APPROACH_TONE:
    case ROLES.ORNAMENT:
      return 0;
    case ROLES.MELODY:
      return 0.2;
    case ROLES.EXTENSION:
      return 0.8;
    default:
      return 1;
  }
}

function weighNotes(notes, roles) {
  if (!roles) return notes;
  return notes.map((note) => {
    const role = roles.get(note.id);
    return role
      ? { ...note, harmonicWeight: harmonicWeightForRole(role.role) }
      : note;
  });
}

function buildHarmonyAnchors(clusters, arpeggios, options) {
  const { minHarmonyNotes, chordComplexity, keyProfile, flats, roles = null } = options;
  const anchors = [];
  const arpeggioClusterIndices = new Set(arpeggios.flatMap((a) => a.clusterIndices));

  for (const arpeggio of arpeggios) {
    const notes = arpeggio.clusterIndices.flatMap(
      (i) => clusters.find((c) => c.index === i)?.notes ?? [],
    );
    // Inside an arpeggio every note outlines the chord, so roles are not used
    // to discount them here.
    const recognized = recognizeChord(notes, {
      complexity: chordComplexity, keyProfile, flats,
    });
    anchors.push({
      kind: 'arpeggio',
      start: arpeggio.start,
      end: arpeggio.end,
      notes,
      candidates: recognized.candidates,
      arpeggio,
      clusterIndices: [...arpeggio.clusterIndices],
    });
  }

  for (const cluster of clusters) {
    if (cluster.notes.length < minHarmonyNotes) continue;
    if (arpeggioClusterIndices.has(cluster.index)) continue;
    const weighted = weighNotes(cluster.notes, roles);
    const recognized = recognizeChord(weighted, {
      complexity: chordComplexity, keyProfile, flats,
    });
    if (!recognized.best) continue;
    anchors.push({
      kind: 'chord',
      start: cluster.start,
      end: cluster.end,
      notes: cluster.notes,
      candidates: recognized.candidates,
      cluster,
      clusterIndices: [cluster.index],
    });
  }

  anchors.sort((a, b) => a.start - b.start);
  return anchors;
}

/**
 * Run the full harmonic analysis.
 *
 * @param {Array} notes normalized notes (already filtered to the chosen tracks)
 * @param {object} [options] see DEFAULT_ANALYSIS_OPTIONS
 * @returns {object} analysis result
 */
export function analyzeHarmony(notes, options = {}) {
  const opts = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };

  if (!notes || notes.length === 0) {
    return {
      notes: [], clusters: [], arpeggios: [], events: [], regions: [],
      key: detectKey([]), roles: new Map(), melodyLine: [], timingCharacter: null,
      chordAt: () => null,
    };
  }

  // 1. Temporal clustering (sections 6-9).
  const { clusters, character, groupWindowMs } = clusterNotesAdaptive(notes, {
    weights: opts.clusterWeights,
    threshold: opts.clusterThreshold,
    groupWindowMs: opts.groupWindowMs ?? undefined,
  });

  // 2. Key detection (section 15) -- needs clusters for cadence weighting.
  const key = detectKey(notes, { clusters });

  // 3. Arpeggio detection (section 18) before harmonic anchoring, so an
  //    arpeggiated chord is treated as one harmony rather than N events.
  const arpeggios = opts.detectArpeggios ? detectArpeggios(clusters) : [];

  // 4-5. Local chord recognition plus sequential/global resolution, run twice.
  //
  // The two passes break the chicken-and-egg problem at the centre of the
  // brief: role classification needs to know the harmony (section 17), but
  // naming the harmony correctly needs to know which notes are decoration
  // (section 16). Pass 1 gets a provisional reading, pass 2 re-reads the
  // harmony with melody and passing tones discounted.
  const runHarmonyPass = (roles) => {
    const passAnchors = buildHarmonyAnchors(clusters, arpeggios, {
      minHarmonyNotes: opts.minHarmonyNotes,
      chordComplexity: opts.chordComplexity,
      keyProfile: key.profile,
      flats: key.preferFlats,
      roles,
    });
    const passResolved = resolveProgression(
      passAnchors.map((a) => ({ ...a, durationBeats: a.end - a.start })),
      key,
      { contextWeight: opts.contextWeight },
    );
    return { anchors: passAnchors, resolved: passResolved };
  };

  const makeChordAt = (regionList) => (beat) => {
    let found = null;
    for (const region of regionList) {
      if (region.start <= beat + 1e-6 && beat < region.end + 1e-6) found = region.chord;
      else if (region.start > beat) break;
    }
    if (found) return found;
    let fallback = null;
    for (const region of regionList) {
      if (region.start <= beat + 1e-6) fallback = region.chord;
      else break;
    }
    return fallback;
  };

  const makeRegions = (anchorList, resolvedList) => anchorList.map((anchor, i) => {
    const next = anchorList[i + 1];
    const chord = resolvedList[i] ? resolvedList[i].chosen : null;
    return {
      index: i,
      kind: anchor.kind,
      start: anchor.start,
      end: next ? Math.max(anchor.end, next.start) : anchor.end,
      ownEnd: anchor.end,
      chord,
      candidates: resolvedList[i] ? resolvedList[i].candidates : anchor.candidates,
      contextChanged: resolvedList[i] ? resolvedList[i].contextChanged : false,
      localBest: resolvedList[i] ? resolvedList[i].localBest : null,
      confidence: chord ? chord.confidence : 0,
      roman: chord ? romanNumeral(chord, key) : null,
      arpeggio: anchor.arpeggio ?? null,
      clusterIndices: anchor.clusterIndices,
      notes: anchor.notes,
    };
  });

  // Pass 1: provisional harmony, then provisional roles.
  const first = runHarmonyPass(null);
  const firstRegions = makeRegions(first.anchors, first.resolved);
  const provisionalRoles = classifyNoteRoles(notes, {
    chordAt: makeChordAt(firstRegions), clusters, arpeggios,
  });

  // Pass 2: re-read the harmony with decoration discounted.
  const second = opts.refineWithRoles === false ? first : runHarmonyPass(provisionalRoles);
  const anchors = second.anchors;
  const resolved = second.resolved;

  // 6. Harmony regions: each anchor holds until the next one starts.
  const regions = anchors.map((anchor, i) => {
    const next = anchors[i + 1];
    const chord = resolved[i] ? resolved[i].chosen : null;
    return {
      index: i,
      kind: anchor.kind,
      start: anchor.start,
      end: next ? Math.max(anchor.end, next.start) : anchor.end,
      ownEnd: anchor.end,
      chord,
      candidates: resolved[i] ? resolved[i].candidates : anchor.candidates,
      contextChanged: resolved[i] ? resolved[i].contextChanged : false,
      localBest: resolved[i] ? resolved[i].localBest : null,
      confidence: chord ? chord.confidence : 0,
      roman: chord ? romanNumeral(chord, key) : null,
      arpeggio: anchor.arpeggio ?? null,
      clusterIndices: anchor.clusterIndices,
      notes: anchor.notes,
    };
  });

  // The harmony timeline: which chord is in force at any musical moment.
  const chordAt = makeChordAt(regions);

  // 7. Final role classification against the refined harmony (sections 16-17).
  const roles = classifyNoteRoles(notes, { chordAt, clusters, arpeggios });
  const melodyLine = extractMelodyLine(notes);

  // 8. Build the chord events of section 19.
  const regionByCluster = new Map();
  regions.forEach((region) => {
    for (const ci of region.clusterIndices) regionByCluster.set(ci, region);
  });

  const events = clusters.map((cluster, i) => {
    const region = regionByCluster.get(cluster.index) ?? null;
    const containing = region || { chord: chordAt(cluster.start), candidates: [], index: -1 };
    const arpeggio = (region && region.arpeggio) || null;

    const eventNotes = cluster.notes.map((note) => {
      const role = roles.get(note.id);
      return {
        noteId: note.id,
        pitch: note.pitch,
        start: note.start,
        duration: note.duration,
        velocity: note.velocity,
        role: role ? role.role : ROLES.UNKNOWN,
        chordFunction: role ? role.chordFunction : 'NON_CHORD',
        priority: role ? role.priority : ROLE_PRIORITY[ROLES.UNKNOWN],
        interval: role ? role.interval : null,
        reason: role ? role.reason : null,
      };
    });

    const isChordEvent = cluster.notes.length >= opts.minHarmonyNotes;

    return {
      id: i,
      kind: isChordEvent ? 'chord' : (arpeggio ? 'arpeggio-note' : 'note'),
      clusterIndex: cluster.index,
      start: cluster.start,
      end: cluster.end,
      duration: Math.max(cluster.end - cluster.start, 1e-6),
      startSec: cluster.startSec,
      notes: eventNotes,
      noteIds: cluster.noteIds,
      chord: containing.chord,
      candidates: containing.candidates ?? [],
      regionIndex: region ? region.index : -1,
      arpeggio,
      confidence: containing.chord ? containing.chord.confidence : 0,
      cohesion: cluster.cohesion,
      spreadMs: cluster.spreadMs,
      roman: region ? region.roman : null,
    };
  });

  return {
    notes,
    clusters,
    arpeggios,
    anchors,
    regions,
    events,
    key,
    roles,
    melodyLine,
    timingCharacter: character,
    groupWindowMs,
    chordAt,
  };
}

/**
 * Apply a user's manual chord override (section 32) and return a fresh
 * analysis-shaped object. The MIDI is never re-read: only the harmonic
 * interpretation and everything downstream of it is recomputed.
 *
 * @param {object} analysis previous result of analyzeHarmony
 * @param {number} regionIndex which harmony region to override
 * @param {object} chord the chosen chord candidate
 */
export function overrideRegionChord(analysis, regionIndex, chord) {
  const regions = analysis.regions.map((region) => {
    if (region.index !== regionIndex) return region;
    return {
      ...region,
      chord,
      confidence: chord.confidence ?? 1,
      overridden: true,
      roman: romanNumeral(chord, analysis.key),
    };
  });

  const chordAt = (beat) => {
    let found = null;
    for (const region of regions) {
      if (region.start <= beat + 1e-6 && beat < region.end + 1e-6) found = region.chord;
      else if (region.start > beat) break;
    }
    if (found) return found;
    let fallback = null;
    for (const region of regions) {
      if (region.start <= beat + 1e-6) fallback = region.chord;
      else break;
    }
    return fallback;
  };

  // Roles depend on the harmony, so they must be recomputed (a note that was a
  // chord tone under C may be a passing tone under Am).
  const roles = classifyNoteRoles(analysis.notes, {
    chordAt, clusters: analysis.clusters, arpeggios: analysis.arpeggios,
  });

  const regionByCluster = new Map();
  regions.forEach((region) => {
    for (const ci of region.clusterIndices) regionByCluster.set(ci, region);
  });

  const events = analysis.events.map((event) => {
    const region = regionByCluster.get(event.clusterIndex) ?? null;
    const chordHere = region ? region.chord : chordAt(event.start);
    return {
      ...event,
      chord: chordHere,
      candidates: region ? region.candidates : event.candidates,
      confidence: chordHere ? (chordHere.confidence ?? 1) : 0,
      roman: region ? region.roman : event.roman,
      notes: event.notes.map((note) => {
        const role = roles.get(note.noteId);
        return role
          ? {
            ...note,
            role: role.role,
            chordFunction: role.chordFunction,
            priority: role.priority,
            interval: role.interval,
            reason: role.reason,
          }
          : note;
      }),
    };
  });

  return { ...analysis, regions, events, roles, chordAt };
}
