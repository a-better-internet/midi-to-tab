/**
 * Confidence read-out, chord correction and voicing choice
 * (brief sections 31, 32, 34).
 *
 * Selecting an event shows exactly what the engine saw, what it decided, how
 * sure it was, and what it nearly decided instead -- and lets the user overrule
 * any of it. Changing a chord regenerates the voicing; changing a voicing
 * leaves the harmony alone.
 */

import { pitchToName } from '../midi/normalizer.js';
import { intervalName } from '../analysis/noteRoleClassifier.js';
import { CHORD_TEMPLATES, pcName } from '../analysis/chordRecognizer.js';
import { formatShape } from '../guitar/voicingGenerator.js';

/** The quick-pick list of section 32, built around the detected root. */
const QUICK_TEMPLATES = ['maj', 'min', '7', 'maj7', 'm7', 'sus4', 'sus2', 'add9', '6', 'dim', 'aug', 'm7b5'];

export class ChordEditor {
  /**
   * @param {object} elements
   * @param {HTMLElement} elements.detail
   * @param {HTMLElement} elements.candidates
   * @param {HTMLElement} elements.quickPick
   * @param {HTMLElement} elements.voicings
   * @param {object} handlers
   * @param {(regionIndex:number, chord:object)=>void} handlers.onChordChange
   * @param {(eventId:number, voicing:object)=>void} handlers.onVoicingChange
   */
  constructor(elements, handlers = {}) {
    this.el = elements;
    this.handlers = handlers;
    this.result = null;
    this.eventId = null;
  }

  setResult(result) {
    this.result = result;
    if (this.eventId !== null) this.select(this.eventId);
  }

  clear() {
    this.eventId = null;
    this.el.detail.textContent = '';
    this.el.candidates.textContent = '';
    this.el.quickPick.textContent = '';
    this.el.voicings.textContent = '';
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'Click a chord in the tab or a note in the piano roll to inspect it.';
    this.el.detail.append(note);
  }

  get selectedItem() {
    if (!this.result || this.eventId === null) return null;
    return this.result.transcribed.find((t) => t.event.id === this.eventId) ?? null;
  }

  select(eventId) {
    this.eventId = eventId;
    const item = this.selectedItem;
    if (!item) {
      this.clear();
      return;
    }
    this._renderDetail(item);
    this._renderCandidates(item);
    this._renderQuickPick(item);
    this._renderVoicings(item);
  }

  _renderDetail(item) {
    const { event, voicing } = item;
    const host = this.el.detail;
    host.textContent = '';

    const rows = document.createElement('div');
    rows.className = 'rows';

    const addRow = (key, value, className = '') => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = `v ${className}`;
      v.textContent = value;
      row.append(k, v);
      rows.append(row);
    };

    const chord = event.chord;
    addRow('Interpretation', chord ? chord.symbol : 'single note');
    if (chord) {
      addRow('Quality', chord.quality);
      addRow('Root / bass', `${chord.rootName} / ${chord.bassName}`);
      if (chord.inversion > 0) addRow('Inversion', chord.inversionName);
      addRow('Confidence', `${Math.round((event.confidence ?? 0) * 100)}%`,
        event.confidence >= 0.8 ? 'ok' : event.confidence >= 0.6 ? 'warn' : 'bad');
      if (event.roman) addRow('Function', `${event.roman} in ${this.result.stats.key.name}`);
      if (chord.missing?.length) {
        addRow('Implied', chord.missing.map((pc) => pcName(pc, { flats: this.result.stats.key.preferFlats })).join(' '));
      }
    }

    addRow('Position', `bar ${this._barLabel(item)}`);
    addRow('Duration', `${event.duration.toFixed(3)} beats`);
    if (event.spreadMs > 1) addRow('Onset spread', `${event.spreadMs.toFixed(1)} ms`);
    if (event.arpeggio) addRow('Figure', `${event.arpeggio.contour} arpeggio`);

    if (voicing) {
      addRow('Shape', formatShape(voicing));
      addRow('Strings used', `${voicing.stringsUsed} of ${this.result.tuning.stringCount}`);
      if (voicing.fretSpan > 0) addRow('Fret span', `${voicing.fretSpan} (position ${voicing.position})`);
      const fingering = voicing.fingering;
      if (fingering) {
        addRow('Playability', fingering.playable
          ? `${fingering.fingersUsed} finger${fingering.fingersUsed === 1 ? '' : 's'}${fingering.barre ? ', barre' : ''}`
          : fingering.issues.join('; '),
        fingering.playable ? 'ok' : 'bad');
      }
      if (item.outOfPosition) addRow('Note', 'outside the requested neck region', 'warn');
    }
    host.append(rows);

    // The detected notes, with the role each was given (section 31).
    const heading = document.createElement('div');
    heading.className = 'detail-row';
    heading.innerHTML = '<span class="k">Detected notes</span>';
    host.append(heading);

    const chips = document.createElement('div');
    chips.className = 'chip-row';
    for (const note of event.notes) {
      const chip = document.createElement('span');
      chip.className = `chip role-${note.role}`;
      const degree = note.interval !== null && note.interval !== undefined
        ? ` ${intervalName(note.interval)}` : '';
      chip.textContent = `${pitchToName(note.pitch)}${degree}`;
      chip.title = `${note.role}${note.reason ? ` — ${note.reason}` : ''}`;
      chips.append(chip);
    }
    host.append(chips);
  }

  _barLabel(item) {
    const column = this.result.tab.columns.find((c) => c.eventId === item.event.id);
    return column ? column.metric.label : '-';
  }

  _renderCandidates(item) {
    const host = this.el.candidates;
    host.textContent = '';
    const region = this.result.analysis.regions.find((r) => r.index === item.event.regionIndex);
    const candidates = region ? region.candidates : item.event.candidates ?? [];

    if (!region || candidates.length === 0) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = 'This event is a single note, so there is no chord to reinterpret.';
      host.append(note);
      return;
    }

    candidates.slice(0, 6).forEach((candidate) => {
      const button = document.createElement('button');
      button.className = 'candidate';
      if (candidate.symbol === region.chord?.symbol) button.classList.add('active');

      const symbol = document.createElement('span');
      symbol.className = 'sym';
      symbol.textContent = candidate.symbol;

      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(candidate.confidence * 100)}%`;
      bar.append(fill);

      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = `${Math.round(candidate.confidence * 100)}%`;

      button.append(symbol, bar, pct);
      button.title = [
        candidate.quality,
        candidate.inversion > 0 ? candidate.inversionName : null,
        candidate.extras?.length ? `extra: ${candidate.extras.map((pc) => pcName(pc)).join(' ')}` : null,
      ].filter(Boolean).join(' · ');

      button.addEventListener('click', () => {
        this.handlers.onChordChange?.(region.index, candidate);
      });
      host.append(button);
    });
  }

  _renderQuickPick(item) {
    const host = this.el.quickPick;
    host.textContent = '';
    const region = this.result.analysis.regions.find((r) => r.index === item.event.regionIndex);
    if (!region || !region.chord) return;

    const root = region.chord.root;
    const flats = this.result.stats.key.preferFlats;

    for (const id of QUICK_TEMPLATES) {
      const template = CHORD_TEMPLATES.find((t) => t.id === id);
      if (!template) continue;
      const symbol = `${pcName(root, { flats })}${template.suffix}`;
      const button = document.createElement('button');
      button.className = 'chip';
      button.type = 'button';
      button.textContent = symbol;
      if (region.chord.templateId === id && region.chord.bass === root) button.classList.add('active');
      button.addEventListener('click', () => {
        // Build a chord object by hand: this is the user's call, so it is
        // asserted with full confidence rather than scored.
        this.handlers.onChordChange?.(region.index, {
          root,
          templateId: id,
          quality: template.name,
          suffix: template.suffix,
          intervals: template.intervals,
          bass: root,
          inversion: 0,
          inversionName: 'root position',
          symbol,
          rootName: pcName(root, { flats }),
          bassName: pcName(root, { flats }),
          present: template.intervals.map((i) => (root + i) % 12),
          missing: [],
          extras: [],
          confidence: 1,
          manual: true,
        });
      });
      host.append(button);
    }
  }

  _renderVoicings(item) {
    const host = this.el.voicings;
    host.textContent = '';
    const options = [
      { voicing: item.voicing, score: item.score, current: true },
      ...item.alternatives.map((a) => ({ ...a, current: false })),
    ];

    if (options.length <= 1) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = 'No alternative shapes fit the current settings.';
      host.append(note);
      return;
    }

    options.slice(0, 8).forEach((option) => {
      const button = document.createElement('button');
      button.className = 'voicing-option';
      if (option.current) button.classList.add('active');

      const shape = document.createElement('span');
      shape.className = 'shape';
      shape.textContent = formatShape(option.voicing);

      const tag = document.createElement('span');
      tag.className = 'tag';
      const fingering = option.voicing.fingering;
      tag.textContent = [
        option.voicing.fretSpan > 0 ? `pos ${option.voicing.position}` : 'open',
        `${option.voicing.stringsUsed} str`,
        fingering?.barre ? 'barre' : null,
      ].filter(Boolean).join(' · ');

      button.append(shape, tag);
      button.title = `score ${(option.score ?? 0).toFixed(3)}`;
      button.addEventListener('click', () => {
        this.handlers.onVoicingChange?.(item.event.id, option.voicing);
      });
      host.append(button);
    });
  }
}
