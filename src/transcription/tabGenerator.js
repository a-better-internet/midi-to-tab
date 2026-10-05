/**
 * Tab construction and rendering (brief section 28).
 *
 * Builds a column-per-attack tablature from events that already carry their
 * chosen voicings, then preserves everything section 28 asks for: rhythm, note
 * duration, simultaneous attacks, rests, ties, and the techniques that can be
 * *inferred* from the original performance (hammer-ons, pull-offs, slides).
 *
 * Nothing is re-quantized. Columns are placed at the real onset times; the
 * rhythmic labels alongside them are descriptions, not replacements
 * (section 29).
 */

import {
  describeDuration, buildMeasures, findRests, metricPosition, crossesBarline,
} from './rhythmMapper.js';

/**
 * Infer legato technique between two successive single notes on one string.
 *
 * A hammer-on/pull-off needs the same string, a small fret distance and a
 * near-continuous join. A slide is the same idea over a larger distance.
 */
function inferTechnique(prev, next, options = {}) {
  const {
    maxLegatoGapBeats = 0.06,
    maxHammerFrets = 4,
    maxSlideFrets = 12,
  } = options;

  if (!prev || !next) return null;
  if (prev.string !== next.string) return null;
  if (prev.fret === next.fret) return null;
  if (prev.fret === 0 && next.fret === 0) return null;

  const gap = next.start - (prev.start + prev.duration);
  if (gap > maxLegatoGapBeats) return null;

  const distance = Math.abs(next.fret - prev.fret);
  const ascending = next.fret > prev.fret;

  if (distance <= maxHammerFrets) {
    return {
      type: ascending ? 'hammer-on' : 'pull-off',
      symbol: ascending ? 'h' : 'p',
      from: prev.fret,
      to: next.fret,
    };
  }
  if (distance <= maxSlideFrets && gap <= 0.02) {
    return {
      type: 'slide',
      symbol: ascending ? '/' : '\\',
      from: prev.fret,
      to: next.fret,
    };
  }
  return null;
}

/**
 * Build the tab model.
 *
 * @param {Array} transcribed events paired with voicings:
 *        { event, voicing, alternatives }
 * @param {object} context
 * @param {TimingMap} context.timing
 * @param {object} context.tuning resolved tuning
 * @param {number} context.endBeats
 * @param {object} [options]
 * @returns {object} tab model
 */
export function buildTab(transcribed, context, options = {}) {
  const { timing, tuning, endBeats } = context;
  const stringCount = tuning.openPitches.length;

  const columns = [];

  for (const item of transcribed) {
    const { event, voicing } = item;
    if (!voicing) continue;

    const strings = new Array(stringCount).fill(null);
    for (const p of voicing.played) strings[p.string] = p.fret;

    const duration = event.duration ?? 0;
    const value = describeDuration(duration);
    const metric = metricPosition(timing, event.start);

    columns.push({
      index: columns.length,
      eventId: event.id,
      start: event.start,
      end: event.start + duration,
      duration,
      startSec: event.startSec,
      strings,
      voicing,
      alternatives: item.alternatives ?? [],
      chord: event.chord,
      chordLabel: event.chord ? event.chord.symbol : null,
      roman: event.roman ?? null,
      confidence: event.confidence ?? 0,
      kind: event.kind,
      isChord: voicing.played.length > 1,
      value,
      metric,
      tie: crossesBarline(timing, event.start, event.start + duration),
      techniques: [],
      notes: event.notes,
      arpeggio: event.arpeggio ?? null,
    });
  }

  columns.sort((a, b) => a.start - b.start);
  columns.forEach((c, i) => { c.index = i; });

  // Bends come straight from the performance's pitch-bend data rather than
  // being inferred, so they are marked before the legato pass.
  for (const column of columns) {
    const bent = (column.notes ?? []).find((n) => n.bend && Math.abs(n.bend.semitones) >= 0.4);
    if (!bent) continue;
    // Put the mark on the string carrying the closest pitch to the bent note.
    const target = column.voicing.played.reduce(
      (best, p) => (Math.abs(p.pitch - bent.pitch) < Math.abs(best.pitch - bent.pitch) ? p : best),
      column.voicing.played[0],
    );
    if (!target) continue;
    // Guitar naming: a "full" bend is a whole tone, a half bend a semitone.
    const steps = Math.abs(bent.bend.semitones);
    const label = steps >= 2.75 ? '2'
      : steps >= 2.4 ? '1 1/2'
        : steps >= 1.6 ? 'full'
          : steps >= 0.8 ? '1/2'
            : '1/4';
    column.techniques.push({
      type: bent.bend.releases ? 'bend and release' : 'bend',
      symbol: bent.bend.direction === 'up' ? 'b' : 'r',
      string: target.string,
      semitones: bent.bend.semitones,
      label,
    });
  }

  // Technique inference across successive single-note columns.
  const lastOnString = new Map();
  for (const column of columns) {
    if (column.voicing.played.length === 1) {
      const p = column.voicing.played[0];
      const prev = lastOnString.get(p.string);
      const technique = inferTechnique(prev, {
        string: p.string, fret: p.fret, start: column.start, duration: column.duration,
      }, options);
      if (technique) {
        column.techniques.push({ ...technique, string: p.string, fromColumn: prev.column });
      }
      lastOnString.set(p.string, {
        string: p.string, fret: p.fret, start: column.start, duration: column.duration, column: column.index,
      });
    } else {
      // A chord resets legato context on every string it touches.
      for (const p of column.voicing.played) {
        lastOnString.set(p.string, {
          string: p.string, fret: p.fret, start: column.start, duration: column.duration, column: column.index,
        });
      }
    }
  }

  const totalBeats = Math.max(
    endBeats ?? 0,
    columns.length ? Math.max(...columns.map((c) => c.end)) : 0,
  );
  const measures = buildMeasures(timing, totalBeats);
  const rests = findRests(columns, totalBeats);

  // Assign columns to measures.
  for (const measure of measures) {
    measure.columns = columns.filter(
      (c) => c.start >= measure.start - 1e-9 && c.start < measure.end - 1e-9,
    );
    measure.rests = rests.filter((r) => r.start < measure.end && r.end > measure.start);
  }

  return {
    stringCount,
    stringNames: tuning.stringNames,
    tuning,
    // The timing map travels with the tab so it can be rebuilt (after a voicing
    // change, say) without reaching back to the score.
    timing,
    columns,
    measures,
    rests,
    totalBeats,
    capo: tuning.capo ?? 0,
  };
}

/**
 * Render the tab as ASCII, the way section 28 lays it out: highest string on
 * top, one line per string, bar lines between measures.
 *
 * Layout is done by character offset rather than by concatenation, so the bar
 * numbers and chord symbols line up exactly over the attacks they belong to.
 *
 * @param {object} tab from buildTab
 * @param {object} [options]
 * @returns {string}
 */
export function renderTabAscii(tab, options = {}) {
  const {
    columnsPerLine = 16,
    showChordNames = true,
    showBarNumbers = true,
    showHeader = true,
    emptyBarWidth = 8,
  } = options;

  const stringCount = tab.stringCount;
  // Strip octave numbers: players read "e B G D A E", not "E4 B3 ...".
  const labels = tab.stringNames.map((n) => n.replace(/-?\d+$/, ''));
  const labelWidth = Math.max(...labels.map((l) => l.length));

  // Drop trailing measures that hold nothing, which are an artefact of the last
  // note's release rather than real music.
  const measures = [...tab.measures];
  while (measures.length > 1 && measures[measures.length - 1].columns.length === 0) {
    measures.pop();
  }

  // Group measures into systems of roughly `columnsPerLine` attacks.
  const systems = [];
  let current = [];
  let used = 0;
  for (const measure of measures) {
    const count = Math.max(measure.columns.length, 1);
    if (used + count > columnsPerLine && current.length > 0) {
      systems.push(current);
      current = [];
      used = 0;
    }
    current.push(measure);
    used += count;
  }
  if (current.length) systems.push(current);

  const out = [];

  for (const system of systems) {
    // Lay the system out as a list of segments, tracking character offsets.
    const segments = [];
    let x = labelWidth + 1; // room for "e|"

    for (const measure of system) {
      segments.push({ type: 'bar', x, measure });
      x += 1;
      if (measure.columns.length === 0) {
        segments.push({ type: 'empty', x, width: emptyBarWidth, measure });
        x += emptyBarWidth;
      } else {
        for (const column of measure.columns) {
          const fretWidth = Math.max(
            1,
            ...column.strings.map((f) => (f === null ? 1 : String(f).length)),
          );
          const hasTechnique = column.techniques.length > 0;
          const width = fretWidth + (hasTechnique ? 1 : 0) + 2;
          segments.push({ type: 'column', x, width, column, fretWidth, hasTechnique });
          x += width;
        }
      }
    }
    segments.push({ type: 'bar', x, measure: null });
    const totalWidth = x + 1;

    const blank = () => new Array(totalWidth).fill(' ');
    const dashes = () => new Array(totalWidth).fill('-');

    const barRow = showBarNumbers ? blank() : null;
    const chordRow = showChordNames ? blank() : null;
    const stringRows = Array.from({ length: stringCount }, () => dashes());

    // String labels and the leading separator.
    for (let s = 0; s < stringCount; s += 1) {
      const label = labels[s].padStart(labelWidth);
      for (let i = 0; i < labelWidth; i += 1) stringRows[s][i] = label[i];
    }

    const write = (row, at, text) => {
      if (!row) return;
      for (let i = 0; i < text.length && at + i < row.length; i += 1) row[at + i] = text[i];
    };

    for (const segment of segments) {
      if (segment.type === 'bar') {
        for (let s = 0; s < stringCount; s += 1) stringRows[s][segment.x] = '|';
        if (segment.measure && showBarNumbers) {
          write(barRow, segment.x + 1, String(segment.measure.number));
        }
        continue;
      }
      if (segment.type === 'empty') continue; // dashes already fill it

      const { column, x: cx, fretWidth, hasTechnique } = segment;
      for (let s = 0; s < stringCount; s += 1) {
        const fret = column.strings[s];
        const technique = column.techniques.find((t) => t.string === s);
        let cell = '';
        if (hasTechnique) cell += technique ? technique.symbol : '-';
        cell += fret === null ? '-'.repeat(fretWidth) : String(fret).padStart(fretWidth, '-');
        write(stringRows[s], cx + 1, cell);
      }
      if (showChordNames && column.chordLabel && column.isChord) {
        write(chordRow, cx + 1, column.chordLabel);
      }
    }

    if (barRow) out.push(barRow.join('').replace(/\s+$/, ''));
    if (chordRow) out.push(chordRow.join('').replace(/\s+$/, ''));
    for (let s = stringCount - 1; s >= 0; s -= 1) out.push(stringRows[s].join('').replace(/-+$/, '-'));
    out.push('');
  }

  if (!showHeader) return out.join('\n').trimEnd();

  const header = [
    `Tuning: ${tab.tuning.name}${tab.capo ? ` (capo ${tab.capo})` : ''}`,
    `Strings (low to high): ${tab.stringNames.join(' ')}`,
  ].join('\n');

  return `${header}\n\n${out.join('\n').trimEnd()}\n`;
}

/**
 * Chord chart: the chord symbols in time order, with confidence, for the
 * read-out described in section 31.
 */
export function buildChordChart(tab) {
  const chart = [];
  let previous = null;
  for (const column of tab.columns) {
    if (!column.chordLabel) continue;
    if (previous && previous.label === column.chordLabel) {
      previous.end = column.end;
      previous.columns.push(column.index);
      continue;
    }
    previous = {
      label: column.chordLabel,
      roman: column.roman,
      start: column.start,
      end: column.end,
      bar: column.metric.bar,
      confidence: column.confidence,
      columns: [column.index],
    };
    chart.push(previous);
  }
  return chart;
}
