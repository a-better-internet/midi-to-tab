/**
 * Playback and the three-way audition of brief section 35:
 *
 *   > Original MIDI   > Generated Guitar   > Original + Guitar
 *
 * A piano voice for the source, the guitar synth for the transcription, and a
 * single scheduler that can drive either or both in sync. Scheduling is done
 * with a look-ahead window so a long file does not create thousands of audio
 * nodes up front.
 *
 * Musical position is always expressed in beats and converted through the
 * score's own tempo map, so playback follows tempo changes and stays aligned
 * with the piano roll and the tab.
 */

import { GuitarSynth, midiToFrequency } from './guitarSynth.js';

/** A simple struck-string piano voice: enough to recognise the original by. */
export class PianoSynth {
  constructor(context, destination) {
    this.context = context;
    this.output = context.createGain();
    this.output.gain.value = 0.55;

    this.tone = context.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5200;

    this.output.connect(this.tone);
    this.tone.connect(destination);
  }

  set gain(value) {
    this.output.gain.value = value;
  }

  strike({ pitch, when, duration, velocity = 90 }) {
    const ctx = this.context;
    const frequency = midiToFrequency(pitch);
    const level = (velocity / 127) ** 1.5;
    const ring = Math.max(0.25, Math.min(4.5, duration + 0.45));

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(level * 0.42, when + 0.006);
    envelope.gain.setTargetAtTime(level * 0.16, when + 0.02, 0.35);
    envelope.gain.setValueAtTime(envelope.gain.value, when + Math.max(0.04, duration));
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + ring);
    envelope.connect(this.output);

    // Fundamental plus two partials, slightly detuned and decaying faster.
    const partials = [
      { ratio: 1, gain: 1, type: 'triangle' },
      { ratio: 2.001, gain: 0.3, type: 'sine' },
      { ratio: 3.002, gain: 0.12, type: 'sine' },
    ];
    const nodes = [envelope];
    for (const partial of partials) {
      const osc = ctx.createOscillator();
      osc.type = partial.type;
      osc.frequency.value = frequency * partial.ratio;
      const gain = ctx.createGain();
      gain.gain.value = partial.gain;
      osc.connect(gain);
      gain.connect(envelope);
      osc.start(when);
      osc.stop(when + ring);
      nodes.push(osc, gain);
    }

    return { stopAt: when + ring + 0.05, nodes };
  }
}

export const PLAYBACK_MODES = {
  midi: 'Original MIDI',
  guitar: 'Generated Guitar',
  both: 'Original + Guitar',
};

export class Player {
  /**
   * @param {object} [options]
   * @param {number} [options.lookaheadSec=0.25] how far ahead to schedule
   */
  constructor(options = {}) {
    this.lookaheadSec = options.lookaheadSec ?? 0.25;
    this.tickMs = options.tickMs ?? 40;

    this.context = null;
    this.master = null;
    this.piano = null;
    this.guitar = null;

    this.timing = null;
    this.midiNotes = [];
    this.guitarNotes = [];

    this.mode = 'both';
    this.playing = false;
    this.startBeat = 0;
    this.startTime = 0;
    this._timer = null;
    this._cursorSec = 0;
    this._scheduled = new Set();
    this._listeners = new Set();
    this.endBeat = 0;
    this.loop = false;
  }

  /** Lazily create the AudioContext: browsers require a user gesture first. */
  async ensureContext() {
    if (!this.context) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is not available in this browser');
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.context.destination);
      this.piano = new PianoSynth(this.context, this.master);
      this.guitar = new GuitarSynth(this.context, this.master);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  /**
   * @param {object} sources
   * @param {TimingMap} sources.timing
   * @param {Array} sources.midiNotes normalized notes
   * @param {Array} sources.guitarNotes [{pitch, start, duration, velocity, string}]
   * @param {number} sources.endBeat
   */
  setSources({ timing, midiNotes = [], guitarNotes = [], endBeat = 0 }) {
    this.timing = timing;
    this.midiNotes = [...midiNotes].sort((a, b) => a.start - b.start);
    this.guitarNotes = [...guitarNotes].sort((a, b) => a.start - b.start);
    this.endBeat = endBeat || Math.max(
      0,
      ...this.midiNotes.map((n) => n.start + n.duration),
      ...this.guitarNotes.map((n) => n.start + n.duration),
    );
  }

  setMode(mode) {
    this.mode = mode;
  }

  set volume(value) {
    if (this.master) this.master.gain.value = value;
  }

  onTick(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get currentBeat() {
    if (!this.timing) return 0;
    if (!this.playing) return this.startBeat;
    const elapsed = this.context.currentTime - this.startTime;
    return this.timing.secondsToBeats(this.timing.beatsToSeconds(this.startBeat) + elapsed);
  }

  async play(fromBeat = null) {
    await this.ensureContext();
    if (this.playing) this.stop({ silent: true });

    this.startBeat = fromBeat === null ? this.startBeat : fromBeat;
    if (this.startBeat >= this.endBeat - 1e-6) this.startBeat = 0;

    this.startTime = this.context.currentTime + 0.08; // a beat of headroom
    this._cursorSec = this.timing.beatsToSeconds(this.startBeat);
    this._scheduled.clear();
    this.playing = true;

    this._schedule();
    this._timer = setInterval(() => this._schedule(), this.tickMs);
    this._emit();
    return this;
  }

  pause() {
    if (!this.playing) return this;
    const beat = this.currentBeat;
    this.stop({ silent: true });
    this.startBeat = beat;
    this._emit();
    return this;
  }

  stop({ silent = false, rewind = false } = {}) {
    this.playing = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.context) {
      // Cut the tails cleanly rather than letting everything ring on.
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(0, now, 0.015);
      setTimeout(() => {
        if (!this.playing && this.master) this.master.gain.setValueAtTime(0.9, this.context.currentTime);
      }, 90);
    }
    if (rewind) this.startBeat = 0;
    if (!silent) this._emit();
    return this;
  }

  seek(beat) {
    const wasPlaying = this.playing;
    this.stop({ silent: true });
    this.startBeat = Math.max(0, Math.min(beat, this.endBeat));
    if (wasPlaying) this.play(this.startBeat);
    else this._emit();
    return this;
  }

  _emit() {
    const state = {
      playing: this.playing,
      beat: this.currentBeat,
      endBeat: this.endBeat,
      mode: this.mode,
    };
    for (const listener of this._listeners) listener(state);
  }

  _schedule() {
    if (!this.playing || !this.timing) return;

    const now = this.context.currentTime;
    const elapsed = Math.max(0, now - this.startTime);
    const playheadSec = this.timing.beatsToSeconds(this.startBeat) + elapsed;
    const until = playheadSec + this.lookaheadSec;

    const wantMidi = this.mode === 'midi' || this.mode === 'both';
    const wantGuitar = this.mode === 'guitar' || this.mode === 'both';

    if (wantMidi) this._scheduleVoices(this.midiNotes, 'm', until, playheadSec, false);
    if (wantGuitar) this._scheduleVoices(this.guitarNotes, 'g', until, playheadSec, true);

    this._cursorSec = until;
    this._emit();

    const endSec = this.timing.beatsToSeconds(this.endBeat);
    if (playheadSec > endSec + 0.4) {
      if (this.loop) this.play(0);
      else {
        this.stop({ rewind: true });
      }
    }
  }

  _scheduleVoices(notes, prefix, until, playheadSec, isGuitar) {
    for (const note of notes) {
      const startSec = this.timing.beatsToSeconds(note.start);
      if (startSec < this._cursorSec - 1e-9) continue;
      if (startSec > until) break; // notes are time-sorted
      const key = `${prefix}:${note.id ?? `${note.pitch}@${note.start}`}`;
      if (this._scheduled.has(key)) continue;
      this._scheduled.add(key);

      const when = this.startTime + (startSec - this.timing.beatsToSeconds(this.startBeat));
      if (when < playheadSec + this.startTime - 0.05) continue;

      const durationSec = Math.max(
        0.05,
        this.timing.beatsToSeconds(note.start + note.duration) - startSec,
      );

      if (isGuitar) {
        this.guitar.pluck({
          pitch: note.pitch,
          when: Math.max(when, this.context.currentTime + 0.005),
          duration: durationSec,
          velocity: note.velocity ?? 92,
          string: note.string ?? null,
          stringCount: note.stringCount ?? 6,
        });
      } else {
        this.piano.strike({
          pitch: note.pitch,
          when: Math.max(when, this.context.currentTime + 0.005),
          duration: durationSec,
          velocity: note.velocity ?? 85,
        });
      }
    }
  }
}

/**
 * Flatten a transcription into playable guitar notes.
 * Each fretted position becomes a note at the column's onset, which is what
 * makes "Original + Guitar" a genuine A/B comparison.
 */
export function guitarNotesFromTab(tab) {
  const notes = [];
  for (const column of tab.columns) {
    for (const played of column.voicing.played) {
      notes.push({
        id: `${column.index}:${played.string}`,
        pitch: played.pitch,
        start: column.start,
        duration: column.duration,
        velocity: column.notes?.[0]?.velocity ?? 92,
        string: played.string,
        stringCount: tab.stringCount,
        column: column.index,
      });
    }
  }
  return notes;
}
