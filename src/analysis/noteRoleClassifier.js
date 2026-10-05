/**
 * Musical role classification and arpeggio detection (brief sections 16-18).
 *
 * This is where "C E G A G E" stops being a Cmaj13 and becomes C major with a
 * melodic A-G figure over it. Without this stage the guitar engine would try to
 * voice every pitch the pianist touched and produce the "bizarre six-note
 * voicing" the brief warns about in section 17.
 *
 * Every note ends up with:
 *   role          -- the brief's enum (ROOT / CHORD_TONE / BASS / EXTENSION /
 *                    PASSING_TONE / APPROACH_TONE / MELODY / ARPEGGIO /
 *                    ORNAMENT / UNKNOWN)
 *   chordFunction -- what it means harmonically, independent of role, so the
 *                    guitar engine can still honour it inside an arpeggio
 *   priority      -- section 26's keep/drop hierarchy
 */

import { harmonicCompatibility, recognizeChord } from './chordRecognizer.js';

export const ROLES = {
  ROOT: 'ROOT',
  CHORD_TONE: 'CHORD_TONE',
  BASS: 'BASS',
  EXTENSION: 'EXTENSION',
  PASSING_TONE: 'PASSING_TONE',
  APPROACH_TONE: 'APPROACH_TONE',
  MELODY: 'MELODY',
  ARPEGGIO: 'ARPEGGIO',
  ORNAMENT: 'ORNAMENT',
  UNKNOWN: 'UNKNOWN',
};

/** Section 26: what the guitar engine keeps when it runs out of strings. */
export const ROLE_PRIORITY = {
  [ROLES.BASS]: 1,
  [ROLES.ROOT]: 1,
  [ROLES.CHORD_TONE]: 2,
  [ROLES.EXTENSION]: 3,
  [ROLES.MELODY]: 4,
  [ROLES.ARPEGGIO]: 4,
  [ROLES.APPROACH_TONE]: 5,
  [ROLES.PASSING_TONE]: 5,
  [ROLES.ORNAMENT]: 6,
  [ROLES.UNKNOWN]: 6,
};

export const TRIAD_CORE_INTERVALS = new Set([0, 3, 4, 6, 7, 8, 2, 5]);

export const DEFAULT_ROLE_OPTIONS = {
  /** Pitches at or below this are bass-register candidates. */
  bassCeiling: 55, // G3
  /** A note shorter than this (in beats) can be an ornament. */
  ornamentMaxBeats: 0.14,
  /** A note shorter than this (in beats) can be a passing tone. */
  passingMaxBeats: 0.6,
  /** Maximum interval (semitones) that still counts as "stepwise". */
  stepMax: 2,
  /** A top voice this far above the rest of the chord reads as a melody. */
  melodyGap: 5,
};

/**
 * Detect arpeggio figures (section 18).
 *
 * Signals, all required to some degree:
 *   - short, consistent onset intervals
 *   - mostly monophonic texture (one note at a time)
 *   - pitch classes that share a single harmonic centre
 *   - consistent durations
 *   - coherent contour (rising, falling, or an oscillation inside one harmony)
 *
 * @param {Array} clusters output of clusterNotes()
 * @param {object} [options]
 * @returns {Array} arpeggio regions
 */
export function detectArpeggios(clusters, options = {}) {
  const {
    minLength = 3,
    maxOnsetGapBeats = 1.01,
    minHarmonicCompatibility = 0.82,
    maxDurationRatio = 3.2,
  } = options;

  const regions = [];
  let i = 0;

  while (i < clusters.length) {
    // Arpeggios are built from single-note (or very thin) clusters.
    if (clusters[i].notes.length > 2) { i += 1; continue; }

    const run = [clusters[i]];
    let j = i + 1;

    while (j < clusters.length) {
      const prev = run[run.length - 1];
      const next = clusters[j];
      if (next.notes.length > 2) break;

      const gap = next.start - prev.start;
      if (gap <= 0 || gap > maxOnsetGapBeats) break;

      // Duration consistency: a sustained pad note does not belong in a run.
      const prevDur = Math.max(prev.duration, 1e-3);
      const nextDur = Math.max(next.duration, 1e-3);
      const ratio = Math.max(prevDur / nextDur, nextDur / prevDur);
      if (ratio > maxDurationRatio) break;

      // Harmonic coherence of the whole candidate run so far.
      const pitches = [...run.flatMap((c) => c.pitches), ...next.pitches];
      if (harmonicCompatibility(pitches) < minHarmonicCompatibility) break;

      run.push(next);
      j += 1;
    }

    if (run.length >= minLength) {
      const pitches = run.flatMap((c) => c.pitches);
      const distinctPcs = new Set(pitches.map((p) => ((p % 12) + 12) % 12));

      // A run that only alternates two pitch classes is a tremolo/ostinato, not
      // an arpeggio; three distinct classes is the minimum for a chord outline.
      if (distinctPcs.size >= 3) {
        const onsets = run.map((c) => c.start);
        const gaps = onsets.slice(1).map((t, k) => t - onsets[k]);
        const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const gapVariance = gaps.reduce((a, g) => a + (g - meanGap) ** 2, 0) / gaps.length;
        const rhythmicRegularity = meanGap > 0
          ? Math.max(0, 1 - Math.sqrt(gapVariance) / meanGap)
          : 0;

        const seq = run.map((c) => c.notes[c.notes.length - 1].pitch);
        let ups = 0;
        let downs = 0;
        for (let k = 1; k < seq.length; k += 1) {
          if (seq[k] > seq[k - 1]) ups += 1;
          else if (seq[k] < seq[k - 1]) downs += 1;
        }
        const total = ups + downs || 1;
        const directionality = Math.max(ups, downs) / total;
        const contour = ups > downs * 1.5 ? 'ascending'
          : downs > ups * 1.5 ? 'descending' : 'oscillating';

        const compat = harmonicCompatibility(pitches);
        const chord = recognizeChord(
          run.flatMap((c) => c.notes),
          { complexity: 'extended' },
        );

        const confidence = Math.max(0, Math.min(0.99,
          compat * 0.45 + rhythmicRegularity * 0.3 + directionality * 0.15
          + Math.min(1, run.length / 6) * 0.1));

        if (confidence >= 0.55) {
          regions.push({
            start: run[0].start,
            end: Math.max(...run.map((c) => c.end)),
            clusterIndices: run.map((c) => c.index),
            noteIds: run.flatMap((c) => c.noteIds),
            pitches,
            chord: chord.best,
            contour,
            rhythmicRegularity,
            directionality,
            meanOnsetGap: meanGap,
            confidence,
          });
          i = j;
          continue;
        }
      }
    }

    i += 1;
  }

  return regions;
}

/**
 * Build a monophonic "melody line": the top sounding voice over time.
 * Used for role MELODY and for the guitar engine's melody-preservation
 * priority (section 26, priority 4).
 */
export function extractMelodyLine(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const line = [];
  for (const note of sorted) {
    // A note is melody if nothing higher is sounding for most of its life.
    let coveredBy = 0;
    for (const other of sorted) {
      if (other === note || other.pitch <= note.pitch) continue;
      const overlap = Math.min(other.end, note.end) - Math.max(other.start, note.start);
      if (overlap > 0) coveredBy += overlap;
    }
    const exposure = 1 - Math.min(1, coveredBy / Math.max(note.duration, 1e-6));
    if (exposure > 0.5) line.push({ note, exposure });
  }
  line.sort((a, b) => a.note.start - b.note.start);
  return line;
}

/** Nearest preceding / following note in roughly the same voice. */
function buildVoiceNeighbours(notes, { voiceWindow = 7 } = {}) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const prev = new Map();
  const next = new Map();

  for (let i = 0; i < sorted.length; i += 1) {
    const note = sorted[i];
    // Look backwards for the closest-in-pitch note that already ended or started earlier.
    let best = null;
    for (let j = i - 1; j >= 0 && sorted[i].start - sorted[j].start < 4; j -= 1) {
      const cand = sorted[j];
      if (cand.start >= note.start - 1e-9) continue;
      const dist = Math.abs(cand.pitch - note.pitch);
      if (dist > voiceWindow) continue;
      if (!best || dist < best.dist || (dist === best.dist && cand.start > best.note.start)) {
        best = { note: cand, dist };
      }
    }
    if (best) prev.set(note.id, best.note);

    let bestNext = null;
    for (let j = i + 1; j < sorted.length && sorted[j].start - note.start < 4; j += 1) {
      const cand = sorted[j];
      if (cand.start <= note.start + 1e-9) continue;
      const dist = Math.abs(cand.pitch - note.pitch);
      if (dist > voiceWindow) continue;
      if (!bestNext || dist < bestNext.dist) bestNext = { note: cand, dist };
    }
    if (bestNext) next.set(note.id, bestNext.note);
  }

  return { prev, next };
}

function chordIntervalOf(pitch, chord) {
  return ((pitch - chord.root) % 12 + 12) % 12;
}

/**
 * Classify every note's musical role.
 *
 * @param {Array} notes normalized notes
 * @param {object} context
 * @param {(beat:number)=>object|null} context.chordAt harmony in force at a beat
 * @param {Array} [context.clusters]
 * @param {Array} [context.arpeggios]
 * @param {object} [options]
 * @returns {Map<number, object>} note id -> { role, chordFunction, priority, reason }
 */
export function classifyNoteRoles(notes, context, options = {}) {
  const opts = { ...DEFAULT_ROLE_OPTIONS, ...options };
  const { chordAt, clusters = [], arpeggios = [] } = context;

  const { prev, next } = buildVoiceNeighbours(notes);
  const melody = new Set(extractMelodyLine(notes).map((m) => m.note.id));
  const arpeggioByNote = new Map();
  for (const region of arpeggios) {
    for (const id of region.noteIds) arpeggioByNote.set(id, region);
  }

  // Lowest note of each cluster, for bass identification.
  const clusterBassIds = new Set();
  const clusterByNote = new Map();
  for (const cluster of clusters) {
    if (cluster.notes.length > 0) clusterBassIds.add(cluster.notes[0].id);
    for (const n of cluster.notes) clusterByNote.set(n.id, cluster);
  }

  /**
   * Is this note a melodic line riding on top of the harmony, rather than a
   * member of it? Two cues decide it, both of which a listener uses:
   *   - registral detachment: a gap between it and the rest of the chord
   *   - independence: it moves while the voices beneath it are held
   * This is what keeps "F A C + melodic E" from being renamed Fmaj7 (section 16).
   */
  const isDetachedTopVoice = (note) => {
    const cluster = clusterByNote.get(note.id);
    if (!cluster || cluster.notes.length < 3) return false;
    const pitches = cluster.notes.map((n) => n.pitch);
    const top = Math.max(...pitches);
    if (note.pitch !== top) return false;
    const below = pitches.filter((p) => p < top);
    if (below.length === 0) return false;
    const gap = top - Math.max(...below);
    if (gap >= opts.melodyGap) return true;
    // Independent rhythm: the top voice is shorter than the harmony under it.
    const harmonyDuration = cluster.notes
      .filter((n) => n.pitch !== top)
      .reduce((a, n) => Math.max(a, n.duration), 0);
    return harmonyDuration > note.duration * 1.6;
  };

  const result = new Map();

  for (const note of notes) {
    const chord = chordAt ? chordAt(note.start + Math.min(note.duration, 0.01) * 0.5) : null;
    const arpeggio = arpeggioByNote.get(note.id) || null;
    const isMelody = melody.has(note.id);
    const cluster = clusterByNote.get(note.id);
    const polyphonic = cluster ? cluster.notes.length > 1 : false;

    let chordFunction = 'NON_CHORD';
    let interval = null;
    let inTemplate = false;

    if (chord && chord.intervals) {
      interval = chordIntervalOf(note.pitch, chord);
      inTemplate = chord.intervals.some((i) => ((i % 12) + 12) % 12 === interval);
      if (interval === 0) chordFunction = 'ROOT';
      else if (inTemplate && TRIAD_CORE_INTERVALS.has(interval) && [3, 4, 6, 7, 8].includes(interval)) {
        chordFunction = 'CHORD_TONE';
      } else if (inTemplate) chordFunction = 'EXTENSION';
    }

    const isBassRegister = note.pitch <= opts.bassCeiling;
    const isClusterBass = clusterBassIds.has(note.id);

    let role;
    let reason;

    if (arpeggio) {
      role = ROLES.ARPEGGIO;
      reason = `part of a ${arpeggio.contour} arpeggio figure`;
    } else if (inTemplate || chordFunction === 'ROOT') {
      if (isClusterBass && isBassRegister && polyphonic) {
        role = ROLES.BASS;
        reason = chordFunction === 'ROOT' ? 'root in the bass' : `${chord.symbol} bass note (inversion)`;
      } else if (chordFunction === 'ROOT') {
        role = ROLES.ROOT;
        reason = 'chord root';
      } else if (chordFunction === 'EXTENSION' && isMelody && isDetachedTopVoice(note)) {
        // The degree only exists because of this one exposed note: that makes it
        // a melody over the chord, not a colour inside it (section 16).
        role = ROLES.MELODY;
        reason = `melody note (${intervalName(interval)}) above the harmony`;
      } else if (chordFunction === 'EXTENSION') {
        role = ROLES.EXTENSION;
        reason = `extension (${intervalName(interval)})`;
      } else if (isMelody && !polyphonic) {
        role = ROLES.MELODY;
        reason = 'exposed top voice on a chord tone';
      } else {
        role = ROLES.CHORD_TONE;
        reason = `chord tone (${intervalName(interval)})`;
      }
    } else {
      // Non-chord tone: decide what kind (section 16).
      const before = prev.get(note.id) || null;
      const after = next.get(note.id) || null;
      const stepIn = before ? Math.abs(note.pitch - before.pitch) : null;
      const stepOut = after ? Math.abs(after.pitch - note.pitch) : null;
      const shortish = note.duration <= opts.passingMaxBeats;

      const nextIsChordTone = after && chord && chord.intervals
        ? chord.intervals.some((i) => ((i % 12) + 12) % 12 === chordIntervalOf(after.pitch, chord))
        : false;

      if (note.duration <= opts.ornamentMaxBeats && (stepIn === null || stepIn <= opts.stepMax + 1)) {
        role = ROLES.ORNAMENT;
        reason = 'very short decorative note';
      } else if (shortish && stepIn !== null && stepOut !== null
        && stepIn <= opts.stepMax && stepOut <= opts.stepMax) {
        const dirIn = Math.sign(note.pitch - before.pitch);
        const dirOut = Math.sign(after.pitch - note.pitch);
        if (dirIn !== 0 && dirIn === dirOut) {
          role = ROLES.PASSING_TONE;
          reason = 'stepwise, same direction in and out';
        } else {
          role = ROLES.APPROACH_TONE;
          reason = 'neighbour tone: steps away and returns';
        }
      } else if (shortish && stepOut !== null && stepOut <= opts.stepMax && nextIsChordTone) {
        role = ROLES.APPROACH_TONE;
        reason = 'steps into the next chord tone';
      } else if (isMelody) {
        role = ROLES.MELODY;
        reason = 'sustained non-chord tone in the top voice';
      } else if (chord) {
        // It sits inside the harmony's duration but is not in the template and
        // is not decorative: treat it as a colour tone rather than discard it.
        role = ROLES.EXTENSION;
        reason = `added colour (${intervalName(interval)})`;
        chordFunction = 'ADDED';
      } else {
        role = ROLES.UNKNOWN;
        reason = 'no harmony in force';
      }
    }

    result.set(note.id, {
      noteId: note.id,
      role,
      chordFunction,
      interval,
      priority: ROLE_PRIORITY[role] ?? 6,
      isMelody,
      isArpeggio: !!arpeggio,
      arpeggio,
      chordSymbol: chord ? chord.symbol : null,
      reason,
    });
  }

  return result;
}

const INTERVAL_NAMES = {
  0: 'root', 1: 'b9', 2: '9', 3: 'b3', 4: '3', 5: '11', 6: 'b5',
  7: '5', 8: '#5', 9: '13', 10: 'b7', 11: '7',
};

export function intervalName(interval) {
  if (interval === null || interval === undefined) return 'n/a';
  return INTERVAL_NAMES[((interval % 12) + 12) % 12] ?? String(interval);
}
