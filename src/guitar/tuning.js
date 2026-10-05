/**
 * Guitar configuration: tunings, string counts, capo (brief section 21).
 *
 * Strings are stored low-pitch-first internally (index 0 = lowest/6th string)
 * because every fretboard calculation is easier that way. Tab is rendered with
 * the highest string on top, so the renderer reverses for display -- not here.
 */

import { noteNameToPitch, pitchToName } from '../midi/normalizer.js';

/** @typedef {{id:string,name:string,strings:string[],stringCount:number,instrument:string}} Tuning */

const def = (id, name, strings, instrument = 'guitar') => ({
  id,
  name,
  strings, // low to high
  stringCount: strings.length,
  instrument,
});

export const TUNINGS = [
  def('standard', 'Standard (E A D G B E)', ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  def('drop-d', 'Drop D (D A D G B E)', ['D2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  def('dadgad', 'DADGAD', ['D2', 'A2', 'D3', 'G3', 'A3', 'D4']),
  def('open-g', 'Open G (D G D G B D)', ['D2', 'G2', 'D3', 'G3', 'B3', 'D4']),
  def('open-d', 'Open D (D A D F# A D)', ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4']),
  def('open-e', 'Open E (E B E G# B E)', ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4']),
  def('half-down', 'Eb Standard (half step down)', ['D#2', 'G#2', 'C#3', 'F#3', 'A#3', 'D#4']),
  def('whole-down', 'D Standard (whole step down)', ['D2', 'G2', 'C3', 'F3', 'A3', 'D4']),
  def('drop-c', 'Drop C (C G C F A D)', ['C2', 'G2', 'C3', 'F3', 'A3', 'D4']),
  def('seven-standard', '7-string Standard (B E A D G B E)', ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  def('seven-drop-a', '7-string Drop A', ['A1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  def('eight-standard', '8-string Standard (F# B E A D G B E)', ['F#1', 'B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4']),

  // The engine is instrument-agnostic (section 36), so other fretted
  // instruments are just different tunings.
  def('bass-4', 'Bass 4-string (E A D G)', ['E1', 'A1', 'D2', 'G2'], 'bass'),
  def('bass-5', 'Bass 5-string (B E A D G)', ['B0', 'E1', 'A1', 'D2', 'G2'], 'bass'),
  def('ukulele', 'Ukulele (G C E A, re-entrant)', ['G4', 'C4', 'E4', 'A4'], 'ukulele'),
  def('ukulele-low-g', 'Ukulele low G (G C E A)', ['G3', 'C4', 'E4', 'A4'], 'ukulele'),
  def('banjo-g', 'Banjo open G (g D G B D)', ['G4', 'D3', 'G3', 'B3', 'D4'], 'banjo'),
  def('mandolin', 'Mandolin (G D A E)', ['G3', 'D4', 'A4', 'E5'], 'mandolin'),
];

export const TUNINGS_BY_ID = new Map(TUNINGS.map((t) => [t.id, t]));

export const DEFAULT_TUNING_ID = 'standard';

/**
 * Resolve a tuning spec into open-string MIDI pitches.
 *
 * @param {string|Tuning|{strings:string[]}} spec tuning id, tuning object, or custom
 * @param {object} [options]
 * @param {number} [options.capo=0] capo fret; raises every open string
 * @returns {{id:string,name:string,instrument:string,openPitches:number[],
 *            stringNames:string[],capo:number,stringCount:number}}
 */
export function resolveTuning(spec, options = {}) {
  const { capo = 0 } = options;
  let tuning;

  if (typeof spec === 'string') {
    tuning = TUNINGS_BY_ID.get(spec);
    if (!tuning) throw new Error(`Unknown tuning: ${spec}`);
  } else if (spec && Array.isArray(spec.strings)) {
    tuning = {
      id: spec.id ?? 'custom',
      name: spec.name ?? 'Custom',
      strings: spec.strings,
      stringCount: spec.strings.length,
      instrument: spec.instrument ?? 'guitar',
    };
  } else if (spec && Array.isArray(spec.openPitches)) {
    return {
      id: spec.id ?? 'custom',
      name: spec.name ?? 'Custom',
      instrument: spec.instrument ?? 'guitar',
      openPitches: spec.openPitches.map((p) => p + capo),
      stringNames: spec.openPitches.map((p) => pitchToName(p + capo)),
      capo,
      stringCount: spec.openPitches.length,
    };
  } else {
    tuning = TUNINGS_BY_ID.get(DEFAULT_TUNING_ID);
  }

  const openPitches = tuning.strings.map((name) => {
    const pitch = noteNameToPitch(name);
    if (pitch === null) throw new Error(`Invalid string note name: ${name}`);
    return pitch + capo;
  });

  return {
    id: tuning.id,
    name: tuning.name,
    instrument: tuning.instrument,
    openPitches,
    stringNames: openPitches.map((p) => pitchToName(p)),
    capo,
    stringCount: openPitches.length,
  };
}

/** Label strings the way players do: 6th = lowest in standard 6-string. */
export function stringLabel(tuning, stringIndex) {
  const number = tuning.stringCount - stringIndex;
  return `${number}${number === 1 ? 'st' : number === 2 ? 'nd' : number === 3 ? 'rd' : 'th'}`;
}

/** Parse a user-entered custom tuning like "D A D G A D" or "E2 A2 D3". */
export function parseCustomTuning(text) {
  const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length < 3) return null;

  // Bare letters (no octave) get sensible octaves assigned by ascending from
  // the lowest plausible register, which is what players mean by "D A D G A D".
  const hasOctaves = tokens.every((t) => /\d/.test(t));
  if (hasOctaves) {
    const pitches = tokens.map((t) => noteNameToPitch(t));
    if (pitches.some((p) => p === null)) return null;
    return { id: 'custom', name: `Custom (${tokens.join(' ')})`, strings: tokens };
  }

  const basePitches = tokens.map((t) => noteNameToPitch(`${t}2`));
  if (basePitches.some((p) => p === null)) return null;

  const strings = [];
  let previous = null;
  for (let i = 0; i < basePitches.length; i += 1) {
    let pitch = basePitches[i];
    if (i === 0) {
      // Put the lowest string in the guitar's bottom octave: C2..A2, which
      // covers drop C through standard, and sends B down to B1 for 7-strings.
      while (pitch < 34) pitch += 12;
      while (pitch >= 46) pitch -= 12;
    } else {
      while (pitch <= previous) pitch += 12;
      // Keep adjacent strings within a reasonable interval (<= major 6th).
      while (pitch - previous > 9) pitch -= 12;
      if (pitch <= previous) pitch += 12;
    }
    previous = pitch;
    strings.push(pitchToName(pitch));
  }

  return { id: 'custom', name: `Custom (${tokens.join(' ')})`, strings };
}
