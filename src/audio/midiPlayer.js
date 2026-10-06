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
    this.voices = new Set();

    this.output = context.createGain();
    this.output.gain.value = 0.5;

    this.tone = context.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5200;

    this.output.connect(this.tone);
    this.tone.connect(destination);
  }

  set gain(value) {
    this.output.gain.value = value;
  }

  allNotesOff() {
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
  }

  strike({ pitch, when, duration, velocity = 90 }) {
    const ctx = this.context;
    const frequency = midiToFrequency(pitch);
    if (!Number.isFinite(frequency) || frequency <= 0) return null;

    const level = Math.max(0.0005, ((velocity / 127) ** 1.5) * 0.42);
    const ring = Math.max(0.3, Math.min(4.5, duration + 0.5));

    // Attack, a decay to a sustaining level, then release at the note's end.
    // Every stage is scheduled from constants: reading `gain.value` here would
    // return the *current* value (zero), not the value the automation will
    // have reached, which silently collapsed the envelope.
    const peak = level;
    const sustain = Math.max(0.0002, level * 0.3);
    const releaseAt = when + Math.max(0.05, duration * 0.95);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(peak, when + 0.005);
    envelope.gain.exponentialRampToValueAtTime(sustain, Math.min(releaseAt, when + 0.6));
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + ring);
    envelope.connect(this.output);

    // Fundamental plus two partials, slightly detuned and quieter.
    const partials = [
      { ratio: 1, gain: 1, type: 'triangle' },
      { ratio: 2.001, gain: 0.3, type: 'sine' },
      { ratio: 3.002, gain: 0.12, type: 'sine' },
    ];
    const nodes = [envelope];
    const oscillators = [];
    const stopAt = when + ring + 0.05;

    for (const partial of partials) {
      const osc = ctx.createOscillator();
      osc.type = partial.type;
      osc.frequency.value = frequency * partial.ratio;
      const gain = ctx.createGain();
      gain.gain.value = partial.gain;
      osc.connect(gain);
      gain.connect(envelope);
      osc.start(when);
      osc.stop(stopAt);
      nodes.push(osc, gain);
      oscillators.push(osc);
    }

    const voice = {
      stopAt,
      stop: () => {
        for (const osc of oscillators) {
          try { osc.stop(); } catch { /* already stopped */ }
        }
        for (const node of nodes) {
          try { node.disconnect(); } catch { /* already disconnected */ }
        }
      },
    };
    this.voices.add(voice);
    oscillators[0].onended = () => {
      voice.stop();
      this.voices.delete(voice);
    };

    return { stopAt, nodes, releaseAt };
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
    /** Injectable so tests can render through an OfflineAudioContext. */
    this.createContext = options.createContext ?? null;
    this.masterVolume = options.volume ?? 0.9;

    this.context = null;
    this.master = null;
    this.piano = null;
    this.guitar = null;

    this.timing = null;
    this.midiNotes = [];
    this.guitarNotes = [];

    this.mode = 'both';
    this.playing = false;
    /** Practice speed. 0.5 plays at half tempo without changing pitch mapping. */
    this.rate = options.rate ?? 1;
    /** Beats of click track before the music starts, for playing along. */
    this.countInBeats = options.countInBeats ?? 0;
    this.countingIn = false;
    /** Score position, in beats, that playback starts (or resumes) from. */
    this.startBeat = 0;
    /** AudioContext time at which `startBeat` sounds. */
    this.anchorTime = 0;
    this._timer = null;
    /**
     * Bumped by every play/stop. `play()` has to await the AudioContext before
     * it can start its timer, so without this a stop issued in between would
     * be overtaken and leave the transport running.
     */
    this._generation = 0;
    /** How far through the score, in seconds, has already been scheduled. */
    this._scheduledUntilSec = 0;
    this._scheduled = new Set();
    this._listeners = new Set();
    this.endBeat = 0;
    this.loop = false;
  }

  /** Lazily create the AudioContext: browsers require a user gesture first. */
  async ensureContext() {
    if (!this.context) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!this.createContext && !Ctor) {
        throw new Error('Web Audio is not available in this browser');
      }
      this.context = this.createContext ? this.createContext() : new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.context.destination);
      this.piano = new PianoSynth(this.context, this.master);
      this.guitar = new GuitarSynth(this.context, this.master);
      this.analyser = null;
    }
    // Browsers start the context suspended until a user gesture. An offline
    // context is also "suspended", but resuming it would start rendering.
    const isOffline = typeof this.context.startRendering === 'function';
    if (!isOffline && this.context.state === 'suspended') await this.context.resume();
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
    this.masterVolume = value;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.value = value;
    }
  }

  get volume() {
    return this.masterVolume;
  }

  onTick(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get currentBeat() {
    if (!this.timing) return 0;
    if (!this.playing) return this.startBeat;
    const elapsed = Math.max(0, this.context.currentTime - this.anchorTime) * this.rate;
    return this.timing.secondsToBeats(this.timing.beatsToSeconds(this.startBeat) + elapsed);
  }

  /** Length of one beat at a score position, in audio seconds at the current rate. */
  _beatAudioSeconds(beat) {
    const scoreSec = this.timing.beatsToSeconds(beat + 1) - this.timing.beatsToSeconds(beat);
    return Math.max(0.05, scoreSec) / this.rate;
  }

  setRate(rate) {
    const next = Math.max(0.25, Math.min(2, rate));
    if (next === this.rate) return this;
    const wasPlaying = this.playing;
    const beat = this.currentBeat;
    if (wasPlaying) this.stop({ silent: true });
    this.rate = next;
    if (wasPlaying) return this.play(beat);
    this._emit();
    return this;
  }

  async play(fromBeat = null) {
    const generation = this._generation + 1;
    this._generation = generation;
    await this.ensureContext();
    // A stop (or another play) issued while the context was starting wins.
    if (this._generation !== generation) return this;
    if (this.playing) this._halt();

    this.startBeat = fromBeat === null ? this.startBeat : fromBeat;
    if (this.startBeat >= this.endBeat - 1e-6) this.startBeat = 0;

    // Anchor the score to the audio clock, with a little headroom so the first
    // notes are scheduled slightly ahead rather than in the past.
    const begin = this.context.currentTime + 0.08;
    const beatSec = this._beatAudioSeconds(this.startBeat);
    const countIn = Math.max(0, Math.round(this.countInBeats));
    for (let i = 0; i < countIn; i += 1) {
      this.click(begin + i * beatSec, i === 0);
    }
    this.anchorTime = begin + countIn * beatSec;
    this.countingIn = countIn > 0;
    this._scheduledUntilSec = this.timing.beatsToSeconds(this.startBeat);
    this._scheduled.clear();
    this.playing = true;

    this._schedule();
    this._timer = setInterval(() => this._schedule(), this.tickMs);
    this._emit();
    return this;
  }

  /** One metronome click. The first beat of a bar is accented. */
  click(when, accent = false) {
    const ctx = this.context;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1100;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(when);
    osc.stop(when + 0.1);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* gone */ } };
  }

  /**
   * Play a set of pitches straight away, so the user can hear what a chord or
   * a note sounds like without starting playback. Chords are lightly strummed,
   * because a guitar chord struck perfectly simultaneously does not sound like
   * a guitar.
   */
  async audition(notes, { instrument = 'guitar', strumMs = 16 } = {}) {
    if (!notes || notes.length === 0) return this;
    await this.ensureContext();
    const now = this.context.currentTime + 0.02;
    const ordered = [...notes].sort((a, b) => (a.string ?? a.pitch) - (b.string ?? b.pitch));
    ordered.forEach((note, i) => {
      const when = now + (i * strumMs) / 1000;
      if (instrument === 'piano') {
        this.piano.strike({ pitch: note.pitch, when, duration: 1.1, velocity: note.velocity ?? 92 });
      } else {
        this.guitar.pluck({
          pitch: note.pitch,
          when,
          duration: 1.1,
          velocity: note.velocity ?? 96,
          string: note.string ?? null,
          stringCount: note.stringCount ?? 6,
        });
      }
    });
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

  /** Release every sounding voice and drop the audio graph's note nodes. */
  panic() {
    this.stop({ silent: true });
    this._emit();
    return this;
  }

  /** Tear down the transport and silence everything, without emitting. */
  _halt() {
    this.playing = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Silence sounding notes by releasing the voices themselves. An earlier
    // version ramped the master gain to zero and restored it on a timer, which
    // left the output muted for good if playback restarted before the timer
    // fired -- the master gain is never touched here for exactly that reason.
    this.piano?.allNotesOff();
    this.guitar?.allNotesOff();
    this._scheduled.clear();
    this.countingIn = false;
  }

  stop({ silent = false, rewind = false } = {}) {
    this._generation += 1; // cancels any play() still waiting on the context
    this._halt();
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
      rate: this.rate,
      countingIn: this.countingIn,
    };
    for (const listener of this._listeners) listener(state);
  }

  /**
   * Schedule everything that falls inside the look-ahead window.
   *
   * Two clocks are in play and they must not be confused: score time (seconds
   * from the start of the piece) and the AudioContext clock. `anchorTime` is
   * the one point where they meet, and every conversion goes through it.
   */
  _schedule() {
    if (!this.playing || !this.timing) return;

    const offsetSec = this.timing.beatsToSeconds(this.startBeat);
    const elapsed = Math.max(0, this.context.currentTime - this.anchorTime) * this.rate;
    const playheadSec = offsetSec + elapsed; // score time
    const untilSec = playheadSec + this.lookaheadSec * this.rate; // score time
    if (this.countingIn && this.context.currentTime >= this.anchorTime) this.countingIn = false;

    const wantMidi = this.mode === 'midi' || this.mode === 'both';
    const wantGuitar = this.mode === 'guitar' || this.mode === 'both';

    if (wantMidi) this._scheduleVoices(this.midiNotes, 'm', untilSec, offsetSec, false);
    if (wantGuitar) this._scheduleVoices(this.guitarNotes, 'g', untilSec, offsetSec, true);

    this._scheduledUntilSec = Math.max(this._scheduledUntilSec, untilSec);
    this._emit();

    const endSec = this.timing.beatsToSeconds(this.endBeat);
    if (playheadSec > endSec + 0.6) {
      if (this.loop) this.play(0);
      else this.stop({ rewind: true });
    }
  }

  _scheduleVoices(notes, prefix, untilSec, offsetSec, isGuitar) {
    const now = this.context.currentTime;

    for (const note of notes) {
      const startSec = this.timing.beatsToSeconds(note.start); // score time
      if (startSec < this._scheduledUntilSec - 1e-9) continue;
      if (startSec > untilSec) break; // notes are time-sorted

      const key = `${prefix}:${note.id ?? `${note.pitch}@${note.start}`}`;
      if (this._scheduled.has(key)) continue;
      this._scheduled.add(key);

      // Score time -> audio-clock time, slowed or sped by the practice rate.
      const when = this.anchorTime + (startSec - offsetSec) / this.rate;
      // A note whose moment has already passed is played immediately rather
      // than being dropped, so nothing goes missing after a slow frame.
      const at = Math.max(when, now + 0.005);

      const durationSec = Math.max(
        0.05,
        (this.timing.beatsToSeconds(note.start + note.duration) - startSec) / this.rate,
      );

      if (isGuitar) {
        this.guitar.pluck({
          pitch: note.pitch,
          when: at,
          duration: durationSec,
          velocity: note.velocity ?? 92,
          string: note.string ?? null,
          stringCount: note.stringCount ?? 6,
        });
      } else {
        this.piano.strike({
          pitch: note.pitch,
          when: at,
          duration: durationSec,
          velocity: note.velocity ?? 85,
        });
      }
    }
  }

  /**
   * Schedule the whole piece at once against a fixed anchor.
   * Used for offline rendering, where there is no wall clock to chase.
   */
  scheduleAll({ fromBeat = 0, anchorTime = 0 } = {}) {
    const offsetSec = this.timing.beatsToSeconds(fromBeat);
    this.anchorTime = anchorTime;
    this.startBeat = fromBeat;
    this._scheduledUntilSec = offsetSec;
    this._scheduled.clear();

    const untilSec = this.timing.beatsToSeconds(this.endBeat) + 1;
    const wantMidi = this.mode === 'midi' || this.mode === 'both';
    const wantGuitar = this.mode === 'guitar' || this.mode === 'both';
    if (wantMidi) this._scheduleVoices(this.midiNotes, 'm', untilSec, offsetSec, false);
    if (wantGuitar) this._scheduleVoices(this.guitarNotes, 'g', untilSec, offsetSec, true);
    return this;
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
