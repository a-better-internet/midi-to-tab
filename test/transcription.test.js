import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from '../src/midi/parser.js';
import { normalizeMidi } from '../src/midi/normalizer.js';
import { analyzeHarmony, overrideRegionChord } from '../src/transcription/eventBuilder.js';
import {
  transcribe, realize, applyChordOverride, applyVoicingChoice, DEFAULT_SETTINGS,
} from '../src/transcription/pipeline.js';
import { buildTab, renderTabAscii, buildChordChart } from '../src/transcription/tabGenerator.js';
import {
  describeDuration, inferDisplayGrid, buildMeasures, findRests, metricPosition, crossesBarline,
} from '../src/transcription/rhythmMapper.js';
import { recognizeChord } from '../src/analysis/chordRecognizer.js';
import { ROLES } from '../src/analysis/noteRoleClassifier.js';
import { formatShape } from '../src/guitar/voicingGenerator.js';
import { writeMidi, beatsToTicks } from './fixtures/writeMidi.js';

/** A short keyboard part: C - Am - F - G7 with a melody and a closing arpeggio. */
function keyboardScore({ tempo = 100, jitter = 0.005 } = {}) {
  const notes = [];
  const addChord = (pitches, start, duration) => {
    pitches.forEach((p, i) => notes.push({ pitch: p, start: start + i * jitter, duration }));
  };
  addChord([36, 60, 64, 67], 0, 2);
  addChord([33, 60, 64, 69], 2, 2);
  addChord([29, 60, 65, 69], 4, 2);
  addChord([31, 55, 59, 62, 65], 6, 2);
  [72, 74, 76, 72].forEach((p, i) => notes.push({ pitch: p, start: i * 2, duration: 1.7 }));
  [60, 64, 67, 72, 67, 64, 60].forEach((p, i) => notes.push({ pitch: p, start: 8 + i * 0.5, duration: 0.45 }));
  return normalizeMidi(parseMidi(writeMidi({
    tempo, tracks: [{ name: 'Piano', program: 0, notes: beatsToTicks(notes) }],
  })));
}

function multiTrackScore() {
  const piano = [];
  [[60, 64, 67], [59, 62, 67], [57, 60, 64], [59, 62, 67]]
    .forEach((ch, i) => ch.forEach((p, k) => piano.push({ pitch: p, start: i * 2 + k * 0.004, duration: 1.9 })));
  return normalizeMidi(parseMidi(writeMidi({
    tracks: [
      { name: 'Piano', program: 0, channel: 0, notes: beatsToTicks(piano) },
      { name: 'Bass', program: 33, channel: 1, notes: beatsToTicks([36, 31, 33, 31].map((p, i) => ({ pitch: p, start: i * 2, duration: 1.9 }))) },
      { name: 'Drums', program: 0, channel: 9, notes: beatsToTicks([36, 38, 36, 38].map((p, i) => ({ pitch: p, start: i, duration: 0.4 }))) },
    ],
  })));
}

// ------------------------------------------------------------ rhythm mapper

test('describes durations as readable note values', () => {
  assert.equal(describeDuration(4).symbol, 'w');
  assert.equal(describeDuration(2).symbol, 'h');
  assert.equal(describeDuration(1).symbol, 'q');
  assert.equal(describeDuration(0.5).symbol, 'e');
  assert.equal(describeDuration(0.25).symbol, 's');
  assert.equal(describeDuration(1.5).symbol, 'q.');
  assert.equal(describeDuration(3).symbol, 'h.');
  assert.equal(describeDuration(1 / 3).symbol, 'e3');
  assert.equal(describeDuration(0).symbol, '');
});

test('a loose performance keeps its real duration alongside the label', () => {
  const loose = describeDuration(1.94);
  assert.equal(loose.symbol, 'h');
  assert.equal(loose.actualBeats, 1.94, 'the real duration must survive');
  assert.ok(Math.abs(loose.deviation + 0.06) < 1e-9);
});

test('infers the coarsest display grid that fits', () => {
  assert.equal(inferDisplayGrid([0, 1, 2, 3].map((s) => ({ start: s }))), 1);
  assert.equal(inferDisplayGrid([0, 0.5, 1, 1.5].map((s) => ({ start: s }))), 0.5);
  assert.equal(inferDisplayGrid([0, 0.25, 0.5].map((s) => ({ start: s }))), 0.25);
  assert.ok(Math.abs(inferDisplayGrid([0, 1 / 3, 2 / 3].map((s) => ({ start: s }))) - 1 / 3) < 1e-9);
});

test('builds measures and finds rests', () => {
  const score = keyboardScore();
  const measures = buildMeasures(score.timing, 12);
  assert.equal(measures.length, 3);
  assert.deepEqual(measures.map((m) => m.start), [0, 4, 8]);

  const rests = findRests([{ start: 0, end: 1 }, { start: 3, end: 4 }], 6);
  assert.deepEqual(rests.map((r) => [r.start, r.end]), [[1, 3], [4, 6]]);
  assert.deepEqual(findRests([], 4), [{ start: 0, end: 4, duration: 4 }]);
});

test('reports metric position and bar-line crossings', () => {
  const score = keyboardScore();
  const position = metricPosition(score.timing, 5.5);
  assert.equal(position.bar, 2);
  assert.ok(Math.abs(position.beatInBar - 1.5) < 1e-9);
  assert.equal(metricPosition(score.timing, 4).isDownbeat, true);
  assert.equal(crossesBarline(score.timing, 3.5, 4.5), true);
  assert.equal(crossesBarline(score.timing, 0.5, 1.5), false);
});

// --------------------------------------------------------- analysis output

test('produces the chord events described in section 19', () => {
  const score = keyboardScore();
  const analysis = analyzeHarmony(score.notes);

  assert.ok(analysis.events.length > 0);
  const chordEvent = analysis.events.find((e) => e.kind === 'chord');
  assert.ok(chordEvent, 'there should be chord events');

  // The shape section 19 specifies.
  assert.equal(typeof chordEvent.start, 'number');
  assert.equal(typeof chordEvent.duration, 'number');
  assert.ok(chordEvent.chord.rootName);
  assert.ok(chordEvent.chord.quality);
  assert.ok(chordEvent.chord.bassName);
  assert.equal(typeof chordEvent.chord.inversion, 'number');
  assert.ok(chordEvent.confidence > 0 && chordEvent.confidence <= 1);
  for (const note of chordEvent.notes) {
    assert.equal(typeof note.pitch, 'number');
    assert.ok(Object.values(ROLES).includes(note.role));
    assert.equal(typeof note.noteId, 'number');
  }
});

test('reads the expected progression from a keyboard part', () => {
  const score = keyboardScore();
  const analysis = analyzeHarmony(score.notes);
  assert.equal(analysis.key.name, 'C major');
  const symbols = analysis.regions.map((r) => r.chord.symbol);
  assert.deepEqual(symbols, ['C', 'Am', 'F', 'G7', 'C']);
  assert.deepEqual(analysis.regions.map((r) => r.roman), ['I', 'vi', 'IV', 'V7', 'I']);
});

test('a sustained melody note does not rename the harmony under it (section 16)', () => {
  const score = keyboardScore();
  const refined = analyzeHarmony(score.notes, { refineWithRoles: true });
  const unrefined = analyzeHarmony(score.notes, { refineWithRoles: false });

  // The melody sits on E over F-A-C. Refinement must read F, not Fmaj7.
  assert.equal(refined.regions[2].chord.symbol, 'F');
  assert.equal(unrefined.regions[2].chord.symbol, 'Fmaj7');

  const fEvent = refined.events.find((e) => e.start >= 4 && e.start < 5);
  const melody = fEvent.notes.find((n) => n.pitch === 76);
  assert.equal(melody.role, ROLES.MELODY);
});

test('a genuinely voiced seventh chord is still a seventh chord', () => {
  const notes = [];
  [[65, 69, 72, 76], [64, 67, 71, 74]].forEach((ch, k) => {
    ch.forEach((p, i) => notes.push({ pitch: p, start: k * 2 + i * 0.004, duration: 1.95 }));
  });
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Piano', notes: beatsToTicks(notes) }] })));
  const analysis = analyzeHarmony(score.notes);
  assert.deepEqual(analysis.regions.map((r) => r.chord.symbol), ['Fmaj7', 'Em7']);
});

test('the arpeggio becomes one harmony, not seven', () => {
  const score = keyboardScore();
  const analysis = analyzeHarmony(score.notes);
  assert.equal(analysis.arpeggios.length, 1);
  const arpeggioRegion = analysis.regions.find((r) => r.kind === 'arpeggio');
  assert.ok(arpeggioRegion);
  assert.equal(arpeggioRegion.chord.rootName, 'C');
  // Its notes keep their own attacks, so rhythm is not lost (section 29).
  const arpeggioEvents = analysis.events.filter((e) => e.kind === 'arpeggio-note');
  assert.equal(arpeggioEvents.length, 7);
});

test('analysis of an empty selection is harmless', () => {
  const analysis = analyzeHarmony([]);
  assert.deepEqual(analysis.events, []);
  assert.equal(analysis.chordAt(0), null);
});

// ------------------------------------------------------------- full pipeline

test('transcribes a keyboard part end to end', () => {
  const score = keyboardScore();
  const result = transcribe(score);

  assert.ok(result.transcribed.length > 0);
  assert.equal(result.stats.unplayableCount, 0, 'nothing unplayable should survive');
  assert.ok(result.stats.meanConfidence > 0.7);
  assert.equal(result.tuning.id, 'standard');

  for (const item of result.transcribed) {
    assert.ok(item.voicing.played.length > 0);
    for (const played of item.voicing.played) {
      assert.ok(played.fret >= 0 && played.fret <= result.settings.fretCount);
      assert.ok(played.string >= 0 && played.string < 6);
    }
  }

  const ascii = renderTabAscii(result.tab);
  assert.match(ascii, /Standard \(E A D G B E\)/);
  assert.ok(ascii.split('\n').length > 6);
});

test('picks the piano track out of a multi-instrument file (section 4)', () => {
  const score = multiTrackScore();
  const result = transcribe(score);
  const pianoIndex = score.tracks.find((t) => t.name === 'Piano').index;
  assert.deepEqual(result.source.trackIndices, [pianoIndex]);
  // No drum material may leak into the transcription.
  const drumTrack = score.tracks.find((t) => t.isDrumTrack).index;
  assert.ok(result.sourceNotes.every((n) => n.track !== drumTrack));
});

test('an explicit track selection is respected', () => {
  const score = multiTrackScore();
  const bassIndex = score.tracks.find((t) => t.name === 'Bass').index;
  const result = transcribe(score, { source: { mode: 'single', trackIndices: [bassIndex] } });
  assert.ok(result.sourceNotes.every((n) => n.track === bassIndex));
});

test('analyzing all harmonic tracks merges the keyboard and bass parts', () => {
  const score = multiTrackScore();
  const result = transcribe(score, { source: { mode: 'all-harmonic', trackIndices: [] } });
  const tracks = new Set(result.sourceNotes.map((n) => n.track));
  assert.ok(tracks.size >= 2, 'should draw on more than one track');
  const drumTrack = score.tracks.find((t) => t.isDrumTrack).index;
  assert.ok(!tracks.has(drumTrack));
});

test('transcription modes change how much is kept', () => {
  const score = keyboardScore();
  const literal = transcribe(score, { transcriptionMode: 'literal' });
  const playable = transcribe(score, { transcriptionMode: 'playable' });
  assert.ok(literal.transcribed.length >= playable.transcribed.length);
  const playableStrings = playable.transcribed.map((t) => t.voicing.stringsUsed);
  assert.ok(Math.max(...playableStrings) <= 6);
});

test('chord complexity changes the chord names', () => {
  const notes = [36, 60, 64, 67, 70, 74].map((p, i) => ({ pitch: p, start: i * 0.004, duration: 2 }));
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Piano', notes: beatsToTicks(notes) }] })));
  const basic = transcribe(score, { chordComplexity: 'basic' });
  const exact = transcribe(score, { chordComplexity: 'exact' });
  assert.equal(basic.analysis.regions[0].chord.templateId, 'maj');
  assert.equal(exact.analysis.regions[0].chord.symbol, 'C9');
});

test('the position control moves the whole transcription up the neck (section 30)', () => {
  const score = keyboardScore();
  const open = transcribe(score, { guitarPosition: 'open' });
  const high = transcribe(score, { guitarPosition: 'high' });

  const meanPosition = (result) => {
    const fretted = result.transcribed.filter((t) => t.voicing.fretSpan > 0);
    return fretted.reduce((a, t) => a + t.voicing.position, 0) / fretted.length;
  };
  assert.ok(meanPosition(high) > meanPosition(open) + 4,
    `open ${meanPosition(open)} vs high ${meanPosition(high)}`);

  // Chords must obey the window. Single notes cannot always: E5 does not exist
  // below the twelfth fret on a standard guitar, so the engine leaves the
  // window and flags that it did.
  const openChords = open.transcribed.filter((t) => t.event.kind === 'chord' && t.voicing.fretSpan > 0);
  assert.ok(openChords.length > 0);
  for (const item of openChords) {
    assert.ok(item.voicing.maxFret <= 5, `${formatShape(item.voicing)} left open position`);
    assert.equal(item.outOfPosition, false);
  }
  for (const item of open.transcribed) {
    if (item.voicing.fretSpan === 0) continue;
    assert.equal(item.outOfPosition, item.voicing.maxFret > 4,
      'leaving the window must be reported honestly');
  }
  assert.equal(typeof open.stats.outOfPositionCount, 'number');
});

test('the maximum fret span is honoured end to end (section 27)', () => {
  const score = keyboardScore();
  for (const span of [3, 4, 5]) {
    const result = transcribe(score, { maxFretSpan: span });
    for (const item of result.transcribed) {
      assert.ok(item.voicing.fretSpan <= span + 1,
        `${formatShape(item.voicing)} spans ${item.voicing.fretSpan} with limit ${span}`);
    }
  }
});

test('alternative tunings and a capo change the fret numbers', () => {
  const score = keyboardScore();
  const standard = transcribe(score);
  const dropD = transcribe(score, { tuning: 'drop-d' });
  const capo = transcribe(score, { capo: 2 });

  assert.deepEqual(dropD.tuning.stringNames, ['D2', 'A2', 'D3', 'G3', 'B3', 'E4']);
  assert.equal(capo.tuning.capo, 2);
  const shapes = (r) => r.transcribed.map((t) => formatShape(t.voicing)).join('|');
  assert.notEqual(shapes(standard), shapes(dropD));
  assert.notEqual(shapes(standard), shapes(capo));
});

test('a 7-string guitar uses its extra string when the bass calls for it', () => {
  const notes = [30, 54, 58, 61].map((p, i) => ({ pitch: p, start: i * 0.004, duration: 2 })); // F#1 bass
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Piano', notes: beatsToTicks(notes) }] })));
  const seven = transcribe(score, { tuning: 'seven-standard' });
  assert.equal(seven.tuning.stringCount, 7);
  assert.equal(seven.tab.stringCount, 7);
  assert.ok(seven.transcribed.length > 0);
});

test('the engine retargets to ukulele and bass without changes (section 36)', () => {
  const score = keyboardScore();
  for (const tuning of ['ukulele', 'bass-4']) {
    const result = transcribe(score, { tuning });
    assert.ok(result.transcribed.length > 0, `${tuning} produced nothing`);
    assert.equal(result.tab.stringCount, result.tuning.stringCount);
    for (const item of result.transcribed) {
      assert.ok(item.voicing.played.every((p) => p.string < result.tuning.stringCount));
    }
  }
});

test('Preserve Piano Voicing shifts the result toward the original register', () => {
  const score = keyboardScore();
  const off = transcribe(score, { preservePianoVoicing: false });
  const on = transcribe(score, { preservePianoVoicing: true });
  const similarity = (result) => result.transcribed
    .filter((t) => t.parts)
    .reduce((a, t) => a + t.parts.voicingSimilarity, 0) / result.transcribed.length;
  assert.ok(similarity(on) >= similarity(off));
});

// ------------------------------------------------------------ tab structure

test('the tab preserves rhythm, attacks and bar structure (section 28/29)', () => {
  const score = keyboardScore();
  const result = transcribe(score);
  const { tab } = result;

  assert.equal(tab.stringCount, 6);
  assert.ok(tab.measures.length >= 3);
  assert.ok(tab.columns.length > 0);

  for (const column of tab.columns) {
    assert.equal(column.strings.length, 6);
    assert.ok(column.duration > 0);
    assert.ok(column.value.symbol.length > 0, 'every column carries a note value');
    assert.ok(column.metric.bar >= 1);
  }

  // Column onsets must match the analysis onsets exactly -- no requantization.
  const eventStarts = new Map(result.transcribed.map((t) => [t.event.id, t.event.start]));
  for (const column of tab.columns) {
    assert.equal(column.start, eventStarts.get(column.eventId));
  }

  // Columns are in time order and assigned to the right measures.
  for (let i = 1; i < tab.columns.length; i += 1) {
    assert.ok(tab.columns[i].start >= tab.columns[i - 1].start);
  }
  for (const measure of tab.measures) {
    for (const column of measure.columns) {
      assert.ok(column.start >= measure.start - 1e-9 && column.start < measure.end);
    }
  }
});

test('simultaneous attacks share a column; separate attacks do not', () => {
  const score = keyboardScore();
  const { tab } = transcribe(score);
  const chordColumns = tab.columns.filter((c) => c.isChord);
  const singleColumns = tab.columns.filter((c) => !c.isChord);
  assert.ok(chordColumns.length >= 4);
  assert.ok(singleColumns.length >= 4, 'the arpeggio should produce single-note columns');
  for (const column of chordColumns) {
    assert.ok(column.strings.filter((f) => f !== null).length > 1);
  }
});

test('infers hammer-ons, pull-offs and slides from the original timing', () => {
  // A legato run up one string: 5 -> 7 -> 9, then back down.
  const notes = [
    { pitch: 64, start: 0, duration: 0.5 },
    { pitch: 66, start: 0.5, duration: 0.5 },
    { pitch: 68, start: 1.0, duration: 0.5 },
    { pitch: 66, start: 1.5, duration: 0.5 },
  ];
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Lead', notes: beatsToTicks(notes) }] })));
  const result = transcribe(score);
  const techniques = result.tab.columns.flatMap((c) => c.techniques.map((t) => t.type));
  assert.ok(techniques.includes('hammer-on') || techniques.includes('pull-off'),
    `no legato inferred, got ${JSON.stringify(techniques)}`);
  const ascii = renderTabAscii(result.tab);
  assert.match(ascii, /[hp]/);
});

test('the chord chart lists the harmony in time order with confidence', () => {
  const score = keyboardScore();
  const result = transcribe(score);
  const chart = buildChordChart(result.tab);
  assert.ok(chart.length >= 4);
  for (const entry of chart) {
    assert.ok(entry.label);
    assert.ok(entry.confidence > 0 && entry.confidence <= 1);
    assert.ok(entry.bar >= 1);
  }
  for (let i = 1; i < chart.length; i += 1) {
    assert.ok(chart[i].start >= chart[i - 1].start);
  }
});

test('ASCII rendering puts the highest string on top', () => {
  const score = keyboardScore();
  const ascii = renderTabAscii(transcribe(score).tab, { showHeader: false });
  const lines = ascii.split('\n').filter((l) => /^[A-Ga-g]#?b?-?\|/.test(l));
  assert.ok(lines.length >= 6);
  assert.match(lines[0], /^E/, 'first printed string is the high E');
  assert.match(lines[5], /^E/, 'last printed string is the low E');
});

test('an empty tab renders without throwing', () => {
  const score = keyboardScore();
  const tab = buildTab([], { timing: score.timing, tuning: transcribe(score).tuning, endBeats: 0 });
  assert.equal(tab.columns.length, 0);
  assert.equal(typeof renderTabAscii(tab), 'string');
});

// ----------------------------------------------------------- interactivity

test('a chord correction regenerates the guitar part without re-reading MIDI (section 32)', () => {
  const score = keyboardScore();
  const before = transcribe(score);
  const region = before.analysis.regions[1];
  assert.equal(region.chord.symbol, 'Am');

  // Force the alternative reading the recognizer ranked second.
  const alternative = region.candidates.find((c) => c.symbol !== region.chord.symbol);
  const after = applyChordOverride(score, before, region.index, alternative);

  assert.equal(after.analysis.regions[1].chord.symbol, alternative.symbol);
  assert.equal(after.analysis.regions[1].overridden, true);
  // The untouched regions must be unchanged.
  assert.equal(after.analysis.regions[0].chord.symbol, before.analysis.regions[0].chord.symbol);
  assert.equal(after.analysis.regions[3].chord.symbol, before.analysis.regions[3].chord.symbol);
  // The source notes are the very same objects: nothing was re-imported.
  assert.equal(after.sourceNotes, before.sourceNotes);
  assert.ok(after.transcribed.length > 0);
});

test('overriding a chord re-classifies the notes under it', () => {
  const score = keyboardScore();
  const analysis = analyzeHarmony(score.notes);
  const region = analysis.regions[0];
  const alternative = region.candidates.find((c) => c.root !== region.chord.root);
  assert.ok(alternative, 'needs an alternative with a different root');
  const overridden = overrideRegionChord(analysis, region.index, alternative);

  const before = analysis.events[0].notes.map((n) => n.role).join(',');
  const after = overridden.events[0].notes.map((n) => n.role).join(',');
  assert.notEqual(before, after, 'roles depend on the harmony and must be recomputed');
});

test('an alternative voicing can be chosen for one event only (section 34)', () => {
  const score = keyboardScore();
  const result = transcribe(score);
  const target = result.transcribed.find((t) => t.alternatives.length > 0);
  assert.ok(target);

  const replacement = target.alternatives[0].voicing;
  const updated = applyVoicingChoice(result, target.event.id, replacement);
  const changed = updated.transcribed.find((t) => t.event.id === target.event.id);

  assert.equal(formatShape(changed.voicing), formatShape(replacement));
  assert.equal(changed.manual, true);
  // Every other event keeps its shape.
  for (const item of updated.transcribed) {
    if (item.event.id === target.event.id) continue;
    const original = result.transcribed.find((t) => t.event.id === item.event.id);
    assert.equal(formatShape(item.voicing), formatShape(original.voicing));
  }
  // The previous choice becomes an available alternative.
  assert.ok(changed.alternatives.some((a) => formatShape(a.voicing) === formatShape(target.voicing)));
});

test('re-realizing an analysis with new settings reuses the analysis object', () => {
  const score = keyboardScore();
  const first = transcribe(score);
  const second = realize(score, first.analysis, { ...first.settings, tuning: 'drop-d' });
  assert.equal(second.analysis, first.analysis, 'the analysis must be reused, not recomputed');
  assert.equal(second.tuning.id, 'drop-d');
});

test('low-confidence harmonies are counted so the UI can flag them (section 31)', () => {
  const score = keyboardScore();
  const result = transcribe(score);
  assert.equal(typeof result.stats.lowConfidenceCount, 'number');
  assert.ok(result.stats.lowConfidenceCount <= result.analysis.regions.length);
  for (const region of result.analysis.regions) {
    assert.ok(region.candidates.length >= 1, 'every region offers alternatives to choose from');
  }
});

test('default settings expose every control section 30 lists', () => {
  for (const key of ['transcriptionMode', 'chordComplexity', 'guitarPosition',
    'preservePianoVoicing', 'includeExtensions', 'maxFretSpan']) {
    assert.ok(key in DEFAULT_SETTINGS, `missing setting: ${key}`);
  }
});

test('a single-note melody file transcribes without chords', () => {
  const notes = [72, 74, 76, 77, 79].map((p, i) => ({ pitch: p, start: i * 0.5, duration: 0.45 }));
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Lead', notes: beatsToTicks(notes) }] })));
  const result = transcribe(score);
  assert.equal(result.transcribed.length, 5);
  for (const item of result.transcribed) assert.equal(item.voicing.stringsUsed, 1);
});

test('a dense ten-note piano chord becomes a playable guitar voicing (section 40)', () => {
  // Cmaj7 spread over four octaves, ten notes -- the brief's closing example.
  const pitches = [36, 48, 55, 60, 64, 67, 71, 72, 76, 79];
  const notes = pitches.map((p, i) => ({ pitch: p, start: i * 0.004, duration: 4 }));
  const score = normalizeMidi(parseMidi(writeMidi({ tracks: [{ name: 'Piano', notes: beatsToTicks(notes) }] })));
  const result = transcribe(score);

  assert.equal(result.analysis.regions[0].chord.rootName, 'C');
  assert.match(result.analysis.regions[0].chord.symbol, /^Cmaj7/);

  const voicing = result.transcribed[0].voicing;
  assert.ok(voicing.stringsUsed <= 6, 'a guitar has six strings');
  assert.ok(voicing.fingering.playable, 'and the result must be playable');
  // Harmonic identity survives even though most of the notes do not.
  assert.ok(voicing.pitchSet.has(0), 'the root is kept');
  assert.ok(voicing.pitchSet.has(4), 'the third is kept');
  assert.ok(voicing.pitchSet.has(11), 'the major seventh is kept');
  assert.equal(voicing.lowestPitch % 12, 0, 'C stays in the bass');
});

test('pitch bends in the performance become bend marks in the tab (section 28)', () => {
  // One note held for two beats, bent up a whole tone part way through.
  const bytes = writeMidi({
    tracks: [{
      name: 'Lead',
      channel: 0,
      notes: beatsToTicks([{ pitch: 64, start: 0, duration: 2 }]),
      bends: [
        { tick: 0, value: 0 },
        { tick: 240, value: 8191 }, // +2 semitones at the default range
        { tick: 960, value: 0 },
      ],
    }],
  });
  const score = normalizeMidi(parseMidi(bytes));

  const note = score.notes[0];
  assert.ok(note.bend, 'the bend should be attached to the note it affects');
  assert.ok(Math.abs(note.bend.semitones - 2) < 0.01, `bent ${note.bend.semitones} semitones`);
  assert.equal(note.bend.direction, 'up');
  assert.equal(note.bend.releases, true, 'it returns to pitch, so it is a bend and release');

  const result = transcribe(score);
  const marks = result.tab.columns.flatMap((c) => c.techniques).filter((t) => t.type.startsWith('bend'));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, 'full');
  assert.equal(marks[0].type, 'bend and release');
  assert.match(renderTabAscii(result.tab), /b/);
});

test('vibrato and pitch drift are not reported as bends', () => {
  const bytes = writeMidi({
    tracks: [{
      name: 'Lead',
      channel: 0,
      notes: beatsToTicks([{ pitch: 64, start: 0, duration: 2 }]),
      // +/- 0.1 semitone wobble: expression, not a bend.
      bends: [
        { tick: 120, value: 400 }, { tick: 240, value: -400 },
        { tick: 360, value: 400 }, { tick: 480, value: -400 },
      ],
    }],
  });
  const score = normalizeMidi(parseMidi(bytes));
  assert.equal(score.notes[0].bend, null);
  const result = transcribe(score);
  assert.equal(result.tab.columns.flatMap((c) => c.techniques).length, 0);
});

test('a note with no bend data is unaffected', () => {
  const score = keyboardScore();
  assert.ok(score.notes.every((n) => n.bend === null));
});
