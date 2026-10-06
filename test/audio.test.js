import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from '../src/midi/parser.js';
import { normalizeMidi } from '../src/midi/normalizer.js';
import { transcribe } from '../src/transcription/pipeline.js';
import { Player, PianoSynth, guitarNotesFromTab } from '../src/audio/midiPlayer.js';
import { GuitarSynth, midiToFrequency, ringTime } from '../src/audio/guitarSynth.js';
import { writeMidi, beatsToTicks } from './fixtures/writeMidi.js';
import { FakeAudioContext, recordVoices } from './fixtures/fakeAudio.js';

function score() {
  const notes = [];
  [[36, 60, 64, 67], [33, 60, 64, 69], [29, 60, 65, 69], [31, 59, 62, 67]]
    .forEach((chord, i) => chord.forEach((pitch, k) => {
      notes.push({ pitch, start: i * 2 + k * 0.004, duration: 1.9 });
    }));
  return normalizeMidi(parseMidi(writeMidi({
    tempo: 120, tracks: [{ name: 'Piano', program: 0, notes: beatsToTicks(notes) }],
  })));
}

async function buildPlayer(options = {}) {
  const s = score();
  const result = transcribe(s);
  const context = new FakeAudioContext();
  const player = new Player({ createContext: () => context, ...options });
  await player.ensureContext();
  player.setSources({
    timing: s.timing,
    midiNotes: result.sourceNotes,
    guitarNotes: guitarNotesFromTab(result.tab),
    endBeat: result.tab.totalBeats,
  });
  return { player, context, result, score: s, log: recordVoices(player) };
}

// ------------------------------------------------------------------ pitch

test('MIDI pitches map to the right frequencies', () => {
  assert.equal(midiToFrequency(69), 440);
  assert.ok(Math.abs(midiToFrequency(57) - 220) < 1e-9);
  assert.ok(Math.abs(midiToFrequency(81) - 880) < 1e-9);
  assert.ok(Math.abs(midiToFrequency(40) - 82.4069) < 0.001, 'low E');
  assert.ok(Math.abs(midiToFrequency(64) - 329.6276) < 0.001, 'high E');
});

test('every guitar note sounds at its own pitch, not a clamped one', () => {
  // Karplus-Strong through a DelayNode cannot do this: a delay inside a
  // feedback cycle is clamped to 128 samples, which puts everything above
  // roughly 344 Hz flat. Each distinct pitch must get a distinct frequency.
  const context = new FakeAudioContext();
  const synth = new GuitarSynth(context, context.destination);
  const pitches = [40, 45, 50, 55, 59, 64, 69, 76, 83, 88];
  const heard = pitches.map((pitch) => {
    context._started.length = 0;
    synth.pluck({ pitch, when: 0, duration: 1, velocity: 100 });
    return context._started[0].frequency.value;
  });

  for (let i = 0; i < pitches.length; i += 1) {
    assert.ok(Math.abs(heard[i] - midiToFrequency(pitches[i])) < 0.01,
      `pitch ${pitches[i]} sounded at ${heard[i]}`);
  }
  assert.equal(new Set(heard).size, pitches.length, 'no two pitches may collapse together');
});

test('the guitar voice uses no feedback path', () => {
  // The original Karplus-Strong voice fed a delay line back into itself, and
  // because the damping biquad had passband gain above 1 the loop grew without
  // bound. No delay node means no loop to go unstable.
  const context = new FakeAudioContext();
  const synth = new GuitarSynth(context, context.destination);
  const created = [];
  const realDelay = context.createDelay.bind(context);
  context.createDelay = (...args) => { created.push('delay'); return realDelay(...args); };
  synth.pluck({ pitch: 60, when: 0, duration: 1, velocity: 100, string: 2 });
  assert.deepEqual(created, [], 'no delay node, so no feedback loop');
});

test('ring time stays bounded and favours the low strings', () => {
  for (let pitch = 28; pitch <= 100; pitch += 1) {
    const ring = ringTime(pitch, 2);
    assert.ok(ring > 0 && ring <= 4.5, `pitch ${pitch} rings for ${ring}s`);
  }
  assert.ok(ringTime(40, 1) > ringTime(76, 1), 'low strings sustain longer');
});

test('envelopes never ramp exponentially to zero', () => {
  // A zero target throws in real Web Audio; the fake context enforces it too.
  const context = new FakeAudioContext();
  const guitar = new GuitarSynth(context, context.destination);
  const piano = new PianoSynth(context, context.destination);
  assert.doesNotThrow(() => guitar.pluck({ pitch: 60, when: 0, duration: 1, velocity: 1 }));
  assert.doesNotThrow(() => piano.strike({ pitch: 60, when: 0, duration: 1, velocity: 1 }));
  assert.doesNotThrow(() => guitar.pluck({ pitch: 60, when: 0, duration: 0.01, velocity: 127 }));
});

test('a piano envelope is built from constants, not from a live gain reading', () => {
  const context = new FakeAudioContext();
  const piano = new PianoSynth(context, context.destination);
  const voice = piano.strike({ pitch: 60, when: 1, duration: 2, velocity: 100 });
  const envelope = voice.nodes[0];
  // Reading `gain.value` while scheduling returns zero, which silently
  // collapsed the envelope. Every stage must reach a positive level.
  const levels = envelope.gain.events.filter((e) => e.type !== 'cancel').map((e) => e.value);
  assert.ok(levels.some((v) => v > 0.01), `envelope never opens: ${JSON.stringify(levels)}`);
  assert.ok(levels.every((v) => v > 0), 'no stage may be scheduled at exactly zero');
});

// -------------------------------------------------------------- scheduling

test('schedules every note once, at the right moment', async () => {
  const { player, log, score: s } = await buildPlayer();
  player.setMode('both');
  player.scheduleAll({ fromBeat: 0, anchorTime: 10 });

  assert.equal(log.piano.length, player.midiNotes.length, 'every source note plays');
  assert.equal(log.guitar.length, player.guitarNotes.length, 'every fretted note plays');

  for (const note of player.midiNotes) {
    const played = log.piano.find((p) => p.pitch === note.pitch
      && Math.abs(p.when - (10 + s.timing.beatsToSeconds(note.start))) < 1e-6);
    assert.ok(played, `no voice for pitch ${note.pitch} at beat ${note.start}`);
  }

  const keys = log.guitar.map((g) => `${g.pitch}@${g.when.toFixed(6)}`);
  assert.equal(new Set(keys).size, keys.length, 'nothing is scheduled twice');
});

test('playback mode decides which voices are used', async () => {
  for (const [mode, wantPiano, wantGuitar] of [
    ['midi', true, false], ['guitar', false, true], ['both', true, true],
  ]) {
    const { player, log } = await buildPlayer();
    player.setMode(mode);
    player.scheduleAll({ fromBeat: 0, anchorTime: 0 });
    assert.equal(log.piano.length > 0, wantPiano, `${mode} piano`);
    assert.equal(log.guitar.length > 0, wantGuitar, `${mode} guitar`);
  }
});

test('score time and audio-clock time are not confused', async () => {
  // Starting partway in must not shift notes: the note at the start beat has
  // to sound at the anchor exactly.
  const { player, log, score: s } = await buildPlayer();
  player.setMode('midi');
  const fromBeat = 4;
  player.scheduleAll({ fromBeat, anchorTime: 100 });

  assert.ok(log.piano.length > 0);
  const earliest = Math.min(...log.piano.map((p) => p.when));
  const expected = 100 + (s.timing.beatsToSeconds(4) - s.timing.beatsToSeconds(fromBeat));
  assert.ok(Math.abs(earliest - expected) < 1e-6, `first note at ${earliest}, expected ${expected}`);
  // Nothing before the start point should be scheduled at all.
  assert.ok(log.piano.every((p) => p.when >= 100 - 1e-9));
});

test('practice speed stretches time without moving pitches', async () => {
  // Anchored away from zero, so the "never schedule in the past" guard does
  // not clamp the first note and mask the comparison.
  const ANCHOR = 50;
  const { player: full, log: fullLog } = await buildPlayer();
  full.setMode('guitar');
  full.scheduleAll({ fromBeat: 0, anchorTime: ANCHOR });

  const { player: half, log: halfLog } = await buildPlayer();
  half.setMode('guitar');
  half.rate = 0.5;
  half.scheduleAll({ fromBeat: 0, anchorTime: ANCHOR });

  assert.equal(halfLog.guitar.length, fullLog.guitar.length);
  let stretched = 0;
  for (let i = 0; i < fullLog.guitar.length; i += 1) {
    assert.equal(halfLog.guitar[i].pitch, fullLog.guitar[i].pitch, 'pitch must not change');
    const fullOffset = fullLog.guitar[i].when - ANCHOR;
    const halfOffset = halfLog.guitar[i].when - ANCHOR;
    assert.ok(Math.abs(halfOffset - fullOffset * 2) < 1e-6,
      `half speed means twice the wall-clock time (${halfOffset} vs ${fullOffset})`);
    if (fullLog.guitar[i].duration > 0.1) {
      assert.ok(Math.abs(halfLog.guitar[i].duration - fullLog.guitar[i].duration * 2) < 1e-6,
        'notes are held proportionally longer');
      stretched += 1;
    }
  }
  assert.ok(stretched > 0, 'the comparison must actually have examined some notes');
});

test('the count-in clicks before the music, not over it', async () => {
  const { player, log, score: s } = await buildPlayer();
  player.setMode('midi');
  player.countInBeats = 4;
  await player.play(0);

  assert.equal(log.clicks.length, 4);
  assert.equal(log.clicks[0].accent, true, 'the first beat is accented');
  assert.ok(log.clicks.slice(1).every((c) => c.accent === false));

  const beatSec = s.timing.beatsToSeconds(1) - s.timing.beatsToSeconds(0);
  for (let i = 1; i < log.clicks.length; i += 1) {
    assert.ok(Math.abs((log.clicks[i].when - log.clicks[i - 1].when) - beatSec) < 1e-6,
      'clicks are one beat apart');
  }
  const lastClick = log.clicks[log.clicks.length - 1].when;
  assert.ok(player.anchorTime > lastClick, 'the music starts after the last click');
  for (const note of log.piano) {
    assert.ok(note.when >= player.anchorTime - 1e-6, 'no note sounds during the count-in');
  }
  player.stop();
});

test('playing with no count-in starts immediately', async () => {
  const { player, log } = await buildPlayer();
  player.countInBeats = 0;
  await player.play(0);
  assert.equal(log.clicks.length, 0);
  player.stop();
});

// ---------------------------------------------------------------- lifecycle

test('stopping never strands the master gain', async () => {
  // The original stop() ramped the master to zero and restored it on a timer
  // guarded by `!playing`, so restarting inside that window left the output
  // muted for good. Nothing may touch the master gain on stop.
  const { player } = await buildPlayer();
  await player.play(0);
  player.stop();
  assert.equal(player.master.gain.value, 0.9);

  await player.play(0);
  player.pause();
  await player.play(0);
  player.stop();
  assert.equal(player.master.gain.value, 0.9, 'gain survives a rapid pause/play');

  for (let i = 0; i < 5; i += 1) {
    await player.play(0);
    player.stop();
  }
  assert.equal(player.master.gain.value, 0.9);
});

test('stopping releases the voices it started', async () => {
  const { player, context } = await buildPlayer();
  player.setMode('both');
  await player.play(0);
  context.advance(0.2);
  player._schedule();
  assert.ok(player.guitar.voices.size + player.piano.voices.size > 0, 'something should be sounding');

  player.stop();
  assert.equal(player.guitar.voices.size, 0, 'guitar voices released');
  assert.equal(player.piano.voices.size, 0, 'piano voices released');
});

test('volume is remembered and reapplied', async () => {
  const { player } = await buildPlayer();
  player.volume = 0.4;
  assert.equal(player.volume, 0.4);
  assert.equal(player.master.gain.value, 0.4);
  await player.play(0);
  player.stop();
  assert.equal(player.master.gain.value, 0.4, 'stopping must not reset the volume');
});

test('changing speed mid-playback keeps the position', async () => {
  const { player, context } = await buildPlayer();
  await player.play(0);
  context.advance(1.0);
  const before = player.currentBeat;
  await player.setRate(0.5);
  const after = player.currentBeat;
  assert.ok(Math.abs(after - before) < 0.05, `jumped from ${before} to ${after}`);
  assert.equal(player.rate, 0.5);
  assert.equal(player.playing, true);
  player.stop();
});

test('speed is clamped to a usable range', async () => {
  const { player } = await buildPlayer();
  await player.setRate(99);
  assert.equal(player.rate, 2);
  await player.setRate(0.01);
  assert.equal(player.rate, 0.25);
});

test('a stop issued while the context is starting still stops playback', async () => {
  // play() must await the AudioContext before it can start its transport, so
  // a stop in that window has to win rather than being overtaken.
  const { player } = await buildPlayer();
  const starting = player.play(0);
  player.stop();
  await starting;
  assert.equal(player.playing, false);
  assert.equal(player._timer, null, 'no transport timer may be left running');
});

test('auditioning a chord plays it as a strum', async () => {
  const { player, log, result } = await buildPlayer();
  const voicing = result.transcribed[0].voicing;
  await player.audition(voicing.played.map((p) => ({ pitch: p.pitch, string: p.string })));

  assert.equal(log.guitar.length, voicing.played.length);
  const times = log.guitar.map((g) => g.when);
  assert.ok(times[times.length - 1] > times[0], 'a strum is spread across time');
  assert.ok(times[times.length - 1] - times[0] < 0.2, 'but it is still one gesture');
  assert.deepEqual(
    [...log.guitar].map((g) => g.pitch).sort((a, b) => a - b),
    voicing.played.map((p) => p.pitch).sort((a, b) => a - b),
  );
});

test('auditioning nothing is harmless', async () => {
  const { player, log } = await buildPlayer();
  await player.audition([]);
  assert.equal(log.guitar.length, 0);
});

// ----------------------------------------------------------- tab -> audio

test('the guitar part played is the guitar part shown', async () => {
  const s = score();
  const result = transcribe(s);
  const notes = guitarNotesFromTab(result.tab);

  let expected = 0;
  for (const column of result.tab.columns) expected += column.voicing.played.length;
  assert.equal(notes.length, expected, 'one sounding note per fretted position');

  for (const note of notes) {
    const column = result.tab.columns[note.column];
    assert.equal(note.start, column.start, 'onsets match the tab exactly');
    const fretted = column.voicing.played.find((p) => p.string === note.string);
    assert.ok(fretted, 'the note is on a string the tab actually uses');
    assert.equal(note.pitch, fretted.pitch);
  }
});
