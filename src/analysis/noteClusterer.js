/**
 * Temporal note clustering (brief sections 6-9).
 *
 * The whole point of this module is the thing section 40 calls the most
 * important design principle: notes that happen near each other in time are NOT
 * automatically a chord. A human pianist's C major arrives as four separate
 * onsets spread over 60 ms; an arpeggio also arrives as four separate onsets.
 * Timestamp equality cannot tell those apart, so we score several independent
 * signals and let them argue.
 *
 *   score = temporal * 0.35 + overlap * 0.20 + velocity * 0.05
 *         + harmonic * 0.25 + onsetPattern * 0.15
 *
 * Weights are configurable (section 7) because the right answer differs between
 * a quantized DAW export and a live performance capture.
 */

import { harmonicCompatibility } from './chordRecognizer.js';

export const DEFAULT_CLUSTER_WEIGHTS = {
  temporal: 0.35,
  overlap: 0.20,
  velocity: 0.05,
  harmonic: 0.25,
  onsetPattern: 0.15,
};

export const DEFAULT_CLUSTER_OPTIONS = {
  /** Soft threshold for the exponential temporal curve, in milliseconds. */
  groupWindowMs: 45,
  /** Hard cut-off: beyond this, nothing joins a cluster regardless of score. */
  maxWindowMs: 140,
  /** Minimum mean grouping score for a note to join a cluster. */
  threshold: 0.52,
  /** Grid used by the onset-pattern signal, in beats (1/4 = 16th notes). */
  onsetGrid: 0.25,
  weights: DEFAULT_CLUSTER_WEIGHTS,
};

/**
 * Section 8: exponential, not linear. 5 ms vs 15 ms should matter; 200 ms
 * should be indistinguishable from unrelated.
 */
export function temporalScore(deltaMs, windowMs) {
  return Math.exp(-Math.abs(deltaMs) / Math.max(1, windowMs));
}

/**
 * Section 9: intersection over union of the two notes' sounding spans.
 * Block chords overlap almost completely; arpeggios barely overlap at all.
 */
export function overlapScore(a, b) {
  const aStart = a.startSec;
  const aEnd = a.startSec + a.durationSec;
  const bStart = b.startSec;
  const bEnd = b.startSec + b.durationSec;
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  if (union <= 0) return 1;
  return intersection / union;
}

export function velocityScore(a, b) {
  return 1 - Math.min(1, Math.abs((a.velocity ?? 80) - (b.velocity ?? 80)) / 64);
}

/**
 * Do the two notes land on the same metric subdivision? Two notes both inside
 * the beat-1 grid cell belong together; one on beat 1 and one on the following
 * 16th are a rhythmic figure, not a chord.
 */
export function onsetPatternScore(a, b, grid) {
  if (grid <= 0) return 1;
  const cellA = Math.round(a.start / grid);
  const cellB = Math.round(b.start / grid);
  if (cellA === cellB) return 1;
  const distance = Math.abs(cellA - cellB);
  return Math.max(0, 1 - distance * 0.6);
}

/**
 * Pairwise grouping score (section 7).
 * @returns {{score:number, parts:object}}
 */
export function groupingScore(a, b, options = {}) {
  const opts = { ...DEFAULT_CLUSTER_OPTIONS, ...options };
  const weights = { ...DEFAULT_CLUSTER_WEIGHTS, ...(options.weights || {}) };

  const deltaMs = Math.abs(a.startSec - b.startSec) * 1000;
  const parts = {
    temporal: temporalScore(deltaMs, opts.groupWindowMs),
    overlap: overlapScore(a, b),
    velocity: velocityScore(a, b),
    harmonic: harmonicCompatibility([a.pitch, b.pitch]),
    onsetPattern: onsetPatternScore(a, b, opts.onsetGrid),
  };

  let score = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (parts[key] ?? 0) * weight;
    totalWeight += weight;
  }
  return { score: totalWeight > 0 ? score / totalWeight : 0, parts, deltaMs };
}

/**
 * Estimate how mechanically timed a performance is.
 *
 * A DAW export has every chord note on the exact same tick, so a tight 45 ms
 * window is right. A live take needs a wider one. Section 6 says the window
 * should depend on "timing resolution and performance characteristics", so we
 * measure them instead of guessing.
 *
 * @returns {{humanized:boolean, suggestedWindowMs:number, medianOnsetSpreadMs:number}}
 */
export function analyzeTimingCharacter(notes, options = {}) {
  const { probeWindowMs = 160 } = options;
  if (notes.length < 2) {
    return { humanized: false, suggestedWindowMs: 35, medianOnsetSpreadMs: 0, exactSimultaneityRatio: 1 };
  }

  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  const spreads = [];
  let exactPairs = 0;
  let nearPairs = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const deltaMs = (sorted[j].startSec - sorted[i].startSec) * 1000;
      if (deltaMs > probeWindowMs) break;
      nearPairs += 1;
      if (deltaMs < 1.5) exactPairs += 1;
      else spreads.push(deltaMs);
    }
  }

  const exactSimultaneityRatio = nearPairs > 0 ? exactPairs / nearPairs : 1;
  spreads.sort((a, b) => a - b);
  const medianOnsetSpreadMs = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;

  // Mostly-exact onsets => machine timing => keep the window tight.
  const humanized = exactSimultaneityRatio < 0.6 && spreads.length > 4;
  const suggestedWindowMs = humanized
    ? Math.max(25, Math.min(90, medianOnsetSpreadMs * 1.8))
    : 30;

  return { humanized, suggestedWindowMs, medianOnsetSpreadMs, exactSimultaneityRatio };
}

/**
 * Cluster notes into simultaneity groups.
 *
 * Greedy agglomerative over time: seed a cluster with the earliest unassigned
 * note, then test each following note inside the hard window against the whole
 * cluster (mean pairwise score), not just against the seed. Testing against the
 * cluster is what keeps a slow roll from chaining indefinitely -- each new note
 * has to agree with everything already in the group.
 *
 * @param {Array} notes normalized notes
 * @param {object} [options] see DEFAULT_CLUSTER_OPTIONS
 * @returns {Array<{index:number, notes:Array, start:number, end:number, ...}>}
 */
export function clusterNotes(notes, options = {}) {
  const opts = { ...DEFAULT_CLUSTER_OPTIONS, ...options };
  opts.weights = { ...DEFAULT_CLUSTER_WEIGHTS, ...(options.weights || {}) };

  if (!notes || notes.length === 0) return [];

  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  const assigned = new Set();
  const clusters = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const seed = sorted[i];
    if (assigned.has(seed.id)) continue;

    const members = [seed];
    const scores = [];
    assigned.add(seed.id);

    for (let j = i + 1; j < sorted.length; j += 1) {
      const candidate = sorted[j];
      if (assigned.has(candidate.id)) continue;

      const deltaFromSeedMs = (candidate.startSec - seed.startSec) * 1000;
      if (deltaFromSeedMs > opts.maxWindowMs) break; // sorted by time: nothing later qualifies

      // Same pitch twice is a repeated note, never a chord member.
      if (members.some((m) => m.pitch === candidate.pitch)) continue;

      let sum = 0;
      let worst = 1;
      const detail = [];
      for (const member of members) {
        const { score, parts } = groupingScore(member, candidate, opts);
        sum += score;
        worst = Math.min(worst, score);
        detail.push({ a: member.id, b: candidate.id, score, parts });
      }
      const mean = sum / members.length;

      // Mean carries the decision, but a single strongly incompatible pair can
      // veto: that is what stops a chord and the melody note after it merging.
      if (mean >= opts.threshold && worst >= opts.threshold * 0.62) {
        members.push(candidate);
        assigned.add(candidate.id);
        scores.push(...detail);
      }
    }

    members.sort((a, b) => a.pitch - b.pitch);

    const start = Math.min(...members.map((m) => m.start));
    const end = Math.max(...members.map((m) => m.end));
    const startSec = Math.min(...members.map((m) => m.startSec));
    const spreadMs = (Math.max(...members.map((m) => m.startSec)) - startSec) * 1000;
    const cohesion = scores.length
      ? scores.reduce((acc, s) => acc + s.score, 0) / scores.length
      : (members.length === 1 ? 1 : 0);

    clusters.push({
      index: clusters.length,
      notes: members,
      noteIds: members.map((m) => m.id),
      start,
      end,
      duration: end - start,
      startSec,
      spreadMs,
      cohesion,
      pairScores: scores,
      pitches: members.map((m) => m.pitch),
      bass: members[0].pitch,
      top: members[members.length - 1].pitch,
      isSimultaneity: members.length > 1,
    });
  }

  clusters.sort((a, b) => a.start - b.start || a.bass - b.bass);
  clusters.forEach((c, i) => { c.index = i; });
  return clusters;
}

/**
 * Convenience wrapper: measure the performance, then cluster with a window
 * matched to it. This is what the pipeline uses by default.
 */
export function clusterNotesAdaptive(notes, options = {}) {
  const character = analyzeTimingCharacter(notes);
  const groupWindowMs = options.groupWindowMs ?? character.suggestedWindowMs;
  const maxWindowMs = options.maxWindowMs ?? Math.max(90, groupWindowMs * 3.2);
  const clusters = clusterNotes(notes, { ...options, groupWindowMs, maxWindowMs });
  return { clusters, character, groupWindowMs, maxWindowMs };
}
