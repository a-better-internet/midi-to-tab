/**
 * Piano-roll view (brief section 33).
 *
 * Shows the source MIDI as it really is, with the analysis drawn on top: notes
 * coloured by the musical role the engine assigned them, and detected chord
 * regions banded and labelled behind them. That is what makes the engine's
 * reasoning inspectable instead of a black box.
 */

import { pitchToName } from '../midi/normalizer.js';
import { ROLES } from '../analysis/noteRoleClassifier.js';

const ROLE_COLORS = {
  [ROLES.BASS]: '#5b9bd5',
  [ROLES.ROOT]: '#7ec8a9',
  [ROLES.CHORD_TONE]: '#6fb3a0',
  [ROLES.EXTENSION]: '#b490d8',
  [ROLES.MELODY]: '#e0a458',
  [ROLES.ARPEGGIO]: '#d98cb3',
  [ROLES.PASSING_TONE]: '#c8707a',
  [ROLES.APPROACH_TONE]: '#c8707a',
  [ROLES.ORNAMENT]: '#7d8496',
  [ROLES.UNKNOWN]: '#6b7183',
};

export const ROLE_LEGEND = [
  [ROLES.BASS, 'Bass'],
  [ROLES.ROOT, 'Root'],
  [ROLES.CHORD_TONE, 'Chord tone'],
  [ROLES.EXTENSION, 'Extension'],
  [ROLES.MELODY, 'Melody'],
  [ROLES.ARPEGGIO, 'Arpeggio'],
  [ROLES.PASSING_TONE, 'Passing / approach'],
  [ROLES.ORNAMENT, 'Ornament'],
].map(([role, label]) => ({ role, label, color: ROLE_COLORS[role] }));

const PAD = { left: 38, right: 10, top: 20, bottom: 16 };

export class PianoRoll {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [handlers]
   * @param {(beat:number)=>void} [handlers.onSeek]
   * @param {(eventId:number|null)=>void} [handlers.onSelect]
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    this.result = null;
    this.playhead = 0;
    this.selectedEventId = null;
    this.hoverBeat = null;

    this._onResize = () => this.draw();
    globalThis.addEventListener?.('resize', this._onResize);

    canvas.addEventListener('pointerdown', (e) => this._onPointer(e, true));
    canvas.addEventListener('pointermove', (e) => this._onPointer(e, false));
    canvas.addEventListener('pointerleave', () => {
      this.hoverBeat = null;
      this.draw();
    });
  }

  destroy() {
    globalThis.removeEventListener?.('resize', this._onResize);
  }

  setResult(result) {
    this.result = result;
    this._computeRange();
    this.draw();
  }

  setPlayhead(beat) {
    this.playhead = beat;
    this.draw();
  }

  setSelected(eventId) {
    this.selectedEventId = eventId;
    this.draw();
  }

  _computeRange() {
    const notes = this.result?.sourceNotes ?? [];
    if (notes.length === 0) {
      this.range = { minPitch: 48, maxPitch: 72, endBeat: 4 };
      return;
    }
    const pitches = notes.map((n) => n.pitch);
    const minPitch = Math.min(...pitches);
    const maxPitch = Math.max(...pitches);
    const span = Math.max(14, maxPitch - minPitch);
    const pad = Math.max(2, Math.round((span - (maxPitch - minPitch)) / 2) + 1);
    this.range = {
      minPitch: minPitch - pad,
      maxPitch: maxPitch + pad,
      endBeat: Math.max(1, this.result.tab?.totalBeats ?? Math.max(...notes.map((n) => n.end))),
    };
  }

  _geometry() {
    const { width, height } = this.canvas.getBoundingClientRect();
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const plotW = Math.max(1, w - PAD.left - PAD.right);
    const plotH = Math.max(1, h - PAD.top - PAD.bottom);
    const { minPitch, maxPitch, endBeat } = this.range;
    const pitchCount = Math.max(1, maxPitch - minPitch + 1);
    return {
      w, h, plotW, plotH, minPitch, maxPitch, endBeat, pitchCount,
      rowH: plotH / pitchCount,
      beatW: plotW / endBeat,
      xOf: (beat) => PAD.left + (beat / endBeat) * plotW,
      yOf: (pitch) => PAD.top + (maxPitch - pitch) * (plotH / pitchCount),
      beatAt: (x) => Math.max(0, Math.min(endBeat, ((x - PAD.left) / plotW) * endBeat)),
    };
  }

  _onPointer(event, isClick) {
    if (!this.result) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const g = this._geometry();
    const beat = g.beatAt(x);
    this.hoverBeat = beat;

    if (isClick) {
      // Clicking a note selects its event; clicking empty space seeks.
      const pitch = Math.round(g.maxPitch - (y - PAD.top) / g.rowH);
      const hit = this.result.sourceNotes.find(
        (n) => Math.abs(n.pitch - pitch) <= 0 && beat >= n.start - 0.03 && beat <= n.end + 0.03,
      );
      if (hit) {
        const owner = this.result.analysis.events.find((e) => e.noteIds.includes(hit.id));
        this.handlers.onSelect?.(owner ? owner.id : null);
      } else {
        this.handlers.onSeek?.(beat);
      }
    }
    this.draw();
  }

  draw() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!ctx) return;

    const dpr = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.fillStyle = '#12131a';
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (!this.result || this.result.sourceNotes.length === 0) {
      ctx.fillStyle = '#6b7183';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No notes to show', rect.width / 2, rect.height / 2);
      return;
    }

    const g = this._geometry();
    const timing = this.result.analysis.notes.length ? this.result.tab.timing : null;

    this._drawPitchGrid(ctx, g);
    if (timing) this._drawBars(ctx, g, timing);
    this._drawChordRegions(ctx, g);
    this._drawNotes(ctx, g);
    this._drawPlayhead(ctx, g);
  }

  _drawPitchGrid(ctx, g) {
    const blackKeys = new Set([1, 3, 6, 8, 10]);
    for (let pitch = g.minPitch; pitch <= g.maxPitch; pitch += 1) {
      const y = g.yOf(pitch);
      const isBlack = blackKeys.has(((pitch % 12) + 12) % 12);
      ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.016)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(PAD.left, y, g.plotW, g.rowH);

      // Label every C, plus the extremes, when there is room.
      if (pitch % 12 === 0 && g.rowH > 5) {
        ctx.fillStyle = '#6b7183';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(pitchToName(pitch), PAD.left - 5, y + g.rowH / 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.moveTo(PAD.left, y + g.rowH);
        ctx.lineTo(PAD.left + g.plotW, y + g.rowH);
        ctx.stroke();
      }
    }
  }

  _drawBars(ctx, g, timing) {
    const lines = timing.barLines(g.endBeat);
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((beat, i) => {
      const x = g.xOf(beat);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + g.plotH);
      ctx.stroke();
      if (i < lines.length - 1) {
        ctx.fillStyle = '#4e5464';
        ctx.fillText(String(i + 1), x + 3, PAD.top + g.plotH + 3);
      }
    });
  }

  _drawChordRegions(ctx, g) {
    const regions = this.result.analysis.regions ?? [];
    regions.forEach((region, i) => {
      const x0 = g.xOf(region.start);
      const x1 = g.xOf(Math.min(region.end, g.endBeat));
      const width = Math.max(1, x1 - x0);
      const confidence = region.confidence ?? 0;

      // Alternating tint so adjacent regions are visually distinct.
      ctx.fillStyle = i % 2 === 0 ? 'rgba(224,164,88,0.055)' : 'rgba(224,164,88,0.028)';
      ctx.fillRect(x0, PAD.top, width, g.plotH);

      ctx.strokeStyle = 'rgba(224,164,88,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, PAD.top);
      ctx.lineTo(x0, PAD.top + g.plotH);
      ctx.stroke();

      if (!region.chord || width < 18) return;
      const low = confidence < 0.6;
      ctx.fillStyle = low ? '#d4717d' : '#e0a458';
      ctx.font = `600 ${width < 40 ? 9 : 10.5}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const label = region.chord.symbol + (region.overridden ? ' *' : '');
      ctx.fillText(label, x0 + 3, 4);
      if (width > 56) {
        ctx.fillStyle = '#6b7183';
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(`${Math.round(confidence * 100)}%`, x0 + 4 + ctx.measureText(label).width + 10, 5);
      }
    });
  }

  _drawNotes(ctx, g) {
    const roles = this.result.analysis.roles;
    const selected = this.selectedEventId;
    const selectedIds = selected === null ? null
      : new Set(this.result.analysis.events.find((e) => e.id === selected)?.noteIds ?? []);

    for (const note of this.result.sourceNotes) {
      const x = g.xOf(note.start);
      const w = Math.max(2, g.xOf(note.end) - x - 0.5);
      const y = g.yOf(note.pitch);
      const h = Math.max(2, g.rowH - 1);

      const role = roles?.get(note.id);
      const color = ROLE_COLORS[role?.role] ?? ROLE_COLORS[ROLES.UNKNOWN];
      const isSelected = selectedIds?.has(note.id);
      const velocity = 0.45 + 0.55 * ((note.velocity ?? 80) / 127);

      ctx.globalAlpha = isSelected ? 1 : velocity;
      ctx.fillStyle = color;
      ctx.beginPath();
      const radius = Math.min(2.5, h / 2.5);
      ctx.roundRect(x, y + 0.5, w, h, radius);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  }

  _drawPlayhead(ctx, g) {
    if (this.hoverBeat !== null) {
      const hx = g.xOf(this.hoverBeat);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, PAD.top);
      ctx.lineTo(hx, PAD.top + g.plotH);
      ctx.stroke();
    }

    const x = g.xOf(Math.max(0, Math.min(this.playhead, g.endBeat)));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top - 4);
    ctx.lineTo(x, PAD.top + g.plotH);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x - 4, PAD.top - 8);
    ctx.lineTo(x + 4, PAD.top - 8);
    ctx.lineTo(x, PAD.top - 2);
    ctx.closePath();
    ctx.fill();
  }
}
