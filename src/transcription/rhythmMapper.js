/**
 * Rhythm mapping (brief section 29).
 *
 * "Do not regenerate rhythm after converting to guitar. The MIDI's timing
 * representation should remain the source of truth."
 *
 * So nothing here ever moves a note. This module only *describes* timing: it
 * labels a duration with the note value a reader would recognise, works out bar
 * and beat positions, and finds the rests. Every function takes exact musical
 * time and returns a description of it; the exact time is always kept alongside
 * the label so playback uses the original and only the page uses the rounding.
 */

const BASE_VALUES = [
  { beats: 4, name: 'whole', symbol: 'w', flags: 0 },
  { beats: 2, name: 'half', symbol: 'h', flags: 0 },
  { beats: 1, name: 'quarter', symbol: 'q', flags: 0 },
  { beats: 0.5, name: 'eighth', symbol: 'e', flags: 1 },
  { beats: 0.25, name: 'sixteenth', symbol: 's', flags: 2 },
  { beats: 0.125, name: 'thirty-second', symbol: 't', flags: 3 },
];

/**
 * Describe a duration in beats as a readable note value.
 * Handles dots and triplets, and reports how far the real duration is from the
 * label so the UI can show when a performance is loose.
 *
 * @param {number} beats
 * @returns {{name:string, symbol:string, dots:number, triplet:boolean,
 *            beats:number, actualBeats:number, deviation:number, flags:number}}
 */
export function describeDuration(beats) {
  if (!(beats > 0)) {
    return { name: 'none', symbol: '', dots: 0, triplet: false, beats: 0, actualBeats: beats, deviation: 0, flags: 0 };
  }

  let best = null;
  for (const base of BASE_VALUES) {
    for (const dots of [0, 1, 2]) {
      const dotted = base.beats * (2 - 1 / 2 ** dots);
      for (const triplet of [false, true]) {
        const value = triplet ? dotted * (2 / 3) : dotted;
        const error = Math.abs(Math.log2(beats / value));
        if (!best || error < best.error) {
          best = { base, dots, triplet, value, error };
        }
      }
    }
  }

  return {
    name: best.base.name + (best.dots ? ` +${best.dots} dot${best.dots > 1 ? 's' : ''}` : '')
      + (best.triplet ? ' triplet' : ''),
    symbol: best.base.symbol + '.'.repeat(best.dots) + (best.triplet ? '3' : ''),
    dots: best.dots,
    triplet: best.triplet,
    beats: best.value,
    actualBeats: beats,
    deviation: beats - best.value,
    flags: best.base.flags,
  };
}

/**
 * Choose a display grid (in beats) fine enough to show every onset in the
 * material without being absurdly fine. Used for tab column spacing.
 */
export function inferDisplayGrid(events, { finest = 0.125 } = {}) {
  if (!events || events.length === 0) return 0.25;
  const candidates = [1, 0.5, 0.25, 1 / 3, 0.125, 1 / 6];
  let bestGrid = 0.25;
  let bestMiss = Infinity;

  for (const grid of candidates) {
    if (grid < finest) continue;
    let miss = 0;
    for (const event of events) {
      const offset = event.start / grid;
      const nearest = Math.round(offset);
      miss += Math.abs(offset - nearest) * grid;
    }
    // Prefer the coarsest grid that still fits: a straight eighth-note part
    // should be laid out on eighths, not on thirty-seconds that happen to
    // divide them.
    const penalty = miss + 0.002 / grid;
    if (penalty < bestMiss - 1e-9) { bestMiss = penalty; bestGrid = grid; }
  }
  return bestGrid;
}

/**
 * Split a timeline into measures using the (possibly changing) time signature.
 *
 * @param {TimingMap} timing
 * @param {number} endBeats
 * @returns {Array<{number:number, start:number, end:number, beats:number, timeSignature:object}>}
 */
export function buildMeasures(timing, endBeats) {
  const measures = [];
  let start = 0;
  let number = 1;
  const limit = Math.max(endBeats, 1e-6);

  while (start < limit - 1e-9 && number < 10000) {
    const ts = timing.timeSignatureAt(start);
    const beats = timing.beatsPerBarAt(start);
    measures.push({
      number,
      start,
      end: start + beats,
      beats,
      timeSignature: { numerator: ts.numerator, denominator: ts.denominator },
    });
    start += beats;
    number += 1;
  }

  if (measures.length === 0) {
    const ts = timing.initialTimeSignature;
    measures.push({
      number: 1, start: 0, end: timing.beatsPerBarAt(0), beats: timing.beatsPerBarAt(0), timeSignature: ts,
    });
  }
  return measures;
}

/**
 * Find gaps where nothing is sounding, so the renderer can show rests.
 *
 * @param {Array} events objects with start/end in beats
 * @param {number} endBeats
 * @param {object} [options]
 * @returns {Array<{start:number, end:number, duration:number}>}
 */
export function findRests(events, endBeats, { minRestBeats = 0.2 } = {}) {
  if (!events || events.length === 0) {
    return endBeats > minRestBeats ? [{ start: 0, end: endBeats, duration: endBeats }] : [];
  }

  const spans = events
    .map((e) => ({ start: e.start, end: e.end ?? e.start + (e.duration ?? 0) }))
    .sort((a, b) => a.start - b.start);

  const rests = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start - cursor > minRestBeats) {
      rests.push({ start: cursor, end: span.start, duration: span.start - cursor });
    }
    cursor = Math.max(cursor, span.end);
  }
  if (endBeats - cursor > minRestBeats) {
    rests.push({ start: cursor, end: endBeats, duration: endBeats - cursor });
  }
  return rests;
}

/**
 * Metric position of a beat, for display and for accent inference.
 */
export function metricPosition(timing, beat) {
  const { bar, beat: offset, barStart, barLength } = timing.barAndBeat(beat);
  const ts = timing.timeSignatureAt(beat);
  const beatUnit = 4 / ts.denominator;
  const beatInBar = offset / beatUnit;
  const isDownbeat = Math.abs(beatInBar - Math.round(beatInBar)) < 0.02 && Math.round(beatInBar) === 0;
  const isOnBeat = Math.abs(beatInBar - Math.round(beatInBar)) < 0.05;
  return {
    bar, offset, barStart, barLength, beatInBar, isDownbeat, isOnBeat,
    label: `${bar}:${(beatInBar + 1).toFixed(2).replace(/\.00$/, '')}`,
  };
}

/** Tie detection: does a note sustain across a bar line? */
export function crossesBarline(timing, start, end) {
  const a = timing.barAndBeat(start);
  const b = timing.barAndBeat(end - 1e-6);
  return b.bar > a.bar;
}
