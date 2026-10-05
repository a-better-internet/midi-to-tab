/**
 * Track / channel analysis (brief section 4).
 *
 * Before any harmonic work happens the app has to know what it was handed: a
 * dedicated piano track, a full multi-instrument arrangement, or a keyboard
 * part split across several tracks. This module measures each track and
 * recommends a source selection, which the user can override.
 */

import { gmInstrumentName } from '../midi/normalizer.js';

const DRUM_CHANNEL = 9;

/** GM program ranges that are plausible sources for a keyboard transcription. */
const PROGRAM_FAMILIES = [
  { name: 'piano', from: 0, to: 7, keyboardness: 1.0 },
  { name: 'chromatic percussion', from: 8, to: 15, keyboardness: 0.55 },
  { name: 'organ', from: 16, to: 23, keyboardness: 0.9 },
  { name: 'guitar', from: 24, to: 31, keyboardness: 0.7 },
  { name: 'bass', from: 32, to: 39, keyboardness: 0.3 },
  { name: 'strings', from: 40, to: 47, keyboardness: 0.5 },
  { name: 'ensemble', from: 48, to: 55, keyboardness: 0.6 },
  { name: 'brass', from: 56, to: 63, keyboardness: 0.35 },
  { name: 'reed', from: 64, to: 71, keyboardness: 0.3 },
  { name: 'pipe', from: 72, to: 79, keyboardness: 0.3 },
  { name: 'synth lead', from: 80, to: 87, keyboardness: 0.5 },
  { name: 'synth pad', from: 88, to: 95, keyboardness: 0.75 },
  { name: 'synth effects', from: 96, to: 103, keyboardness: 0.3 },
  { name: 'ethnic', from: 104, to: 111, keyboardness: 0.3 },
  { name: 'percussive', from: 112, to: 119, keyboardness: 0.2 },
  { name: 'sound effects', from: 120, to: 127, keyboardness: 0.05 },
];

function programFamily(program) {
  if (program === null || program === undefined) return null;
  return PROGRAM_FAMILIES.find((f) => program >= f.from && program <= f.to) ?? null;
}

/**
 * Average number of notes sounding at once -- the clearest single signal that
 * separates a chordal keyboard part from a bass line or a melody.
 */
export function measurePolyphony(notes) {
  if (notes.length === 0) return { mean: 0, max: 0, chordRatio: 0 };

  const boundaries = [];
  for (const note of notes) {
    boundaries.push({ t: note.start, delta: 1 });
    boundaries.push({ t: note.end, delta: -1 });
  }
  boundaries.sort((a, b) => a.t - b.t || a.delta - b.delta);

  let active = 0;
  let max = 0;
  let weighted = 0;
  let span = 0;
  let chordTime = 0;
  let prevT = boundaries[0].t;

  for (const b of boundaries) {
    const dt = b.t - prevT;
    if (dt > 0 && active > 0) {
      weighted += active * dt;
      span += dt;
      if (active >= 3) chordTime += dt;
    }
    active += b.delta;
    if (active > max) max = active;
    prevT = b.t;
  }

  return {
    mean: span > 0 ? weighted / span : 0,
    max,
    chordRatio: span > 0 ? chordTime / span : 0,
    soundingSpan: span,
  };
}

/**
 * Score how likely a track is to be the keyboard/harmonic part we want.
 */
function scoreTrack(track) {
  if (track.noteCount === 0) return { keyboardScore: 0, role: 'empty' };
  if (track.isDrumTrack) return { keyboardScore: 0, role: 'drums' };

  const poly = measurePolyphony(track.notes);
  const range = track.pitchRange;
  const spanSemitones = range ? range.max - range.min : 0;
  const family = programFamily(track.program);

  // Normalized component signals.
  const polyScore = Math.min(1, poly.mean / 3.2);
  const chordScore = Math.min(1, poly.chordRatio * 1.6);
  const rangeScore = Math.min(1, spanSemitones / 36); // keyboards cover wide ground
  const programScore = family ? family.keyboardness : 0.5;
  const densityScore = Math.min(1, track.noteCount / 60);

  const keyboardScore = polyScore * 0.3 + chordScore * 0.22 + rangeScore * 0.18
    + programScore * 0.2 + densityScore * 0.1;

  // Infer a human-readable role.
  let role;
  const avgPitch = track.notes.reduce((a, n) => a + n.pitch, 0) / track.noteCount;
  if (family && family.name === 'bass') role = 'bass';
  else if (avgPitch < 52 && poly.mean < 1.6) role = 'bass';
  else if (poly.mean >= 2.2) role = 'harmony';
  else if (poly.mean < 1.3 && avgPitch > 64) role = 'melody';
  else if (poly.mean >= 1.3) role = 'harmony';
  else role = 'melodic';

  return {
    keyboardScore,
    role,
    polyphony: poly,
    spanSemitones,
    avgPitch,
    family: family ? family.name : null,
    signals: { polyScore, chordScore, rangeScore, programScore, densityScore },
  };
}

/**
 * Analyze all tracks in a normalized score.
 *
 * @param {object} score output of normalizeMidi()
 * @returns {{tracks:Array, recommended:Array<number>, recommendedMode:string, summary:string}}
 */
export function analyzeTracks(score) {
  const analyzed = score.tracks.map((track) => {
    const stats = scoreTrack(track);
    return {
      index: track.index,
      name: track.name,
      instrumentName: track.instrumentName
        || (track.program !== null ? gmInstrumentName(track.program) : null),
      program: track.program,
      channels: track.channels,
      isDrumTrack: track.isDrumTrack,
      noteCount: track.noteCount,
      pitchRange: track.pitchRange,
      durationBeats: track.notes.length
        ? Math.max(...track.notes.map((n) => n.end)) - Math.min(...track.notes.map((n) => n.start))
        : 0,
      ...stats,
    };
  });

  const usable = analyzed.filter((t) => t.noteCount > 0 && !t.isDrumTrack);

  // Name hints are strong evidence and cheap to check.
  const nameHint = (t) => {
    if (t.isDrumTrack) return -1;
    // The track name is checked before the (often meaningless) program name, and
    // percussion is screened first so a drum track on program 0 is not read as
    // "Acoustic Grand Piano".
    const text = `${t.name ?? ''} ${t.instrumentName ?? ''}`.toLowerCase();
    if (/drum|perc|kick|snare|hat|cymbal/.test(text)) return -1;
    if (/piano|keys|keyboard|rhodes|wurli|harpsi|clav|organ|epiano|e\.piano/.test(text)) return 0.18;
    if (/bass/.test(text)) return -0.12;
    if (/lead|melody|vocal|vox/.test(text)) return -0.05;
    return 0;
  };

  for (const t of analyzed) t.keyboardScore = Math.max(0, Math.min(1, t.keyboardScore + nameHint(t)));

  const ranked = [...usable].sort((a, b) => b.keyboardScore - a.keyboardScore);
  const best = ranked[0] ?? null;

  // Is the keyboard part split across tracks (section 4B)? That shows up as
  // several harmonic tracks with comparable scores and overlapping time spans.
  const strongHarmonic = ranked.filter(
    (t) => t.keyboardScore >= (best ? best.keyboardScore * 0.75 : 1) && t.role === 'harmony',
  );
  const split = strongHarmonic.length > 1;

  const recommended = best ? [best.index] : [];
  const recommendedMode = split ? 'all-harmonic' : 'single';

  const harmonicTracks = usable.filter((t) => t.role === 'harmony' || t.role === 'bass').map((t) => t.index);

  let summary;
  if (!best) summary = 'No pitched material found in this file.';
  else if (usable.length === 1) summary = `Single pitched track: ${best.name || best.instrumentName || `Track ${best.index}`}.`;
  else if (split) summary = `${usable.length} pitched tracks; the keyboard part may be split across ${strongHarmonic.length} of them.`;
  else summary = `${usable.length} pitched tracks; best keyboard candidate is ${best.name || best.instrumentName || `Track ${best.index}`}.`;

  return {
    tracks: analyzed,
    usable: usable.map((t) => t.index),
    harmonicTracks,
    recommended,
    recommendedMode,
    split,
    summary,
  };
}

/**
 * Collect the notes for a given source selection.
 *
 * @param {object} score
 * @param {{mode:string, trackIndices?:Array<number>}} selection
 */
export function selectSourceNotes(score, selection) {
  const { mode = 'single', trackIndices = [] } = selection || {};
  if (mode === 'all-harmonic') {
    const analysis = analyzeTracks(score);
    const wanted = new Set(analysis.harmonicTracks);
    return score.notes.filter((n) => wanted.has(n.track));
  }
  if (mode === 'all') {
    const drums = new Set(score.tracks.filter((t) => t.isDrumTrack).map((t) => t.index));
    return score.notes.filter((n) => !drums.has(n.track));
  }
  const wanted = new Set(trackIndices);
  return score.notes.filter((n) => wanted.has(n.track));
}
