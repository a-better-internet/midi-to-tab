/**
 * Tab view (brief section 28).
 *
 * Renders the tab model as DOM rather than canvas, because every column has to
 * be clickable: selecting a column is how the user reaches the chord editor and
 * the alternative voicings. Chord symbols sit above their column and are
 * marked when the engine is unsure (section 31).
 */

export class TabRenderer {
  /**
   * @param {HTMLElement} container
   * @param {object} [handlers]
   * @param {(eventId:number)=>void} [handlers.onSelect]
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.tab = null;
    this.selectedEventId = null;
    this.columnsPerSystem = 16;

    container.addEventListener('click', (event) => {
      const column = event.target.closest('.tab-column');
      if (!column) return;
      const eventId = Number(column.dataset.eventId);
      if (Number.isFinite(eventId)) this.handlers.onSelect?.(eventId);
    });
  }

  setTab(tab, { lowConfidenceThreshold = 0.6 } = {}) {
    this.tab = tab;
    this.lowConfidenceThreshold = lowConfidenceThreshold;
    this.render();
  }

  setSelected(eventId) {
    this.selectedEventId = eventId;
    for (const el of this.container.querySelectorAll('.tab-column')) {
      el.classList.toggle('selected', Number(el.dataset.eventId) === eventId);
    }
    const active = this.container.querySelector('.tab-column.selected');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Highlight the column currently sounding, for playback follow. */
  setPlayhead(beat) {
    if (!this.tab) return;
    let current = null;
    for (const column of this.tab.columns) {
      if (column.start <= beat + 1e-6) current = column.index;
      else break;
    }
    if (current === this._playheadColumn) return;
    this._playheadColumn = current;
    for (const el of this.container.querySelectorAll('.tab-column')) {
      el.classList.toggle('playing', Number(el.dataset.columnIndex) === current);
    }
  }

  render() {
    const container = this.container;
    container.textContent = '';
    if (!this.tab || this.tab.columns.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No tab yet. Load a MIDI file to generate a transcription.';
      container.append(empty);
      return;
    }

    const stringCount = this.tab.stringCount;
    // Highest-pitched string printed first, as tab is always written.
    const labels = [...this.tab.stringNames].map((n) => n.replace(/-?\d+$/, '')).reverse();

    // Trailing empty measures are an artefact of the final note's release.
    const measures = [...this.tab.measures];
    while (measures.length > 1 && measures[measures.length - 1].columns.length === 0) measures.pop();

    // Group measures into systems so long pieces wrap instead of scrolling forever.
    const systems = [];
    let current = [];
    let used = 0;
    for (const measure of measures) {
      const count = Math.max(measure.columns.length, 1);
      if (used + count > this.columnsPerSystem && current.length > 0) {
        systems.push(current);
        current = [];
        used = 0;
      }
      current.push(measure);
      used += count;
    }
    if (current.length) systems.push(current);

    const fragment = document.createDocumentFragment();

    for (const system of systems) {
      const systemEl = document.createElement('div');
      systemEl.className = 'tab-system';

      const row = document.createElement('div');
      row.className = 'tab-row';

      const labelsEl = document.createElement('div');
      labelsEl.className = 'tab-labels';
      const spacer = document.createElement('div');
      spacer.className = 'lbl spacer-row';
      labelsEl.append(spacer);
      for (const label of labels) {
        const el = document.createElement('div');
        el.className = 'lbl';
        el.textContent = label;
        labelsEl.append(el);
      }
      row.append(labelsEl);

      const measuresEl = document.createElement('div');
      measuresEl.className = 'tab-measures';

      for (const measure of system) {
        const measureEl = document.createElement('div');
        measureEl.className = 'tab-measure';

        const number = document.createElement('span');
        number.className = 'bar-number';
        number.textContent = String(measure.number);
        measureEl.append(number);

        if (measure.columns.length === 0) {
          measureEl.append(this._restColumn(stringCount, measure));
        } else {
          for (const column of measure.columns) {
            measureEl.append(this._columnEl(column, stringCount));
          }
        }
        measuresEl.append(measureEl);
      }

      row.append(measuresEl);
      systemEl.append(row);
      fragment.append(systemEl);
    }

    container.append(fragment);
    if (this.selectedEventId !== null) this.setSelected(this.selectedEventId);
  }

  _columnEl(column, stringCount) {
    const el = document.createElement('div');
    el.className = 'tab-column';
    el.dataset.eventId = String(column.eventId);
    el.dataset.columnIndex = String(column.index);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const chord = document.createElement('div');
    chord.className = 'tab-chord';
    if (column.chordLabel && column.isChord) {
      chord.textContent = column.chordLabel;
      if ((column.confidence ?? 1) < this.lowConfidenceThreshold) {
        chord.classList.add('low-confidence');
      }
    }
    el.append(chord);

    const pitchNames = column.voicing.played
      .map((p) => `string ${stringCount - p.string} fret ${p.fret}`)
      .join(', ');
    el.setAttribute('aria-label',
      `${column.chordLabel ?? 'note'} at bar ${column.metric.bar}: ${pitchNames}`);
    el.title = [
      column.chordLabel ? `${column.chordLabel}  (${Math.round((column.confidence ?? 0) * 100)}%)` : 'single note',
      `bar ${column.metric.label}`,
      `${column.value.name}`,
      column.techniques.length ? column.techniques.map((t) => t.type).join(', ') : null,
    ].filter(Boolean).join('  ·  ');

    // Strings top to bottom = highest to lowest.
    for (let display = stringCount - 1; display >= 0; display -= 1) {
      const cell = document.createElement('div');
      cell.className = 'tab-cell';
      const fret = column.strings[display];
      if (fret !== null) {
        const technique = column.techniques.find((t) => t.string === display);
        if (technique) {
          const mark = document.createElement('i');
          mark.className = 'technique';
          mark.textContent = technique.symbol;
          cell.append(mark);
        }
        const value = document.createElement('span');
        value.textContent = String(fret);
        cell.append(value);
      }
      el.append(cell);
    }
    return el;
  }

  _restColumn(stringCount, measure) {
    const el = document.createElement('div');
    el.className = 'tab-column';
    el.style.minWidth = '56px';
    el.setAttribute('aria-label', `bar ${measure.number}: rest`);
    const chord = document.createElement('div');
    chord.className = 'tab-chord';
    el.append(chord);
    for (let i = 0; i < stringCount; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'tab-cell';
      el.append(cell);
    }
    return el;
  }
}
