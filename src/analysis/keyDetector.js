/**
 * Key detection (brief section 15).
 *
 * Krumhansl-Schmuckler correlation over a duration-weighted pitch-class
 * histogram, with two corrections that matter for real keyboard MIDI:
 *
 *  - bass emphasis: the lowest voice carries disproportionate tonal weight, so
 *    bass pitch classes get their own histogram and a separate correlation.
 *  - cadence/edge bias: the first and last sounding harmonies are strong tonic
 *    evidence, far out of proportion to their duration.
 *
 * Output is a ranked list with confidence, plus a per-pitch-class `profile` the
 * chord recognizer uses as tonal context.
 */

import { pcName } from './chordRecognizer.js';

// Krumhansl-Kessler probe-tone profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function correlate(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) { mx += x[i]; my += y[i]; }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/** Transpose a probe-tone profile so that `tonic` becomes its first degree. */
function rotate(profile, tonic) {
  const out = new Array(12);
  for (let pc = 0; pc < 12; pc += 1) out[pc] = profile[((pc - tonic) % 12 + 12) % 12];
  return out;
}

/** Duration-weighted pitch-class histogram. */
export function pitchClassHistogram(notes, { bassOnly = false, bassThreshold = null } = {}) {
  const hist = new Array(12).fill(0);
  for (const note of notes) {
    if (bassOnly && bassThreshold !== null && note.pitch > bassThreshold) continue;
    const weight = Math.max(note.duration ?? 0.25, 0.02) * (0.6 + 0.4 * ((note.velocity ?? 80) / 127));
    hist[((note.pitch % 12) + 12) % 12] += weight;
  }
  return hist;
}

/**
 * @param {Array} notes normalized notes
 * @param {object} [options]
 * @param {Array} [options.clusters] clusters, used for cadence weighting
 * @returns {{tonic:number, mode:string, name:string, confidence:number,
 *            profile:Float64Array, candidates:Array, sharpsFlats:number, preferFlats:boolean}}
 */
export function detectKey(notes, options = {}) {
  const { clusters = null } = options;

  if (!notes || notes.length === 0) {
    return {
      tonic: 0, mode: 'major', name: 'C major', confidence: 0,
      profile: uniformProfile(), candidates: [], sharpsFlats: 0, preferFlats: false,
    };
  }

  const hist = pitchClassHistogram(notes);
  const pitches = notes.map((n) => n.pitch);
  const median = pitches.slice().sort((a, b) => a - b)[Math.floor(pitches.length / 2)];
  const bassHist = pitchClassHistogram(notes, { bassOnly: true, bassThreshold: median });

  // Cadence evidence: first and last harmonies.
  const edgeHist = new Array(12).fill(0);
  if (clusters && clusters.length > 0) {
    const first = clusters[0];
    const last = clusters[clusters.length - 1];
    for (const c of [first, last]) {
      const weight = c === last ? 3 : 1.6; // the final harmony is the stronger cue
      edgeHist[((c.bass % 12) + 12) % 12] += weight;
      for (const n of c.notes) edgeHist[((n.pitch % 12) + 12) % 12] += weight * 0.4;
    }
  }

  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const bassTotal = bassHist.reduce((a, b) => a + b, 0) || 1;
  const edgeTotal = edgeHist.reduce((a, b) => a + b, 0) || 1;

  const normHist = hist.map((v) => v / total);
  const normBass = bassHist.map((v) => v / bassTotal);
  const normEdge = edgeHist.map((v) => v / edgeTotal);

  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor']) {
      const base = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const expected = rotate(base, tonic);

      const rMain = correlate(normHist, expected);
      const rBass = correlate(normBass, expected);
      const rEdge = edgeTotal > 1e-9 ? correlate(normEdge, expected) : 0;

      const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
      const scaleSet = new Set(scale.map((i) => (tonic + i) % 12));
      let inScaleMass = 0;
      for (let pc = 0; pc < 12; pc += 1) if (scaleSet.has(pc)) inScaleMass += normHist[pc];

      // Weights: the overall profile correlation leads, the bass line and the
      // opening/closing harmonies inform it, and raw scale membership gets a
      // real say -- an F natural is strong evidence against G major however the
      // phrase happens to end.
      const score = rMain * 0.44 + rBass * 0.15 + rEdge * 0.11 + inScaleMass * 0.30;
      candidates.push({ tonic, mode, score, rMain, rBass, rEdge, inScaleMass });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const runnerUp = candidates.find((c) => c.tonic !== best.tonic || c.mode !== best.mode);
  const margin = runnerUp ? best.score - runnerUp.score : 0.2;

  const confidence = Math.max(0, Math.min(0.99,
    0.5 * Math.max(0, best.score) + 0.5 * Math.min(1, margin * 6)));

  const sharpsFlats = circleOfFifthsPosition(best.tonic, best.mode);

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${pcName(best.tonic, { flats: sharpsFlats < 0 })} ${best.mode}`,
    confidence,
    profile: keyProfile(best.tonic, best.mode),
    sharpsFlats,
    preferFlats: sharpsFlats < 0,
    candidates: candidates.slice(0, 6).map((c) => ({
      ...c,
      name: `${pcName(c.tonic, { flats: circleOfFifthsPosition(c.tonic, c.mode) < 0 })} ${c.mode}`,
    })),
    histogram: normHist,
  };
}

/** Where a key sits on the circle of fifths; negative means flat keys. */
export function circleOfFifthsPosition(tonic, mode) {
  // Major: C=0, G=1, D=2 ... ; relative minor shares its major's signature.
  const majorTonic = mode === 'minor' ? (tonic + 3) % 12 : tonic;
  const table = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  return table[majorTonic] ?? 0;
}

function uniformProfile() {
  const p = new Float64Array(12);
  p.fill(0.5);
  return p;
}

/**
 * Per-pitch-class tonal weight in [0,1], fed to the chord recognizer as
 * `keyProfile`. Scale degrees score high, chromatic notes low, with the tonic
 * triad highest.
 */
export function keyProfile(tonic, mode) {
  const profile = new Float64Array(12);
  const base = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
  let max = 0;
  for (let pc = 0; pc < 12; pc += 1) {
    const v = base[((pc - tonic) % 12 + 12) % 12];
    profile[pc] = v;
    if (v > max) max = v;
  }
  for (let pc = 0; pc < 12; pc += 1) profile[pc] /= max;
  return profile;
}

/** Diatonic scale pitch classes for a key. */
export function scalePitchClasses(tonic, mode) {
  const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  return scale.map((i) => (tonic + i) % 12);
}

/**
 * The seven diatonic triads of a key, used by the progression model to reward
 * functional chords (section 14).
 */
export function diatonicChords(tonic, mode) {
  const qualities = mode === 'major'
    ? ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']
    : ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];
  const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const romanMajor = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii'];
  const romanMinor = ['i', 'ii', 'III', 'iv', 'v', 'VI', 'VII'];
  return scale.map((interval, degree) => ({
    degree,
    roman: (mode === 'major' ? romanMajor : romanMinor)[degree],
    root: (tonic + interval) % 12,
    quality: qualities[degree],
  }));
}

export { MAJOR_PROFILE, MINOR_PROFILE, MAJOR_SCALE, MINOR_SCALE };
