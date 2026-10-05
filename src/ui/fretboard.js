/**
 * Fretboard preview (brief section 34).
 *
 * Draws the chosen voicing as a chord diagram: dots where fingers go, open
 * circles for open strings, crosses for muted strings, a barre where one is
 * needed, and the sounding note under each string.
 */

import { pitchToName } from '../midi/normalizer.js';

const PAD = { left: 26, right: 16, top: 24, bottom: 20 };

export class FretboardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.voicing = null;
    this.tuning = null;
    this._onResize = () => this.draw();
    globalThis.addEventListener?.('resize', this._onResize);
  }

  destroy() {
    globalThis.removeEventListener?.('resize', this._onResize);
  }

  show(voicing, tuning) {
    this.voicing = voicing;
    this.tuning = tuning;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!this.voicing || !this.tuning) {
      ctx.fillStyle = '#6b7183';
      ctx.font = 'italic 11.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select a chord to see its shape', rect.width / 2, rect.height / 2);
      return;
    }

    const stringCount = this.tuning.openPitches.length;
    const frets = this.voicing.frets;
    const capo = this.tuning.capo ?? 0;

    // A chord box starts at the lowest fretted note, the way printed chord
    // charts do, so the position marker names the fret the dots are actually on.
    const fretted = frets.filter((f) => f !== null && f > capo);
    const lowest = fretted.length ? Math.min(...fretted) : 1;
    const highest = fretted.length ? Math.max(...fretted) : 1;
    const windowSize = Math.max(4, highest - lowest + 1);
    const firstFret = fretted.length ? Math.max(capo + 1, lowest) : capo + 1;
    const showNut = firstFret <= capo + 1;

    const plotW = rect.width - PAD.left - PAD.right;
    const plotH = rect.height - PAD.top - PAD.bottom;
    const stringGap = plotW / Math.max(1, stringCount - 1);
    const fretGap = plotH / windowSize;

    // Strings run vertically, highest-pitched on the right, as in a chord chart.
    const xOf = (stringIndex) => PAD.left + (stringCount - 1 - stringIndex) * stringGap;
    const yOfFret = (fret) => PAD.top + (fret - firstFret + 0.5) * fretGap;

    // Fret wires.
    for (let i = 0; i <= windowSize; i += 1) {
      const y = PAD.top + i * fretGap;
      const isNut = showNut && i === 0;
      ctx.strokeStyle = isNut ? '#9aa0b1' : '#333845';
      ctx.lineWidth = isNut ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
    }

    // Strings.
    for (let s = 0; s < stringCount; s += 1) {
      const x = xOf(s);
      ctx.strokeStyle = '#3b4150';
      ctx.lineWidth = 0.6 + (stringCount - 1 - s) * 0.18;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
    }

    // Position marker.
    if (!showNut) {
      ctx.fillStyle = '#6b7183';
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(firstFret), PAD.left - 7, yOfFret(firstFret));
    }

    // A barre, drawn behind the dots.
    const barre = this.voicing.fingering?.barre;
    if (barre) {
      const x1 = xOf(barre.fromString);
      const x2 = xOf(barre.toString);
      const y = yOfFret(barre.fret);
      ctx.strokeStyle = '#e0a458';
      ctx.lineWidth = Math.min(16, fretGap * 0.55);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(Math.min(x1, x2), y);
      ctx.lineTo(Math.max(x1, x2), y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }

    const fingerByString = new Map(
      (this.voicing.fingering?.fingers ?? []).map((f) => [f.string, f.finger]),
    );
    const dotRadius = Math.min(11, Math.min(stringGap, fretGap) * 0.36);

    for (let s = 0; s < stringCount; s += 1) {
      const fret = frets[s];
      const x = xOf(s);

      if (fret === null) {
        // Muted string: a cross above the nut.
        ctx.strokeStyle = '#6b7183';
        ctx.lineWidth = 1.6;
        const y = PAD.top - 10;
        const r = 3.6;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.stroke();
        continue;
      }

      if (fret <= capo) {
        // Open (or capoed-open) string: a ring above the nut.
        ctx.strokeStyle = '#7ec8a9';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, PAD.top - 10, 4.2, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      const y = yOfFret(fret);
      ctx.fillStyle = '#e0a458';
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();

      const finger = fingerByString.get(s);
      if (finger && dotRadius >= 7) {
        ctx.fillStyle = '#1a1206';
        ctx.font = `700 ${Math.round(dotRadius * 1.15)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(finger), x, y + 0.5);
      }
    }

    // Sounding pitch under each string.
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s < stringCount; s += 1) {
      const fret = frets[s];
      const x = xOf(s);
      if (fret === null) {
        ctx.fillStyle = '#4e5464';
        ctx.fillText('·', x, PAD.top + plotH + 5);
      } else {
        ctx.fillStyle = '#9aa0b1';
        ctx.fillText(pitchToName(this.tuning.openPitches[s] + fret), x, PAD.top + plotH + 5);
      }
    }
  }
}
