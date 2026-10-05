/**
 * Voicing scoring (brief section 23).
 *
 *   score = pitchAccuracy + voiceLeading + playability
 *         + positionContinuity + voicingSimilarity
 *
 * voiceLeading and positionContinuity are sequence properties, so they are
 * applied by positionOptimizer.js as transition costs. This module provides the
 * per-voicing terms and the pairwise functions the optimizer calls, so all the
 * weights live in one place.
 */

import { analyzeFingering, transitionDifficulty } from './fingering.js';

export const DEFAULT_SCORE_WEIGHTS = {
  pitchAccuracy: 0.28,
  coverage: 0.22,
  playability: 0.20,
  voicingSimilarity: 0.13,
  positionComfort: 0.09,
  openStrings: 0.03,
  economy: 0.05,
};

export const DEFAULT_TRANSITION_WEIGHTS = {
  voiceLeading: 0.55,
  positionContinuity: 0.35,
  shapeContinuity: 0.10,
};

/**
 * How faithfully does this shape reproduce the pitches the pianist played?
 *
 * Exact pitch is best, same pitch class in another octave is good (the guitar's
 * range forces this constantly), and a pitch class that was not in the original
 * at all is a miss. Weighted by each note's role priority so bass and chord
 * quality count for more than a doubled fifth (section 26).
 */
export function pitchAccuracyScore(voicing, event) {
  const notes = event.notes || [];
  if (notes.length === 0) return 1;

  const generated = new Set(voicing.pitches);
  const generatedPcs = new Set(voicing.pitches.map((p) => ((p % 12) + 12) % 12));

  let earned = 0;
  let possible = 0;

  for (const note of notes) {
    const priority = note.priority ?? 4;
    const weight = 1 / priority;
    possible += weight;
    const pc = ((note.pitch % 12) + 12) % 12;
    if (generated.has(note.pitch)) earned += weight;
    else if (generatedPcs.has(pc)) {
      // Octave displacement: how far off is the nearest instance?
      let nearest = Infinity;
      for (const g of voicing.pitches) {
        if (((g % 12) + 12) % 12 !== pc) continue;
        nearest = Math.min(nearest, Math.abs(g - note.pitch));
      }
      const octaves = nearest / 12;
      earned += weight * Math.max(0.45, 1 - octaves * 0.22);
    }
  }

  return possible > 0 ? earned / possible : 1;
}

/**
 * Structural similarity to the original voicing (section 23's
 * "original voicing similarity", section 30's Preserve Piano Voicing).
 *
 * Judges shape rather than literal pitch: is the bass still the bottom, is the
 * melody still on top, is the spacing comparable, are there a similar number of
 * voices?
 */
export function voicingSimilarityScore(voicing, event) {
  const notes = event.notes || [];
  if (notes.length === 0) return 1;

  const original = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const generated = [...voicing.pitches].sort((a, b) => a - b);

  // Bass alignment: same pitch class at the bottom, in a comparable register.
  const origBass = original[0];
  const genBass = generated[0];
  const bassPcMatch = ((origBass % 12) + 12) % 12 === ((genBass % 12) + 12) % 12 ? 1 : 0;
  const bassRegister = Math.max(0, 1 - Math.abs(origBass - genBass) / 24);
  const bassScore = bassPcMatch * 0.6 + bassRegister * 0.4;

  // Top-voice alignment: the melody should stay the melody.
  const origTop = original[original.length - 1];
  const genTop = generated[generated.length - 1];
  const topPcMatch = ((origTop % 12) + 12) % 12 === ((genTop % 12) + 12) % 12 ? 1 : 0;
  const topRegister = Math.max(0, 1 - Math.abs(origTop - genTop) / 24);
  const topScore = topPcMatch * 0.5 + topRegister * 0.5;

  // Spread: a close piano cluster should not become a wide guitar sprawl.
  const origSpread = origTop - origBass;
  const genSpread = genTop - genBass;
  const spreadScore = Math.max(0, 1 - Math.abs(origSpread - genSpread) / 24);

  // Voice count: a 4-note chord should not become a 2-note stub.
  const voiceScore = Math.max(0, 1 - Math.abs(original.length - generated.length) / 4);

  return bassScore * 0.34 + topScore * 0.28 + spreadScore * 0.2 + voiceScore * 0.18;
}

/**
 * Score one voicing in isolation.
 *
 * @returns {{score:number, parts:object, fingering:object}}
 */
export function scoreVoicing(voicing, event, fretboard, options = {}) {
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...(options.weights || {}) };
  const fingering = voicing.fingering || analyzeFingering(voicing, fretboard, options.fingering);

  const pitchAccuracy = pitchAccuracyScore(voicing, event);
  const coverage = voicing.coverage ?? 1;
  const playability = Math.max(0, 1 - fingering.difficulty / 2.5);
  const voicingSimilarity = voicingSimilarityScore(voicing, event);

  const stringCount = fretboard.stringCount;
  const openStrings = Math.min(1, (voicing.openStrings ?? 0) / Math.max(1, stringCount - 2));

  // Low positions are where transcriptions live unless the music forces them
  // higher. Section 30's Guitar Position control overrides this explicitly; the
  // point here is only that fret 14 should never win a coin toss against fret 1.
  const positionComfort = 1 - Math.min(1, (voicing.position ?? 0) / 15) * 0.7;

  // Economy: say the whole chord without padding it out. A guitarist voicing a
  // four-note piano chord wants four or five strings, so thinness is the real
  // fault here -- doubled octaves are only mildly wasteful (section 26 ranks
  // duplicated chord tones last, not forbidden).
  const distinctTargets = voicing.targets?.targets?.length ?? 3;
  const originalVoices = (event.notes || []).length || distinctTargets;
  const wantedVoices = Math.max(2, Math.min(stringCount, Math.max(distinctTargets, originalVoices)));
  const used = voicing.stringsUsed ?? 0;
  const thin = Math.max(0, wantedVoices - used) / stringCount;
  const padded = Math.max(0, used - wantedVoices - 2) / stringCount;
  const economy = Math.max(0, 1 - thin * 1.3 - padded * 0.5);

  const preserveBoost = options.preservePianoVoicing ? 1.9 : 1;

  const parts = {
    pitchAccuracy,
    coverage,
    playability,
    voicingSimilarity: voicingSimilarity * preserveBoost,
    positionComfort,
    openStrings,
    economy,
  };

  let score = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const w = key === 'voicingSimilarity' ? weight * preserveBoost : weight;
    score += (parts[key] ?? 0) * w;
    total += w;
  }
  score = total > 0 ? score / total : 0;

  if (!fingering.playable) score *= 0.25;

  // A melody note that lands on a string a chord is still holding cannot
  // actually ring. It is a preference, not a prohibition: re-striking a string
  // is often what a player does anyway.
  if (voicing.stringCollision) score *= 0.85;

  return { score, parts, fingering };
}

/**
 * Voice-leading distance between two voicings (section 24).
 *
 * Two complementary measures:
 *   - per-string fret motion, which is what the hand feels
 *   - nearest-voice pitch motion, which is what the ear hears
 */
export function voiceLeadingDistance(from, to) {
  if (!from || !to) return 0;

  let stringMotion = 0;
  let stringsCompared = 0;
  for (let s = 0; s < from.frets.length; s += 1) {
    const a = from.frets[s];
    const b = to.frets[s];
    if (a === null || b === null) continue;
    stringMotion += Math.abs(a - b);
    stringsCompared += 1;
  }
  const meanStringMotion = stringsCompared > 0 ? stringMotion / stringsCompared : 4;

  let pitchMotion = 0;
  for (const pitch of to.pitches) {
    let best = Infinity;
    for (const prev of from.pitches) best = Math.min(best, Math.abs(pitch - prev));
    pitchMotion += Math.min(best, 12);
  }
  const meanPitchMotion = to.pitches.length > 0 ? pitchMotion / to.pitches.length : 6;

  return meanStringMotion * 0.5 + meanPitchMotion * 0.5;
}

/**
 * Transition cost in [0,1] (lower is better), combining voice leading,
 * position continuity (section 25) and shape continuity.
 */
export function transitionCost(from, to, options = {}) {
  const weights = { ...DEFAULT_TRANSITION_WEIGHTS, ...(options.transitionWeights || {}) };
  if (!from || !to) return 0;

  const vl = Math.min(1, voiceLeadingDistance(from, to) / 7);

  // Section 25: penalize large positional jumps.
  const movement = Math.abs((from.position ?? 0) - (to.position ?? 0));
  const positionPenalty = Math.min(1, movement / 9);

  const shape = Math.min(1, transitionDifficulty(from, to) / 1.2);

  let total = 0;
  let sum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = key === 'voiceLeading' ? vl : key === 'positionContinuity' ? positionPenalty : shape;
    total += value * weight;
    sum += weight;
  }
  return sum > 0 ? total / sum : 0;
}

/** Preference for a requested neck region (section 30's Guitar Position). */
export function positionWindowScore(voicing, window) {
  if (!window || window.maxFret === null || window.maxFret === undefined) return 1;
  const pos = voicing.position ?? 0;
  const { minFret = 0, maxFret } = window;
  if (voicing.fretSpan === 0) return 1; // all open: always in position
  if (pos >= minFret && (voicing.maxFret ?? pos) <= maxFret) return 1;
  const overshoot = Math.max(minFret - pos, (voicing.maxFret ?? pos) - maxFret, 0);
  return Math.max(0, 1 - overshoot / 6);
}
