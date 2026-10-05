/**
 * Sequential and global harmonic resolution (brief section 14).
 *
 * Local chord recognition answers "what chord can these notes represent?".
 * That is only level 1. This module adds:
 *
 *   Level 2 (sequential) -- what progression best explains the whole sequence?
 *   Level 3 (global)     -- what reading best fits the key of the entire piece?
 *
 * It is a Viterbi decode over the per-event candidate lists. Each candidate has
 * a local score (its confidence) and each transition has a cost built from
 * functional harmony: root motion by fifths is cheap, diatonic chords are
 * cheap, repeating the previous chord is cheap, random chromatic lurches are
 * expensive. The brief's own example -- G B D F reading as G7 because the
 * surrounding music is in C -- comes out of exactly this.
 */

import { diatonicChords } from './keyDetector.js';

export const DEFAULT_CONTEXT_OPTIONS = {
  /** How much the progression model may override local evidence. 0 = never. */
  contextWeight: 0.45,
  /** Reward for staying on the same chord across adjacent events. */
  repetitionBonus: 0.12,
  /** Reward for a root motion that is a strong functional move. */
  functionalBonus: 0.16,
  /** Reward for being one of the key's diatonic chords. */
  diatonicBonus: 0.18,
  /** Reward for a V -> I style resolution. */
  cadenceBonus: 0.14,
};

/** Interval class of root motion, used to grade progressions. */
function rootMotionQuality(fromRoot, toRoot) {
  const interval = ((toRoot - fromRoot) % 12 + 12) % 12;
  switch (interval) {
    case 0: return 1.0; // same root
    case 5: return 0.95; // up a fourth  (V -> I)
    case 7: return 0.9; // up a fifth   (I -> V)
    case 9: return 0.75; // up a sixth  (I -> vi)
    case 2: return 0.7; // up a second  (IV -> V)
    case 3: return 0.7; // up a minor third
    case 10: return 0.65; // down a second
    case 4: return 0.6;
    case 8: return 0.55;
    case 1: return 0.35; // chromatic
    case 11: return 0.4;
    case 6: return 0.3; // tritone
    default: return 0.5;
  }
}

/** Is this candidate one of the key's diatonic triads (allowing 7ths)? */
function diatonicFit(candidate, diatonic) {
  const match = diatonic.find((d) => d.root === candidate.root);
  if (!match) return 0;
  const id = candidate.templateId || '';
  const family = id.startsWith('m') && id !== 'maj7' && id !== 'maj9' ? 'min'
    : id.startsWith('dim') ? 'dim'
      : id === '7' || id === '9' || id === '13' || id === '11' ? 'dom'
        : 'maj';

  if (match.quality === 'maj' && (family === 'maj' || family === 'dom')) return 1;
  if (match.quality === 'min' && family === 'min') return 1;
  if (match.quality === 'dim' && family === 'dim') return 1;
  // Right root, unexpected quality: still better than a chord outside the key.
  return 0.45;
}

/**
 * Dominant-function detection: a dominant 7th (or triad) whose root is a fifth
 * above the next chord's root is a textbook resolution.
 */
function isResolution(from, to) {
  const interval = ((to.root - from.root) % 12 + 12) % 12;
  if (interval !== 5) return false;
  const id = from.templateId || '';
  return id === '7' || id === '9' || id === '13' || id === 'maj' || id === '7b9' || id === '7sus4';
}

/**
 * Resolve a sequence of candidate lists into a single best progression.
 *
 * @param {Array<{candidates:Array, durationBeats?:number}>} events
 *        each event carries its ranked local candidates
 * @param {object} key result of detectKey()
 * @param {object} [options] see DEFAULT_CONTEXT_OPTIONS
 * @returns {Array<{chosen:object, candidates:Array, contextScore:number}>}
 */
export function resolveProgression(events, key, options = {}) {
  const opts = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
  if (!events || events.length === 0) return [];

  const diatonic = key ? diatonicChords(key.tonic, key.mode) : [];
  const keyConfidence = key ? key.confidence : 0;
  // A weakly detected key should not be allowed to rewrite the music.
  const globalWeight = opts.contextWeight * (0.4 + 0.6 * keyConfidence);

  const emission = (candidate, event) => {
    let score = candidate.confidence;
    if (diatonic.length) score += diatonicFit(candidate, diatonic) * opts.diatonicBonus * globalWeight;
    // Longer events deserve more trust in their own local reading.
    const weight = Math.min(2, Math.max(0.35, event.durationBeats ?? 1));
    return score * (0.75 + 0.25 * weight);
  };

  const transition = (prev, next) => {
    let score = rootMotionQuality(prev.root, next.root) * opts.functionalBonus;
    if (prev.root === next.root && prev.templateId === next.templateId) score += opts.repetitionBonus;
    if (isResolution(prev, next)) score += opts.cadenceBonus;
    return score * globalWeight;
  };

  // Forward pass.
  const trellis = events.map((event) => {
    const cands = event.candidates && event.candidates.length ? event.candidates : [];
    return cands.map((c) => ({ candidate: c, total: -Infinity, back: null }));
  });

  for (let i = 0; i < trellis.length; i += 1) {
    const column = trellis[i];
    for (const cell of column) {
      const local = emission(cell.candidate, events[i]);
      if (i === 0) {
        cell.total = local;
        continue;
      }
      let bestTotal = -Infinity;
      let bestBack = null;
      for (const prevCell of trellis[i - 1]) {
        if (prevCell.total === -Infinity) continue;
        const t = prevCell.total + transition(prevCell.candidate, cell.candidate);
        if (t > bestTotal) { bestTotal = t; bestBack = prevCell; }
      }
      cell.total = (bestTotal === -Infinity ? 0 : bestTotal) + local;
      cell.back = bestBack;
    }
  }

  // Backtrace.
  const path = new Array(trellis.length).fill(null);
  let cursor = null;
  for (let i = trellis.length - 1; i >= 0; i -= 1) {
    const column = trellis[i];
    if (column.length === 0) continue;
    if (cursor === null) {
      cursor = column.reduce((a, b) => (b.total > a.total ? b : a), column[0]);
    }
    path[i] = cursor;
    cursor = cursor.back;
    if (cursor === null && i > 0) {
      // Gap (an event with no candidates): restart the trace.
      const prev = trellis[i - 1];
      cursor = prev.length ? prev.reduce((a, b) => (b.total > a.total ? b : a), prev[0]) : null;
    }
  }

  return events.map((event, i) => {
    const cell = path[i];
    if (!cell) {
      return { chosen: null, candidates: event.candidates || [], contextScore: 0, contextChanged: false };
    }
    const localBest = (event.candidates || [])[0] || null;
    const changed = !!localBest && (localBest.templateId !== cell.candidate.templateId
      || localBest.root !== cell.candidate.root);

    // Re-rank so the context-chosen reading leads the alternatives list.
    const reordered = [cell.candidate, ...(event.candidates || []).filter((c) => c !== cell.candidate)];

    return {
      chosen: cell.candidate,
      candidates: reordered,
      contextScore: cell.total,
      contextChanged: changed,
      localBest,
    };
  });
}

/**
 * Roman-numeral label for a chord within a key, for the analysis read-out.
 */
export function romanNumeral(candidate, key) {
  if (!candidate || !key) return null;
  const diatonic = diatonicChords(key.tonic, key.mode);
  const match = diatonic.find((d) => d.root === candidate.root);
  const id = candidate.templateId || '';
  const seventh = id.includes('7') ? '7' : '';
  if (!match) {
    const semis = ((candidate.root - key.tonic) % 12 + 12) % 12;
    return `[${semis}]${seventh}`;
  }
  const isMinorish = id.startsWith('m') && !id.startsWith('maj');
  let roman = match.roman;
  if (isMinorish) roman = roman.toLowerCase();
  else if (id === 'maj' || id === '7' || id === 'maj7' || id === '6' || id === 'add9') roman = roman.toUpperCase();
  if (match.quality === 'dim' || id.startsWith('dim')) roman = `${roman.toLowerCase()}°`;
  return roman + seventh;
}

/**
 * Chord-change detection: merge adjacent events that express the same harmony.
 * The brief wants harmonic events, not one event per onset -- a repeated
 * eighth-note C major figure is one harmony, eight attacks (section 29 keeps
 * the attacks; this only merges the *harmonic* reading).
 */
export function mergeRepeatedHarmony(resolved, events, { maxGapBeats = 0.01 } = {}) {
  const regions = [];
  for (let i = 0; i < resolved.length; i += 1) {
    const chosen = resolved[i].chosen;
    const event = events[i];
    const prev = regions[regions.length - 1];
    const sameChord = prev && prev.chord && chosen
      && prev.chord.root === chosen.root
      && prev.chord.templateId === chosen.templateId
      && prev.chord.bass === chosen.bass;
    const contiguous = prev && event.start - prev.end <= maxGapBeats + 1e-9;

    if (sameChord && contiguous) {
      prev.end = Math.max(prev.end, event.end);
      prev.eventIndices.push(i);
    } else {
      regions.push({
        chord: chosen,
        start: event.start,
        end: event.end,
        eventIndices: [i],
      });
    }
  }
  return regions;
}
