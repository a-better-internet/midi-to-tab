/**
 * Candidate guitar voicing generation (brief sections 22, 26, 27).
 *
 * Section 22 is emphatic: "don't simply use a chord dictionary. The engine
 * should derive voicings from the actual pitches present in the MIDI." So this
 * module starts from the event's notes and their roles, works out which pitch
 * classes carry the harmony's identity, and then searches the fretboard for
 * every reachable shape that expresses them.
 *
 * The search is anchored: for each candidate hand position (a window of
 * `maxFretSpan` frets) it enumerates the allowed frets per string and walks
 * them depth-first. That keeps the search space small without resorting to
 * stored shapes, and it means alternative voicings are genuinely alternatives
 * rather than entries from a table.
 */

import { ROLES } from '../analysis/noteRoleClassifier.js';

export const EXTENSION_LEVELS = {
  triads: { maxDegree: 7, label: 'Triads only' },
  sevenths: { maxDegree: 11, label: '7ths' },
  ninths: { maxDegree: 14, label: '7ths + 9ths' },
  all: { maxDegree: 99, label: 'All detected extensions' },
};

export const TRANSCRIPTION_MODES = {
  literal: { label: 'Literal', maxStrings: 6, spanBonus: 0, pitchFidelity: 1.0, minCoverage: 0.95 },
  balanced: { label: 'Balanced', maxStrings: 6, spanBonus: 0, pitchFidelity: 0.6, minCoverage: 0.7 },
  playable: { label: 'Playable', maxStrings: 5, spanBonus: 1, pitchFidelity: 0.3, minCoverage: 0.55 },
};

/** Which chord degrees survive the Include Extensions control. */
function allowedIntervals(chord, extensionLevel) {
  if (!chord || !chord.intervals) return [];
  const level = EXTENSION_LEVELS[extensionLevel] ?? EXTENSION_LEVELS.sevenths;
  const core = [0, 2, 3, 4, 5, 6, 7, 8];
  return chord.intervals.filter((interval) => {
    const i = ((interval % 12) + 12) % 12;
    if (core.includes(i)) {
      // sus2/sus4/add9 degrees are structural, not extensions.
      if ((i === 2 || i === 5) && level.maxDegree < 14) {
        const isSus = chord.templateId && /sus|add9|6\/9|11|13/.test(chord.templateId);
        return isSus || level.maxDegree >= 14;
      }
      return true;
    }
    if (i === 10 || i === 11) return level.maxDegree >= 11; // sevenths
    if (i === 9) return level.maxDegree >= 11; // 6th / 13th
    if (i === 1) return level.maxDegree >= 14;
    return level.maxDegree >= 14;
  });
}

/**
 * Work out what the guitar actually has to say, from the notes and their roles.
 *
 * Implements section 26's priority hierarchy:
 *   1 root/bass identity, 2 chord quality, 3 extensions, 4 melody,
 *   5 duplicated chord tones.
 *
 * @returns {object} target spec consumed by the search
 */
export function buildVoicingTargets(event, options = {}) {
  const {
    includeExtensions = 'sevenths',
    preservePianoVoicing = false,
    transcriptionMode = 'balanced',
  } = options;

  const chord = event.chord || null;
  const notes = event.notes || [];
  const mode = TRANSCRIPTION_MODES[transcriptionMode] ?? TRANSCRIPTION_MODES.balanced;

  const pcWeights = new Map(); // pc -> { weight, priority, sourcePitches:Set }
  const bump = (pc, weight, priority, sourcePitch) => {
    const key = ((pc % 12) + 12) % 12;
    const entry = pcWeights.get(key) || { pc: key, weight: 0, priority: 9, sourcePitches: new Set() };
    entry.weight += weight;
    entry.priority = Math.min(entry.priority, priority);
    if (sourcePitch !== undefined && sourcePitch !== null) entry.sourcePitches.add(sourcePitch);
    pcWeights.set(key, entry);
  };

  const permitted = chord ? new Set(allowedIntervals(chord, includeExtensions).map(
    (i) => (chord.root + i) % 12,
  )) : null;

  let bassPitch = null;
  let melodyPitch = null;

  for (const note of notes) {
    const role = note.role ?? ROLES.UNKNOWN;
    const pc = ((note.pitch % 12) + 12) % 12;

    switch (role) {
      case ROLES.BASS:
        bump(pc, 3.0, 1, note.pitch);
        if (bassPitch === null || note.pitch < bassPitch) bassPitch = note.pitch;
        break;
      case ROLES.ROOT:
        bump(pc, 2.4, 1, note.pitch);
        break;
      case ROLES.CHORD_TONE:
        bump(pc, 1.8, 2, note.pitch);
        break;
      case ROLES.EXTENSION:
        if (!permitted || permitted.has(pc)) bump(pc, 1.1, 3, note.pitch);
        break;
      case ROLES.MELODY:
      case ROLES.ARPEGGIO:
        bump(pc, 1.3, 4, note.pitch);
        if (melodyPitch === null || note.pitch > melodyPitch) melodyPitch = note.pitch;
        break;
      case ROLES.PASSING_TONE:
      case ROLES.APPROACH_TONE:
        // Section 16: these must not become chord tones. In Literal mode they
        // still get voiced; otherwise they are dropped from the chord shape and
        // the tab renders them as the melodic notes they are.
        if (transcriptionMode === 'literal') bump(pc, 0.5, 5, note.pitch);
        break;
      case ROLES.ORNAMENT:
        if (transcriptionMode === 'literal') bump(pc, 0.3, 6, note.pitch);
        break;
      default:
        bump(pc, 0.6, 5, note.pitch);
        break;
    }
  }

  // The chord's identity tones are wanted even if the pianist left them out
  // (an implied fifth, a rootless left hand), unless we are being literal.
  if (chord && chord.intervals && transcriptionMode !== 'literal') {
    const essentials = [0, 3, 4, 10, 11, 6, 8].filter((i) => chord.intervals.includes(i));
    for (const interval of essentials) {
      const pc = (chord.root + interval) % 12;
      if (!pcWeights.has(pc)) bump(pc, interval === 0 ? 1.6 : 1.2, interval === 0 ? 1 : 2);
    }
  }

  if (bassPitch === null && notes.length > 0) {
    bassPitch = Math.min(...notes.map((n) => n.pitch));
  }
  if (chord && chord.bass !== null && chord.bass !== undefined) {
    bump(chord.bass, 1.5, 1);
  }

  const targets = [...pcWeights.values()].sort(
    (a, b) => a.priority - b.priority || b.weight - a.weight,
  );

  // Required = what the harmony cannot survive losing.
  const required = new Set(
    targets.filter((t) => t.priority <= (mode.minCoverage >= 0.9 ? 3 : 2)).map((t) => t.pc),
  );

  return {
    chord,
    targets,
    allowedPcs: new Set(targets.map((t) => t.pc)),
    requiredPcs: required,
    bassPc: bassPitch !== null ? ((bassPitch % 12) + 12) % 12
      : (chord ? chord.bass : null),
    bassPitch,
    rootPc: chord ? chord.root : null,
    melodyPitch,
    originalPitches: notes.map((n) => n.pitch),
    preservePianoVoicing,
    mode,
    totalWeight: targets.reduce((a, t) => a + t.weight, 0),
  };
}

function shapeKey(frets) {
  return frets.map((f) => (f === null ? 'x' : f)).join('.');
}

/**
 * Enumerate voicings for one chord event.
 *
 * @param {object} event chord event (chord + notes with roles)
 * @param {Fretboard} fretboard
 * @param {object} [options]
 * @param {number} [options.maxFretSpan=4]
 * @param {number} [options.minFret=0]
 * @param {number|null} [options.maxFret=null]
 * @param {number} [options.maxCandidates=48]
 * @param {number} [options.maxMutedInterior=1]
 * @returns {Array} candidate voicings
 */
export function generateVoicings(event, fretboard, options = {}) {
  const {
    maxFretSpan = 4,
    minFret = 0,
    maxFret = null,
    maxCandidates = 48,
    maxMutedInterior = 1,
    includeExtensions = 'sevenths',
    transcriptionMode = 'balanced',
    preservePianoVoicing = false,
    requireBassLowest = true,
  } = options;

  const targets = buildVoicingTargets(event, {
    includeExtensions, preservePianoVoicing, transcriptionMode,
  });

  const stringCount = fretboard.stringCount;
  const topFret = Math.min(maxFret ?? fretboard.fretCount, fretboard.fretCount);
  const bottomFret = Math.max(0, minFret);
  const span = Math.max(1, maxFretSpan + (targets.mode.spanBonus ?? 0));
  const maxStrings = Math.min(stringCount, targets.mode.maxStrings ?? stringCount);

  // Single-note events (melody, arpeggio steps, bass notes) are not chords.
  const isSingle = (event.notes || []).length === 1
    || targets.allowedPcs.size === 1
    || event.kind === 'note';

  if (isSingle) {
    return generateSingleNoteVoicings(event, fretboard, {
      minFret: bottomFret, maxFret: topFret, maxCandidates,
    });
  }

  const results = [];
  const seen = new Set();

  // Anchored search: one pass per hand position.
  for (let anchor = bottomFret; anchor <= Math.max(bottomFret, topFret - span + 1); anchor += 1) {
    const windowLow = anchor;
    const windowHigh = Math.min(topFret, anchor + span - 1);

    // Allowed frets per string inside this window (open strings always allowed
    // because they need no finger and section 23 explicitly prefers them).
    const optionsPerString = [];
    for (let s = 0; s < stringCount; s += 1) {
      const choices = [null]; // muted
      const open = fretboard.openPitches[s];
      const addIfWanted = (fret) => {
        const pitch = open + fret;
        const pc = ((pitch % 12) + 12) % 12;
        if (!targets.allowedPcs.has(pc)) return;
        choices.push(fret);
      };
      if (bottomFret === 0 && fretboard.capo === 0) addIfWanted(0);
      for (let fret = Math.max(1, windowLow); fret <= windowHigh; fret += 1) addIfWanted(fret);
      optionsPerString.push(choices);
    }

    // Depth-first over strings, lowest first.
    const current = new Array(stringCount).fill(null);

    const walk = (s, playedCount, fretsUsed) => {
      if (results.length >= maxCandidates * 3) return;
      if (s === stringCount) {
        if (playedCount < 2) return;
        const voicing = finalizeShape(current, fretboard, targets, { span, requireBassLowest });
        if (!voicing) return;
        const key = shapeKey(current);
        if (seen.has(key)) return;
        seen.add(key);
        results.push(voicing);
        return;
      }

      for (const fret of optionsPerString[s]) {
        if (fret === null) {
          current[s] = null;
          walk(s + 1, playedCount, fretsUsed);
          continue;
        }
        if (playedCount >= maxStrings) continue;

        // Fret-span pruning (section 27): fingered frets only; open strings and
        // capoed frets cost no stretch.
        const next = fret > fretboard.capo ? [...fretsUsed, fret] : fretsUsed;
        if (next.length > 0) {
          const lo = Math.min(...next);
          const hi = Math.max(...next);
          if (hi - lo + 1 > span) continue;
        }
        current[s] = fret;
        walk(s + 1, playedCount + 1, next);
      }
      current[s] = null;
    };

    walk(0, 0, []);
  }

  // Interior-mute screening: x-x-3-2-0-1 is fine, 3-x-2-x-1-0 is not.
  const filtered = results.filter((v) => v.mutedInterior <= maxMutedInterior);
  const pool = filtered.length > 0 ? filtered : results;

  return pool.slice(0, Math.max(maxCandidates, 1));
}

function finalizeShape(frets, fretboard, targets, { span, requireBassLowest }) {
  const played = [];
  for (let s = 0; s < frets.length; s += 1) {
    if (frets[s] === null) continue;
    played.push({ string: s, fret: frets[s], pitch: fretboard.openPitches[s] + frets[s] });
  }
  if (played.length < 2) return null;

  const pitches = played.map((p) => p.pitch);
  const lowest = Math.min(...pitches);
  const highest = Math.max(...pitches);
  const lowestPc = ((lowest % 12) + 12) % 12;

  // Section 12/26: the bass identity is priority 1. A shape whose lowest note
  // is not the intended bass (or at least the root) misrepresents the chord.
  if (requireBassLowest && targets.bassPc !== null && targets.bassPc !== undefined) {
    if (lowestPc !== targets.bassPc && lowestPc !== targets.rootPc) return null;
  }

  const fingered = played.filter((p) => p.fret > fretboard.capo).map((p) => p.fret);
  const minPlayedFret = fingered.length ? Math.min(...fingered) : 0;
  const maxPlayedFret = fingered.length ? Math.max(...fingered) : 0;
  const fretSpan = fingered.length ? maxPlayedFret - minPlayedFret + 1 : 0;
  if (fretSpan > span) return null;

  // Coverage of the intended pitch classes.
  const presentPcs = new Set(pitches.map((p) => ((p % 12) + 12) % 12));
  let covered = 0;
  const missing = [];
  for (const target of targets.targets) {
    if (presentPcs.has(target.pc)) covered += target.weight;
    else missing.push(target);
  }
  const coverage = targets.totalWeight > 0 ? covered / targets.totalWeight : 0;

  for (const pc of targets.requiredPcs) {
    if (!presentPcs.has(pc)) return null;
  }

  // Interior muted strings (gaps between played strings).
  const stringsPlayed = played.map((p) => p.string);
  const firstString = Math.min(...stringsPlayed);
  const lastString = Math.max(...stringsPlayed);
  let mutedInterior = 0;
  for (let s = firstString + 1; s < lastString; s += 1) {
    if (frets[s] === null) mutedInterior += 1;
  }

  return {
    frets: [...frets],
    played,
    pitches,
    pitchSet: presentPcs,
    lowestPitch: lowest,
    highestPitch: highest,
    stringsUsed: played.length,
    openStrings: played.filter((p) => p.fret === 0).length,
    minFret: minPlayedFret,
    maxFret: maxPlayedFret,
    fretSpan,
    position: fingered.length ? minPlayedFret : 0,
    mutedInterior,
    coverage,
    missingTargets: missing.map((m) => m.pc),
    targets,
  };
}

/**
 * Single notes get their own (much simpler) enumeration: every fretboard
 * location for the pitch, plus octave-folded fallbacks when the piano note is
 * outside the instrument's range.
 */
export function generateSingleNoteVoicings(event, fretboard, options = {}) {
  const { minFret = 0, maxFret = null, maxCandidates = 12 } = options;
  const top = Math.min(maxFret ?? fretboard.fretCount, fretboard.fretCount);
  const notes = event.notes || [];
  if (notes.length === 0) return [];

  // Voice the most important note of the event.
  const note = [...notes].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)
    || b.pitch - a.pitch)[0];

  const folded = fretboard.foldIntoRange(note.pitch);
  if (!folded) return [];

  const positions = fretboard.positionsFor(folded.pitch)
    .filter((p) => p.fret >= minFret && p.fret <= top);

  const pool = positions.length ? positions : fretboard.positionsFor(folded.pitch);

  return pool.slice(0, maxCandidates).map((p) => {
    const frets = new Array(fretboard.stringCount).fill(null);
    frets[p.string] = p.fret;
    return {
      frets,
      played: [{ string: p.string, fret: p.fret, pitch: p.pitch }],
      pitches: [p.pitch],
      pitchSet: new Set([((p.pitch % 12) + 12) % 12]),
      lowestPitch: p.pitch,
      highestPitch: p.pitch,
      stringsUsed: 1,
      openStrings: p.fret === 0 ? 1 : 0,
      minFret: p.fret,
      maxFret: p.fret,
      fretSpan: p.fret > 0 ? 1 : 0,
      position: p.fret,
      mutedInterior: 0,
      coverage: 1,
      missingTargets: [],
      octaveShift: folded.octaveShift,
      isSingleNote: true,
      targets: { originalPitches: [note.pitch], melodyPitch: note.pitch, bassPc: null, rootPc: null, targets: [] },
    };
  });
}

/** Render a shape the way guitarists write it: "x 3 2 0 1 0". */
export function formatShape(voicing) {
  return voicing.frets.map((f) => (f === null ? 'x' : String(f))).join(' ');
}
