/**
 * Fretboard model (brief section 20).
 *
 * Maps MIDI pitches to every string/fret location that can produce them, which
 * is the raw material the voicing generator searches over.
 */

import { pitchToName } from '../midi/normalizer.js';

export const DEFAULT_FRET_COUNT = 22;

export class Fretboard {
  /**
   * @param {object} tuning resolved tuning (from resolveTuning)
   * @param {object} [options]
   * @param {number} [options.fretCount=22]
   */
  constructor(tuning, options = {}) {
    this.tuning = tuning;
    this.fretCount = options.fretCount ?? DEFAULT_FRET_COUNT;
    this.openPitches = tuning.openPitches;
    this.stringCount = tuning.openPitches.length;
    this.capo = tuning.capo ?? 0;

    // positionsByPitch[pitch] = [{ string, fret, pitch, isOpen }]
    this._positions = new Map();
    for (let string = 0; string < this.stringCount; string += 1) {
      const open = this.openPitches[string];
      for (let fret = 0; fret <= this.fretCount; fret += 1) {
        const pitch = open + fret;
        if (!this._positions.has(pitch)) this._positions.set(pitch, []);
        this._positions.get(pitch).push({ string, fret, pitch, isOpen: fret === 0 });
      }
    }

    this.lowestPitch = Math.min(...this.openPitches);
    this.highestPitch = Math.max(...this.openPitches.map((p) => p + this.fretCount));
  }

  /** Every way to play a pitch. Ordered lowest string first (as section 20 lists them). */
  positionsFor(pitch) {
    return this._positions.get(pitch) ?? [];
  }

  /** Can this instrument produce the pitch at all? */
  canPlay(pitch) {
    return this._positions.has(pitch);
  }

  /** Every location whose pitch is in the given pitch class. */
  positionsForPitchClass(pc, { minFret = 0, maxFret = this.fretCount } = {}) {
    const target = ((pc % 12) + 12) % 12;
    const out = [];
    for (let string = 0; string < this.stringCount; string += 1) {
      for (let fret = minFret; fret <= maxFret; fret += 1) {
        const pitch = this.openPitches[string] + fret;
        if (((pitch % 12) + 12) % 12 === target) out.push({ string, fret, pitch, isOpen: fret === 0 });
      }
    }
    return out;
  }

  pitchAt(string, fret) {
    if (string < 0 || string >= this.stringCount) return null;
    if (fret < 0 || fret > this.fretCount) return null;
    return this.openPitches[string] + fret;
  }

  noteNameAt(string, fret, options) {
    const pitch = this.pitchAt(string, fret);
    return pitch === null ? null : pitchToName(pitch, options);
  }

  /**
   * Fold a pitch into the instrument's range by octaves (section 26: the guitar
   * has a narrower range than a piano, so register must sometimes give way to
   * harmonic identity).
   *
   * @returns {{pitch:number, octaveShift:number}|null}
   */
  foldIntoRange(pitch) {
    if (this.canPlay(pitch)) return { pitch, octaveShift: 0 };
    let shift = 0;
    let candidate = pitch;
    while (candidate < this.lowestPitch && shift < 6) { candidate += 12; shift += 1; }
    while (candidate > this.highestPitch && shift > -6) { candidate -= 12; shift -= 1; }
    if (this.canPlay(candidate)) return { pitch: candidate, octaveShift: shift };
    // Land on the nearest playable pitch of the same pitch class.
    const pc = ((pitch % 12) + 12) % 12;
    const all = this.positionsForPitchClass(pc);
    if (all.length === 0) return null;
    let best = all[0];
    for (const p of all) if (Math.abs(p.pitch - pitch) < Math.abs(best.pitch - pitch)) best = p;
    return { pitch: best.pitch, octaveShift: Math.round((best.pitch - pitch) / 12) };
  }

  /** Human-readable dump, used by the fretboard preview and tests. */
  describe() {
    return {
      tuning: this.tuning.name,
      strings: this.tuning.stringNames,
      frets: this.fretCount,
      capo: this.capo,
      range: `${pitchToName(this.lowestPitch)}-${pitchToName(this.highestPitch)}`,
    };
  }
}

/**
 * Position windows for the user-facing Guitar Position control (section 30).
 * `null` means the optimizer may roam.
 */
export const POSITION_WINDOWS = {
  open: { minFret: 0, maxFret: 4, label: 'Open Position' },
  low: { minFret: 0, maxFret: 7, label: 'Low Neck' },
  mid: { minFret: 5, maxFret: 12, label: 'Mid Neck' },
  high: { minFret: 9, maxFret: 17, label: 'High Neck' },
  auto: { minFret: 0, maxFret: null, label: 'Automatic' },
};
