/**
 * Sequence-level voicing optimization (brief sections 24-25).
 *
 * Section 24 is the key insight: the engine must not pick the best C, the best
 * F and the best G independently. It has to pick the best *sequence*. So this
 * is a Viterbi decode over the per-event candidate lists, where the emission is
 * the voicing's own score and the transition is voice-leading plus positional
 * movement.
 *
 * That is what turns three locally-optimal shapes scattered up the neck into
 * one playable phrase.
 */

import { scoreVoicing, transitionCost, positionWindowScore } from './voicingScorer.js';
import { analyzeFingering } from './fingering.js';

export const DEFAULT_OPTIMIZER_OPTIONS = {
  /** How much the sequence may override per-chord preference. */
  transitionWeight: 0.55,
  /** Candidates kept per event before the decode (beam width). */
  beamWidth: 14,
  positionWindow: null,
};

/**
 * @param {Array} events chord events with `candidates` (raw voicings)
 * @param {Fretboard} fretboard
 * @param {object} [options]
 * @returns {Array<{voicing:object, alternatives:Array, score:number}>}
 */
export function optimizeVoicingSequence(events, fretboard, options = {}) {
  const opts = { ...DEFAULT_OPTIMIZER_OPTIONS, ...options };
  if (!events || events.length === 0) return [];

  // Pre-score every candidate and keep the best few per event.
  const columns = events.map((event) => {
    const scored = (event.candidates || []).map((voicing) => {
      const fingering = analyzeFingering(voicing, fretboard, opts.fingering);
      const withFingering = { ...voicing, fingering };
      const { score, parts } = scoreVoicing(withFingering, event, fretboard, opts);
      const windowScore = positionWindowScore(withFingering, opts.positionWindow);
      const local = score * (0.68 + 0.32 * windowScore);
      return { voicing: withFingering, local, parts, windowScore };
    });

    scored.sort((a, b) => b.local - a.local);

    // Keep a diverse beam: do not fill it with twelve variations of one shape.
    const beam = [];
    const seenPositions = new Map();
    for (const cand of scored) {
      const pos = cand.voicing.position ?? 0;
      const count = seenPositions.get(pos) ?? 0;
      if (count >= 4 && beam.length >= 6) continue;
      seenPositions.set(pos, count + 1);
      beam.push(cand);
      if (beam.length >= opts.beamWidth) break;
    }
    return beam.length > 0 ? beam : scored.slice(0, opts.beamWidth);
  });

  // Forward pass.
  const trellis = columns.map((column) => column.map((cell) => ({
    ...cell, total: -Infinity, back: null,
  })));

  for (let i = 0; i < trellis.length; i += 1) {
    for (const cell of trellis[i]) {
      if (i === 0) {
        cell.total = cell.local;
        continue;
      }
      let best = -Infinity;
      let bestBack = null;
      for (const prev of trellis[i - 1]) {
        if (prev.total === -Infinity) continue;
        const cost = transitionCost(prev.voicing, cell.voicing, opts);
        const value = prev.total - cost * opts.transitionWeight;
        if (value > best) { best = value; bestBack = prev; }
      }
      cell.total = (best === -Infinity ? 0 : best) + cell.local;
      cell.back = bestBack;
    }
  }

  // Backtrace.
  const path = new Array(trellis.length).fill(null);
  let cursor = null;
  for (let i = trellis.length - 1; i >= 0; i -= 1) {
    const column = trellis[i];
    if (column.length === 0) { cursor = null; continue; }
    if (cursor === null) cursor = column.reduce((a, b) => (b.total > a.total ? b : a), column[0]);
    path[i] = cursor;
    cursor = cursor.back;
  }

  return events.map((event, i) => {
    const cell = path[i];
    if (!cell) return { voicing: null, alternatives: [], score: 0, parts: null };

    // Alternatives for the UI (section 34): the rest of the beam, best first,
    // excluding the chosen shape.
    const alternatives = columns[i]
      .filter((c) => c.voicing !== cell.voicing)
      .slice(0, 8)
      .map((c) => ({ voicing: c.voicing, score: c.local, parts: c.parts }));

    return {
      voicing: cell.voicing,
      alternatives,
      score: cell.local,
      parts: cell.parts,
      sequenceScore: cell.total,
    };
  });
}

/**
 * Total hand movement across a decoded sequence, reported to the user as a
 * playability read-out.
 */
export function measureSequenceMovement(results) {
  let totalMovement = 0;
  let jumps = 0;
  let previous = null;
  for (const result of results) {
    const v = result.voicing;
    if (!v) continue;
    if (previous && v.fretSpan > 0 && previous.fretSpan > 0) {
      const movement = Math.abs((v.position ?? 0) - (previous.position ?? 0));
      totalMovement += movement;
      if (movement >= 4) jumps += 1;
    }
    if (v.fretSpan > 0) previous = v;
  }
  return { totalMovement, jumps };
}
