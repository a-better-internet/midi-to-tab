import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from '../src/midi/parser.js';
import { normalizeMidi, pitchToName, noteNameToPitch, gmInstrumentName } from '../src/midi/normalizer.js';
import { TimingMap } from '../src/midi/timing.js';
import { writeMidi, beatsToTicks } from './fixtures/writeMidi.js';

const simple = () => writeMidi({
  tempo: 96,
  timeSignature: [3, 4],
  tracks: [
    { name: 'Piano', program: 0, channel: 0, notes: beatsToTicks([
      { pitch: 48, start: 0, duration: 2 },
      { pitch: 60, start: 0.01, duration: 1.9 },
      { pitch: 64, start: 0.02, duration: 1.88 },
    ]) },
    { name: 'Bass', program: 33, channel: 1, notes: beatsToTicks([{ pitch: 36, start: 0, duration: 2 }]) },
  ],
});

test('parses the SMF header', () => {
  const midi = parseMidi(simple());
  assert.equal(midi.format, 1);
  assert.equal(midi.ticksPerBeat, 480);
  assert.equal(midi.division.type, 'ticksPerBeat');
  // conductor track plus two music tracks
  assert.equal(midi.tracks.length, 3);
});

test('rejects files that are not MIDI', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3])), /too short/);
  const bogus = new Uint8Array(20);
  bogus.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  assert.throws(() => parseMidi(bogus), /MThd/);
});

test('accepts an ArrayBuffer as well as a Uint8Array', () => {
  const bytes = simple();
  const copy = bytes.slice().buffer;
  assert.equal(parseMidi(copy).ticksPerBeat, 480);
});

test('reads tempo, time signature and track names', () => {
  const score = normalizeMidi(parseMidi(simple()));
  assert.equal(score.tempo, 96);
  assert.deepEqual(score.timeSignature, { numerator: 3, denominator: 4 });
  assert.equal(score.tracks[1].name, 'Piano');
  assert.equal(score.tracks[1].instrumentName, 'Acoustic Grand Piano');
  assert.equal(score.tracks[2].instrumentName, 'Electric Bass (finger)');
});

test('normalizes notes without quantizing them', () => {
  const score = normalizeMidi(parseMidi(simple()));
  const piano = score.tracks[1].notes;
  assert.equal(piano.length, 3);
  // The writer rounds 0.01 beats to the nearest tick (5/480), and the parser
  // must hand back that exact tick -- no snapping to a musical grid.
  assert.equal(piano[1].startTick, 5);
  assert.ok(Math.abs(piano[1].start - 5 / 480) < 1e-12, `start was ${piano[1].start}`);
  // 5/480 beats at 96 bpm = 6.51 ms.
  assert.ok(Math.abs(piano[1].startSec - (5 / 480) * (60 / 96)) < 1e-12,
    `startSec was ${piano[1].startSec}`);
  assert.ok(piano[1].start > 0 && piano[1].start < 0.02);
  for (const note of piano) {
    assert.equal(typeof note.pitch, 'number');
    assert.equal(typeof note.duration, 'number');
    assert.equal(typeof note.velocity, 'number');
    assert.equal(typeof note.channel, 'number');
    assert.equal(typeof note.track, 'number');
    assert.ok(note.duration > 0);
  }
});

test('treats note-on with velocity 0 as note-off', () => {
  // Hand-built: note on, then note on with velocity 0.
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0x0d,
    0x00, 0x90, 0x3c, 0x40,
    0x81, 0x70, 0x90, 0x3c, 0x00, // delta 240 ticks = 0.5 beat
    0x00, 0xff, 0x2f, 0x00,
  ]);
  const score = normalizeMidi(parseMidi(bytes));
  assert.equal(score.notes.length, 1);
  assert.equal(score.notes[0].pitch, 60);
  assert.equal(score.notes[0].endTick, 240);
  assert.ok(Math.abs(score.notes[0].duration - 0.5) < 1e-9);
});

test('handles running status', () => {
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0x11,
    0x00, 0x90, 0x3c, 0x40, // note on C4
    0x00, 0x40, 0x40, // running status: note on E4
    0x60, 0x80, 0x3c, 0x00,
    0x00, 0x40, 0x00, // running status note off
    0x00, 0xff, 0x2f, 0x00,
  ]);
  const score = normalizeMidi(parseMidi(bytes));
  assert.equal(score.notes.length, 2);
  assert.deepEqual(score.notes.map((n) => n.pitch), [60, 64]);
});

test('sustain pedal extends note releases', () => {
  // pedal down, note on, note off (key up), pedal up much later
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0x15,
    0x00, 0xb0, 0x40, 0x7f, // CC64 = 127 (down)
    0x00, 0x90, 0x3c, 0x40,
    0x30, 0x80, 0x3c, 0x00, // key released after 0.1 beat
    0x81, 0x40, 0xb0, 0x40, 0x00, // pedal up at ~0.5 beats later
    0x00, 0xff, 0x2f, 0x00,
  ]);
  const withPedal = normalizeMidi(parseMidi(bytes));
  const withoutPedal = normalizeMidi(parseMidi(bytes), { applySustain: false });
  assert.ok(withPedal.notes[0].duration > withoutPedal.notes[0].duration,
    'pedal should lengthen the note');
  assert.ok(Math.abs(withoutPedal.notes[0].duration - 0.1) < 1e-6);
});

test('closes notes that never receive a note-off', () => {
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0x08,
    0x00, 0x90, 0x3c, 0x40,
    0x60, 0xff, 0x2f, 0x00,
  ]);
  const score = normalizeMidi(parseMidi(bytes));
  assert.equal(score.notes.length, 1);
  assert.ok(score.notes[0].duration > 0);
});

test('tempo map converts ticks to seconds across a tempo change', () => {
  const midi = {
    ticksPerBeat: 480,
    division: { type: 'ticksPerBeat', ticksPerBeat: 480 },
    tracks: [{ events: [
      { kind: 'meta', subtype: 'setTempo', tick: 0, microsecondsPerBeat: 500000, bpm: 120 },
      { kind: 'meta', subtype: 'setTempo', tick: 960, microsecondsPerBeat: 1000000, bpm: 60 },
      { kind: 'meta', subtype: 'timeSignature', tick: 0, numerator: 4, denominator: 4 },
    ] }],
  };
  const timing = new TimingMap(midi);
  assert.equal(timing.ticksToSeconds(0), 0);
  assert.equal(timing.ticksToSeconds(480), 0.5); // 1 beat at 120
  assert.equal(timing.ticksToSeconds(960), 1.0); // 2 beats at 120
  assert.equal(timing.ticksToSeconds(1440), 2.0); // +1 beat at 60
  assert.ok(Math.abs(timing.secondsToBeats(2.0) - 3) < 1e-9);
  assert.equal(timing.tempoAtBeat(0), 120);
  assert.equal(timing.tempoAtBeat(2.5), 60);
});

test('bar lines follow a changing time signature', () => {
  const midi = {
    ticksPerBeat: 480,
    division: { type: 'ticksPerBeat', ticksPerBeat: 480 },
    tracks: [{ events: [
      { kind: 'meta', subtype: 'timeSignature', tick: 0, numerator: 3, denominator: 4 },
      { kind: 'meta', subtype: 'timeSignature', tick: 480 * 6, numerator: 4, denominator: 4 },
    ] }],
  };
  const timing = new TimingMap(midi);
  assert.deepEqual(timing.barLines(14), [0, 3, 6, 10, 14]);
  assert.equal(timing.barAndBeat(7).bar, 3);
  assert.equal(timing.beatsPerBarAt(0), 3);
  assert.equal(timing.beatsPerBarAt(7), 4);
});

test('pitch name helpers round-trip', () => {
  assert.equal(pitchToName(60), 'C4');
  assert.equal(pitchToName(40), 'E2');
  assert.equal(pitchToName(70, { flats: true }), 'Bb4');
  assert.equal(noteNameToPitch('C4'), 60);
  assert.equal(noteNameToPitch('E2'), 40);
  assert.equal(noteNameToPitch('F#3'), 54);
  assert.equal(noteNameToPitch('Bb4'), 70);
  assert.equal(noteNameToPitch('nonsense'), null);
  assert.equal(gmInstrumentName(24), 'Acoustic Guitar (nylon)');
});
