#!/usr/bin/env node
/**
 * Generates the sample MIDI files in samples/.
 *
 * They are written rather than committed as opaque binaries so it is clear what
 * is in them, and so the "human timing" example can have its onset spread
 * stated explicitly instead of hidden inside a blob.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { writeMidi, beatsToTicks } from '../test/fixtures/writeMidi.js';

mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });

const write = (name, bytes, description) => {
  const path = new URL(`../samples/${name}`, import.meta.url);
  writeFileSync(path, bytes);
  process.stdout.write(`${name.padEnd(30)} ${bytes.length.toString().padStart(5)} bytes  ${description}\n`);
};

/* 1. A human-played ballad: rolled chords, a melody, a closing arpeggio. */
{
  const notes = [];
  // Each chord is rolled bottom-to-top over about 40 ms, as a pianist plays it.
  const roll = (pitches, start, duration, spread = 0.02) => {
    pitches.forEach((pitch, i) => notes.push({
      pitch,
      start: start + i * spread,
      duration: duration - i * spread,
      velocity: 74 + Math.round(Math.random() * 10) + (i === 0 ? 8 : 0),
    }));
  };

  const progression = [
    [41, 60, 65, 69], // F
    [43, 59, 62, 67], // G7-ish
    [36, 60, 64, 67], // C
    [45, 60, 64, 69], // Am
    [41, 60, 65, 69], // F
    [43, 59, 62, 65], // G7
    [36, 55, 60, 64], // C
  ];
  progression.forEach((chord, i) => roll(chord, i * 2, 1.95));

  // A melody above it, slightly ahead of the beat in places.
  const melody = [
    [72, 0, 1.5], [74, 1.5, 0.5], [76, 2, 1.5], [74, 3.5, 0.5],
    [72, 4, 2], [69, 6, 1], [71, 7, 1],
    [72, 8, 1.5], [76, 9.5, 0.5], [79, 10, 2],
    [77, 12, 1], [76, 13, 1], [74, 14, 2],
  ];
  for (const [pitch, start, duration] of melody) {
    notes.push({ pitch, start: start - 0.012, duration, velocity: 92 });
  }

  write('ballad-human-timing.mid', writeMidi({
    tempo: 72,
    timeSignature: [4, 4],
    tracks: [{ name: 'Piano', program: 0, channel: 0, notes: beatsToTicks(notes) }],
  }), 'rolled chords, ~40 ms onset spread');
}

/* 2. A quantized multi-track arrangement, to exercise track selection. */
{
  const piano = [];
  [[64, 67, 71], [62, 65, 69], [60, 64, 67], [59, 62, 67]]
    .forEach((chord, i) => chord.forEach((pitch) => {
      piano.push({ pitch, start: i * 2, duration: 1.9, velocity: 80 });
      piano.push({ pitch, start: i * 2 + 1, duration: 0.9, velocity: 68 });
    }));

  const bass = [40, 38, 36, 43].flatMap((pitch, i) => [
    { pitch, start: i * 2, duration: 0.9, velocity: 96 },
    { pitch, start: i * 2 + 1, duration: 0.9, velocity: 84 },
  ]);

  const strings = [76, 74, 72, 71].map((pitch, i) => ({
    pitch, start: i * 2, duration: 1.95, velocity: 70,
  }));

  const drums = [];
  for (let beat = 0; beat < 8; beat += 0.5) {
    drums.push({ pitch: beat % 2 === 0 ? 36 : 38, start: beat, duration: 0.2, velocity: 100 });
    drums.push({ pitch: 42, start: beat, duration: 0.1, velocity: 70 });
  }

  write('arrangement-multitrack.mid', writeMidi({
    tempo: 104,
    tracks: [
      { name: 'Piano', program: 0, channel: 0, notes: beatsToTicks(piano) },
      { name: 'Bass', program: 33, channel: 1, notes: beatsToTicks(bass) },
      { name: 'Strings', program: 48, channel: 2, notes: beatsToTicks(strings) },
      { name: 'Drums', program: 0, channel: 9, notes: beatsToTicks(drums) },
    ],
  }), 'piano / bass / strings / drums, quantized');
}

/* 3. Arpeggios and non-chord tones, to exercise role classification. */
{
  const notes = [];
  // Left hand holds the harmony; right hand arpeggiates and decorates it.
  const harmonies = [[45, 52], [41, 48], [43, 50], [36, 48]];
  harmonies.forEach((pair, i) => pair.forEach((pitch) => {
    notes.push({ pitch, start: i * 4, duration: 3.9, velocity: 72 });
  }));

  const figures = [
    [60, 64, 69, 72, 69, 64, 60, 64], // Am outline
    [60, 65, 69, 72, 69, 65, 60, 65], // F outline
    [59, 62, 67, 71, 67, 62, 59, 62], // G outline
    [60, 64, 67, 72, 67, 64, 60, 64], // C outline
  ];
  figures.forEach((figure, bar) => figure.forEach((pitch, i) => {
    notes.push({ pitch, start: bar * 4 + i * 0.5, duration: 0.45, velocity: 84 });
  }));

  // Genuine passing tones in the last bar: each one steps between two
  // consecutive chord tones of the C harmony (C-D-E, E-F-G, G-A-B-C).
  [[62, 12.25], [65, 13.25], [69, 14.25], [71, 14.75]].forEach(([pitch, start]) => {
    notes.push({ pitch, start, duration: 0.2, velocity: 62 });
  });

  write('arpeggios-and-passing-tones.mid', writeMidi({
    tempo: 92,
    tracks: [{ name: 'Piano', program: 0, channel: 0, notes: beatsToTicks(notes) }],
  }), 'held bass, arpeggiated figures, passing tones');
}

/* 4. Jazz voicings with extensions and inversions. */
{
  const notes = [];
  const voicings = [
    [48, 64, 67, 71, 74], // Cmaj9
    [45, 64, 67, 72, 76], // Am11-ish
    [50, 65, 69, 72, 76], // Dm9
    [43, 65, 71, 74, 76], // G13
    [40, 64, 67, 71, 74], // Cmaj9/E
  ];
  voicings.forEach((chord, i) => chord.forEach((pitch, k) => {
    notes.push({ pitch, start: i * 4 + k * 0.008, duration: 3.8, velocity: 76 });
  }));

  write('jazz-extensions.mid', writeMidi({
    tempo: 84,
    tracks: [{ name: 'Keys', program: 4, channel: 0, notes: beatsToTicks(notes) }],
  }), 'ninths, elevenths, thirteenths, one inversion');
}
