/**
 * Tempo / time-signature map.
 *
 * The brief (section 29) insists that MIDI timing stays the source of truth for
 * the whole pipeline. That only works if tick -> beat -> second conversion is
 * exact and available everywhere, so it lives in one place here.
 *
 * Two clocks matter and they are not interchangeable:
 *   - musical time (beats): what rhythm, bars and tab columns are built from.
 *   - wall-clock time (seconds): what the note clusterer needs, because a
 *     "40 ms" grouping window is a statement about the pianist's hands, not
 *     about the score.
 */

const DEFAULT_MICROSECONDS_PER_BEAT = 500000; // 120 bpm

export class TimingMap {
  /**
   * @param {object} midi parsed SMF (from parser.js)
   */
  constructor(midi) {
    this.ticksPerBeat = midi.ticksPerBeat;
    this.division = midi.division;
    this.tempoEvents = [];
    this.timeSignatures = [];
    this.keySignatures = [];

    for (const track of midi.tracks) {
      for (const event of track.events) {
        if (event.kind !== 'meta') continue;
        if (event.subtype === 'setTempo') {
          this.tempoEvents.push({
            tick: event.tick,
            microsecondsPerBeat: event.microsecondsPerBeat || DEFAULT_MICROSECONDS_PER_BEAT,
            bpm: event.bpm,
          });
        } else if (event.subtype === 'timeSignature') {
          this.timeSignatures.push({
            tick: event.tick,
            numerator: event.numerator || 4,
            denominator: event.denominator || 4,
          });
        } else if (event.subtype === 'keySignature') {
          this.keySignatures.push({
            tick: event.tick,
            sharpsFlats: event.sharpsFlats,
            scale: event.scale,
            name: event.name,
          });
        }
      }
    }

    this.tempoEvents.sort((a, b) => a.tick - b.tick);
    this.timeSignatures.sort((a, b) => a.tick - b.tick);
    this.keySignatures.sort((a, b) => a.tick - b.tick);

    if (this.tempoEvents.length === 0 || this.tempoEvents[0].tick > 0) {
      this.tempoEvents.unshift({
        tick: 0,
        microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT,
        bpm: 120,
      });
    }
    if (this.timeSignatures.length === 0 || this.timeSignatures[0].tick > 0) {
      this.timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
    }

    // Deduplicate tempo changes sharing a tick (last one at a tick wins).
    this.tempoEvents = this.tempoEvents.filter(
      (t, i, arr) => i === arr.length - 1 || arr[i + 1].tick !== t.tick,
    );

    this._buildSecondsIndex();
  }

  _buildSecondsIndex() {
    // Cumulative seconds at each tempo change, so lookups are O(log n).
    let seconds = 0;
    this._index = this.tempoEvents.map((tempo, i) => {
      if (i > 0) {
        const prev = this.tempoEvents[i - 1];
        const deltaTicks = tempo.tick - prev.tick;
        seconds += (deltaTicks / this.ticksPerBeat) * (prev.microsecondsPerBeat / 1e6);
      }
      return { tick: tempo.tick, seconds, microsecondsPerBeat: tempo.microsecondsPerBeat };
    });
  }

  _tempoAt(tick) {
    let lo = 0;
    let hi = this._index.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._index[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this._index[lo];
  }

  /** Musical position in beats (quarter notes). */
  ticksToBeats(tick) {
    return tick / this.ticksPerBeat;
  }

  beatsToTicks(beats) {
    return beats * this.ticksPerBeat;
  }

  /** Wall-clock position in seconds, honouring every tempo change. */
  ticksToSeconds(tick) {
    if (this.division.type === 'smpte') {
      const { framesPerSecond, ticksPerFrame } = this.division;
      return tick / (framesPerSecond * ticksPerFrame);
    }
    const tempo = this._tempoAt(tick);
    return tempo.seconds + ((tick - tempo.tick) / this.ticksPerBeat) * (tempo.microsecondsPerBeat / 1e6);
  }

  beatsToSeconds(beats) {
    return this.ticksToSeconds(this.beatsToTicks(beats));
  }

  secondsToBeats(seconds) {
    // Walk the tempo index forward; tempo maps are short so this stays cheap.
    let entry = this._index[0];
    for (let i = 1; i < this._index.length; i += 1) {
      if (this._index[i].seconds > seconds) break;
      entry = this._index[i];
    }
    const delta = seconds - entry.seconds;
    const beats = delta / (entry.microsecondsPerBeat / 1e6);
    return this.ticksToBeats(entry.tick) + beats;
  }

  tempoAtBeat(beats) {
    const tempo = this._tempoAt(this.beatsToTicks(beats));
    return 60000000 / tempo.microsecondsPerBeat;
  }

  get initialTempo() {
    return this.tempoEvents[0].bpm ?? 60000000 / this.tempoEvents[0].microsecondsPerBeat;
  }

  timeSignatureAt(beats) {
    const tick = this.beatsToTicks(beats);
    let current = this.timeSignatures[0];
    for (const ts of this.timeSignatures) {
      if (ts.tick <= tick + 1e-6) current = ts;
      else break;
    }
    return current;
  }

  get initialTimeSignature() {
    const ts = this.timeSignatures[0];
    return { numerator: ts.numerator, denominator: ts.denominator };
  }

  /** Beats per bar at a given musical position. */
  beatsPerBarAt(beats) {
    const ts = this.timeSignatureAt(beats);
    return ts.numerator * (4 / ts.denominator);
  }

  /**
   * Bar lines covering [0, endBeats], as absolute beat positions.
   * Time-signature changes mid-piece are handled.
   */
  barLines(endBeats) {
    const lines = [];
    let beat = 0;
    let guard = 0;
    while (beat <= endBeats + 1e-9 && guard < 100000) {
      lines.push(beat);
      beat += this.beatsPerBarAt(beat);
      guard += 1;
    }
    return lines;
  }

  /** 1-based bar number and the beat offset inside that bar. */
  barAndBeat(beats) {
    let bar = 1;
    let cursor = 0;
    let guard = 0;
    while (guard < 100000) {
      const span = this.beatsPerBarAt(cursor);
      if (cursor + span > beats + 1e-9) return { bar, beat: beats - cursor, barStart: cursor, barLength: span };
      cursor += span;
      bar += 1;
      guard += 1;
    }
    return { bar, beat: 0, barStart: cursor, barLength: this.beatsPerBarAt(cursor) };
  }
}

export { DEFAULT_MICROSECONDS_PER_BEAT };
