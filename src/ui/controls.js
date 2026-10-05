/**
 * The interpretation controls of brief section 30, plus instrument setup and
 * track selection.
 *
 * Deliberately a small number of meaningful controls rather than every internal
 * weight. The analysis knobs that are genuinely useful to a user -- the
 * grouping window and how much the progression model may override local
 * evidence -- are exposed; the rest stay in the engine's defaults.
 */

import { TUNINGS, parseCustomTuning } from '../guitar/tuning.js';

const TRANSCRIPTION_MODES = [
  ['literal', 'Literal', 'Voice every pitch the pianist played'],
  ['balanced', 'Balanced', 'Keep the harmony and melody, drop decoration'],
  ['playable', 'Playable', 'Favour shapes that are comfortable to play'],
];

const COMPLEXITY = [
  ['basic', 'Basic', 'Triads only'],
  ['extended', 'Extended', 'Sevenths and ninths'],
  ['exact', 'Exact', 'Every chord in the vocabulary'],
];

const POSITIONS = [
  ['auto', 'Auto'],
  ['open', 'Open'],
  ['low', 'Low'],
  ['mid', 'Mid'],
  ['high', 'High'],
];

const EXTENSIONS = [
  ['triads', 'Triads only'],
  ['sevenths', '7ths'],
  ['ninths', '7ths + 9ths'],
  ['all', 'All detected extensions'],
];

const SPANS = [3, 4, 5, 6];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Controls {
  /**
   * @param {HTMLElement} container
   * @param {(patch:object)=>void} onChange
   */
  constructor(container, onChange) {
    this.container = container;
    this.onChange = onChange;
    this.settings = null;
    this.trackAnalysis = null;
    this.score = null;
  }

  setState({ settings, trackAnalysis, score, source }) {
    this.settings = settings;
    this.trackAnalysis = trackAnalysis;
    this.score = score;
    this.source = source;
    this.render();
  }

  _emit(patch) {
    this.onChange?.(patch);
  }

  _segmented(label, options, value, key, hint) {
    const field = el('div', 'field');
    const labelEl = el('label', null, label);
    if (hint) labelEl.append(el('span', 'hint', hint));
    field.append(labelEl);

    const group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [optionValue, optionLabel, title] of options) {
      const button = el('button', null, optionLabel);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(optionValue === value));
      if (title) button.title = title;
      button.addEventListener('click', () => this._emit({ [key]: optionValue }));
      group.append(button);
    }
    field.append(group);
    return field;
  }

  _select(label, options, value, key, { hint, parse = (v) => v } = {}) {
    const field = el('div', 'field');
    const labelEl = el('label', null, label);
    if (hint) labelEl.append(el('span', 'hint', hint));
    field.append(labelEl);

    const select = el('select');
    select.setAttribute('aria-label', label);
    for (const [optionValue, optionLabel] of options) {
      const option = el('option', null, optionLabel);
      option.value = String(optionValue);
      if (String(optionValue) === String(value)) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => this._emit({ [key]: parse(select.value) }));
    field.append(select);
    return field;
  }

  _toggle(label, value, key, title) {
    const wrapper = el('label', 'switch');
    wrapper.append(el('span', null, label));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    if (title) wrapper.title = title;
    input.addEventListener('change', () => this._emit({ [key]: input.checked }));
    wrapper.append(input);
    const field = el('div', 'field');
    field.append(wrapper);
    return field;
  }

  _slider(label, { min, max, step, value, key, format }) {
    const field = el('div', 'field');
    const labelEl = el('label', null, label);
    labelEl.append(el('span', 'hint', format(value)));
    field.append(labelEl);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const update = () => {
      labelEl.querySelector('.hint').textContent = format(Number(input.value));
    };
    input.addEventListener('input', update);
    input.addEventListener('change', () => this._emit({ [key]: Number(input.value) }));
    field.append(input);
    return field;
  }

  _card(title, children, count) {
    const card = el('div', 'card');
    const heading = el('h2', null, title);
    if (count !== undefined) heading.append(el('span', 'count', count));
    card.append(heading);
    const body = el('div', 'card-body');
    for (const child of children) if (child) body.append(child);
    card.append(body);
    return card;
  }

  render() {
    const container = this.container;

    // The panel is rebuilt wholesale on every change, which is simple and fast
    // but would otherwise throw away the user's focus and scroll position in
    // the middle of adjusting something. Both are restored afterwards.
    const active = document.activeElement;
    const focusKey = active && container.contains(active)
      ? active.getAttribute('aria-label') || active.textContent
      : null;
    const scrollTop = container.parentElement?.scrollTop ?? 0;

    container.textContent = '';
    if (!this.settings) return;
    const s = this.settings;

    // ------------------------------------------------------------- source
    if (this.trackAnalysis && this.score) {
      const children = [];
      const usable = this.trackAnalysis.tracks.filter((t) => t.noteCount > 0);

      const modeField = this._select('Source', [
        ['single', 'One track'],
        ['all-harmonic', 'All harmonic tracks'],
        ['all', 'Everything except drums'],
      ], this.source?.mode ?? 'single', 'sourceMode');
      children.push(modeField);

      if ((this.source?.mode ?? 'single') === 'single') {
        const list = el('div', 'status-list');
        for (const track of usable) {
          const row = el('div', `track-row${track.isDrumTrack ? ' drums' : ''}`);
          const selected = (this.source?.trackIndices ?? []).includes(track.index);
          if (selected) row.classList.add('selected');

          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'source-track';
          radio.checked = selected;
          radio.disabled = track.isDrumTrack;
          radio.addEventListener('change', () => {
            this._emit({ sourceTrack: track.index });
          });

          const name = el('span', 'name',
            track.name || track.instrumentName || `Track ${track.index}`);
          const role = el('span', 'role', track.isDrumTrack ? 'drums' : track.role);

          row.append(radio, name, role);
          row.title = `${track.noteCount} notes · keyboard likelihood ${(track.keyboardScore * 100).toFixed(0)}%`;
          if (!track.isDrumTrack) {
            row.addEventListener('click', () => this._emit({ sourceTrack: track.index }));
          }
          list.append(row);
        }
        children.push(list);
      }

      if (this.trackAnalysis.split) {
        const note = el('p', 'empty-note',
          'The keyboard part may be split across several tracks — try "All harmonic tracks".');
        children.push(note);
      }

      container.append(this._card('Source', children, this.trackAnalysis.summary ? '' : undefined));
    }

    // ----------------------------------------------------- interpretation
    container.append(this._card('Interpretation', [
      this._segmented('Transcription mode', TRANSCRIPTION_MODES, s.transcriptionMode, 'transcriptionMode'),
      this._segmented('Chord complexity', COMPLEXITY, s.chordComplexity, 'chordComplexity'),
      this._select('Include extensions', EXTENSIONS, s.includeExtensions, 'includeExtensions'),
      this._toggle('Preserve piano voicing', s.preservePianoVoicing, 'preservePianoVoicing',
        'Keep the guitar shape as close to the original register and spacing as possible'),
      this._toggle('Detect arpeggios', s.detectArpeggios, 'detectArpeggios',
        'Read a run of single notes outlining one chord as a single harmony'),
    ]));

    // ------------------------------------------------------------ guitar
    const tuningOptions = [
      ...TUNINGS.map((t) => [t.id, t.name]),
      ['custom', 'Custom…'],
    ];
    const guitarChildren = [
      this._select('Tuning', tuningOptions, s.tuning, 'tuning'),
    ];

    if (s.tuning === 'custom') {
      const field = el('div', 'field');
      field.append(el('label', null, 'Custom tuning (low to high)'));
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'D A D G A D';
      input.value = (s.customTuning?.strings ?? []).join(' ');
      input.setAttribute('aria-label', 'Custom tuning');
      const apply = () => {
        const parsed = parseCustomTuning(input.value);
        input.style.borderColor = parsed ? '' : 'var(--bad)';
        if (parsed) this._emit({ customTuning: parsed });
      };
      input.addEventListener('change', apply);
      field.append(input);
      guitarChildren.push(field);
    }

    guitarChildren.push(
      this._segmented('Neck position', POSITIONS, s.guitarPosition, 'guitarPosition'),
      this._select('Maximum fret span', SPANS.map((n) => [n, `${n} frets`]), s.maxFretSpan, 'maxFretSpan',
        { parse: Number }),
      this._slider('Capo', {
        min: 0, max: 7, step: 1, value: s.capo, key: 'capo',
        format: (v) => (v === 0 ? 'none' : `fret ${v}`),
      }),
      this._select('Frets', [18, 20, 22, 24].map((n) => [n, `${n} frets`]), s.fretCount, 'fretCount',
        { parse: Number }),
    );
    container.append(this._card('Instrument', guitarChildren));

    // ---------------------------------------------------------- analysis
    const timing = this.timingCharacter;
    container.append(this._card('Analysis', [
      this._slider('Chord grouping window', {
        min: 0, max: 140, step: 5,
        value: s.groupWindowMs ?? 0,
        key: 'groupWindowMs',
        format: (v) => (v === 0 ? 'automatic' : `${v} ms`),
      }),
      timing ? el('p', 'empty-note',
        timing.humanized
          ? `This performance looks human-played (onsets spread by about ${timing.medianOnsetSpreadMs.toFixed(0)} ms), so a wider window is used.`
          : 'This file looks quantized, so a tight grouping window is used.')
        : null,
      this._slider('Harmonic context weight', {
        min: 0, max: 100, step: 5,
        value: Math.round(s.contextWeight * 100),
        key: 'contextWeightPercent',
        format: (v) => (v === 0 ? 'local only' : `${v}%`),
      }),
    ]));

    if (focusKey) {
      const restored = [...container.querySelectorAll('input, select, button')]
        .find((el) => (el.getAttribute('aria-label') || el.textContent) === focusKey);
      restored?.focus({ preventScroll: true });
    }
    if (container.parentElement) container.parentElement.scrollTop = scrollTop;
  }
}
