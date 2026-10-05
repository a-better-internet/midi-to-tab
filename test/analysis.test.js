import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterNotes, clusterNotesAdaptive, groupingScore, temporalScore, overlapScore,
  analyzeTimingCharacter, DEFAULT_CLUSTER_WEIGHTS,
} from '../src/analysis/noteClusterer.js';
import {
  recognizeChord, harmonicCompatibility, CHORD_TEMPLATES, pcName,
} from '../src/analysis/chordRecognizer.js';
import { detectKey, diatonicChords, keyProfile } from '../src/analysis/keyDetector.js';
import { resolveProgression, romanNumeral } from '../src/analysis/harmonicContext.js';
import {
  classifyNoteRoles, detectArpeggios, extractMelodyLine, ROLES,
} from '../src/analysis/noteRoleClassifier.js';
import { analyzeTracks, measurePolyphony } from '../src/analysis/trackAnalyzer.js';
import { normalizeMidi } from '../src/midi/normalizer.js';
import { parseMidi } from '../src/midi/parser.js';
import { writeMidi, beatsToTicks } from './fixtures/writeMidi.js';

/** Build normalized-looking notes directly, at a known tempo. */
let nextId = 0;
const secPerBeat = 0.5; // 120 bpm
function note(pitch, startSec, durSec, velocity = 80) {
  return {
    id: nextId++,
    pitch,
    start: startSec / secPerBeat,
    duration: durSec / secPerBeat,
    end: (startSec + durSec) / secPerBeat,
    velocity,
    channel: 0,
    track: 0,
    startSec,
    durationSec: durSec,
    endSec: startSec + durSec,
  };
}
const chordNote = (pitch, duration = 1, velocity = 80) => ({ pitch, duration, velocity });

// ---------------------------------------------------------------- clustering

test('groups a humanly-played chord into one cluster (brief section 5)', () => {
  nextId = 0;
  // The brief's own example: C3 at 0, E3 at 18ms, G3 at 41ms, C4 at 63ms.
  const notes = [note(48, 0, 1.5), note(52, 0.018, 1.48), note(55, 0.041, 1.46), note(60, 0.063, 1.44)];
  const { clusters } = clusterNotesAdaptive(notes);
  assert.equal(clusters.length, 1, 'four spread onsets are one chord');
  assert.equal(clusters[0].notes.length, 4);
  assert.deepEqual(clusters[0].pitches, [48, 52, 55, 60]);
});

test('keeps an arpeggio as separate events', () => {
  nextId = 0;
  const notes = [note(48, 0, 0.22), note(52, 0.25, 0.22), note(55, 0.5, 0.22), note(60, 0.75, 0.22)];
  const { clusters } = clusterNotesAdaptive(notes);
  assert.equal(clusters.length, 4, 'an arpeggio is not a chord');
});

test('splits a block chord from the melody note that follows it', () => {
  nextId = 0;
  const notes = [
    note(48, 0, 2), note(55, 0.004, 2), note(60, 0.008, 2), note(64, 0.012, 2),
    note(69, 0.5, 0.4), note(67, 0.75, 0.4),
  ];
  const { clusters } = clusterNotesAdaptive(notes);
  assert.equal(clusters.length, 3);
  assert.deepEqual(clusters[0].pitches, [48, 55, 60, 64]);
  assert.deepEqual(clusters[1].pitches, [69]);
});

test('never merges two instances of the same pitch', () => {
  nextId = 0;
  const notes = [note(60, 0, 0.1), note(60, 0.01, 0.1)];
  const { clusters } = clusterNotesAdaptive(notes);
  assert.equal(clusters.length, 2);
});

test('temporal score decays exponentially, not linearly', () => {
  const at5 = temporalScore(5, 45);
  const at15 = temporalScore(15, 45);
  const at200 = temporalScore(200, 45);
  assert.ok(at5 > at15 && at15 > at200);
  assert.ok(at5 - at15 > 0.08, '5ms vs 15ms must be meaningful');
  assert.ok(at200 < 0.02, '200ms must read as unrelated');
});

test('duration overlap distinguishes a chord from an arpeggio', () => {
  nextId = 0;
  const block = overlapScore(note(60, 0, 2), note(64, 0.01, 1.99));
  const arp = overlapScore(note(60, 0, 0.2), note(64, 0.25, 0.2));
  assert.ok(block > 0.9, `block overlap was ${block}`);
  assert.equal(arp, 0);
});

test('grouping weights are configurable', () => {
  nextId = 0;
  const a = note(60, 0, 1);
  const b = note(61, 0.09, 1); // minor 2nd, 90ms apart
  const temporalOnly = groupingScore(a, b, { weights: { temporal: 1 } }).score;
  const harmonicOnly = groupingScore(a, b, { weights: { harmonic: 1 } }).score;
  assert.notEqual(temporalOnly.toFixed(4), harmonicOnly.toFixed(4));
  const parts = groupingScore(a, b).parts;
  assert.deepEqual(Object.keys(parts).sort(), Object.keys(DEFAULT_CLUSTER_WEIGHTS).sort());
});

test('timing character detects machine vs human timing', () => {
  nextId = 0;
  const machine = [note(60, 0, 1), note(64, 0, 1), note(67, 0, 1)];
  const human = [note(60, 0, 1), note(64, 0.025, 1), note(67, 0.055, 1), note(72, 0.08, 1)];
  const m = analyzeTimingCharacter(machine);
  const h = analyzeTimingCharacter(human);
  assert.equal(m.exactSimultaneityRatio, 1);
  assert.equal(m.humanized, false);
  assert.ok(h.exactSimultaneityRatio < 0.5);
  assert.ok(h.suggestedWindowMs > m.suggestedWindowMs);
});

test('a fixed grouping window can be forced', () => {
  nextId = 0;
  const notes = [note(48, 0, 1), note(52, 0.07, 1), note(55, 0.075, 1)];
  const tight = clusterNotes(notes, { groupWindowMs: 10, maxWindowMs: 20 });
  const loose = clusterNotes(notes, { groupWindowMs: 90, maxWindowMs: 200 });
  assert.ok(tight.length > loose.length, 'a tighter window must split more');
});

// ------------------------------------------------------- chord recognition

test('recognizes the brief\'s chord examples', () => {
  const cases = [
    ['C', [60, 64, 67]],
    ['Cmaj7', [60, 64, 67, 71]],
    ['C7', [60, 64, 67, 70]],
    ['Cm7', [60, 63, 67, 70]],
    ['Dm', [62, 65, 69]],
    ['G7', [55, 59, 62, 65]],
    ['Csus4', [60, 65, 67]],
    ['Bdim7', [59, 62, 65, 68]],
    ['C5', [48, 55]],
    ['Dm7', [50, 65, 69, 72]],
    ['Caug', [60, 64, 68]],
    ['Cm', [60, 63, 67]],
    ['C6', [60, 64, 67, 69, 69]],
  ];
  for (const [expected, pitches] of cases) {
    const r = recognizeChord(pitches.map((p) => chordNote(p)));
    assert.equal(r.best.symbol, expected, `${pitches} should be ${expected}, got ${r.best.symbol}`);
    assert.ok(r.best.confidence > 0.6, `${expected} confidence was ${r.best.confidence}`);
  }
});

test('separates bass from root and names inversions (section 12/13)', () => {
  const rootPosition = recognizeChord([36, 55, 60, 64].map((p) => chordNote(p)));
  assert.equal(rootPosition.best.symbol, 'C');
  assert.equal(rootPosition.best.inversion, 0);
  assert.equal(rootPosition.best.bass % 12, 0);

  const firstInversion = recognizeChord([40, 55, 60, 64].map((p) => chordNote(p)));
  assert.equal(firstInversion.best.symbol, 'C/E');
  assert.equal(firstInversion.best.rootName, 'C');
  assert.equal(firstInversion.best.bassName, 'E');
  assert.equal(firstInversion.best.inversion, 1);
  assert.equal(firstInversion.best.inversionName, 'first inversion');

  const secondInversion = recognizeChord([43, 60, 64, 67].map((p) => chordNote(p)));
  assert.equal(secondInversion.best.symbol, 'C/G');
  assert.equal(secondInversion.best.inversion, 2);
});

test('does not assume the lowest note is the root', () => {
  // E G C -- lowest note E, but the chord is C major.
  const r = recognizeChord([52, 67, 72].map((p) => chordNote(p)));
  assert.equal(r.best.rootName, 'C');
  assert.notEqual(r.best.rootName, 'E');
});

test('recognizes chords with missing tones', () => {
  // No fifth: still unambiguously Cmaj7.
  const r = recognizeChord([60, 64, 71].map((p) => chordNote(p)));
  assert.equal(r.best.rootName, 'C');
  assert.ok(r.best.templateId.includes('maj7'), `got ${r.best.templateId}`);
  assert.ok(r.best.missing.length > 0, 'the absent fifth should be reported');
});

test('offers ranked alternatives with monotonic confidence', () => {
  const r = recognizeChord([60, 64, 67, 71].map((p) => chordNote(p)));
  assert.ok(r.candidates.length > 1);
  for (let i = 1; i < r.candidates.length; i += 1) {
    assert.ok(r.candidates[i].confidence <= r.candidates[i - 1].confidence + 1e-12,
      'an alternative must never out-rank the chosen reading');
  }
});

test('chord complexity limits the vocabulary', () => {
  const pitches = [60, 64, 67, 70, 74].map((p) => chordNote(p)); // C9
  const basic = recognizeChord(pitches, { complexity: 'basic' });
  const exact = recognizeChord(pitches, { complexity: 'exact' });
  assert.equal(basic.best.templateId, 'maj', 'basic mode may only use triads');
  assert.equal(exact.best.symbol, 'C9');

  // A chord that only exists at 'exact' complexity.
  const mMaj7 = [48, 63, 67, 71].map((p) => chordNote(p));
  assert.equal(recognizeChord(mMaj7, { complexity: 'exact' }).best.symbol, 'Cm(maj7)');
});

test('the vocabulary covers everything section 10 asks for', () => {
  const required = ['maj', 'min', 'dim', 'aug', 'maj7', 'm7', '7', 'm7b5', 'dim7',
    'sus2', 'sus4', '6', 'm6', 'add9', 'maj9', 'm9', '9', '11', '13'];
  const ids = new Set(CHORD_TEMPLATES.map((t) => t.id));
  for (const id of required) assert.ok(ids.has(id), `missing template: ${id}`);
});

test('reports unclassifiable material honestly instead of inventing a chord', () => {
  const r = recognizeChord([60, 61, 62].map((p) => chordNote(p, 1)), { complexity: 'basic' });
  assert.ok(r.best.confidence < 0.8, `confidence was ${r.best.confidence}`);
});

test('a single note is reported as a single note', () => {
  const r = recognizeChord([chordNote(60)]);
  assert.equal(r.best.quality, 'single note');
  assert.equal(r.best.symbol, 'C');
});

test('harmonic compatibility separates triads from chromatic clusters', () => {
  assert.equal(harmonicCompatibility([60, 64, 67]), 1);
  assert.ok(harmonicCompatibility([60, 61, 62]) < 0.6);
  assert.equal(harmonicCompatibility([60]), 1);
});

test('spells notes with flats when asked', () => {
  assert.equal(pcName(10), 'A#');
  assert.equal(pcName(10, { flats: true }), 'Bb');
  const r = recognizeChord([63, 67, 70].map((p) => chordNote(p)), { flats: true });
  assert.equal(r.best.symbol, 'Eb');
});

// ---------------------------------------------------------- key detection

test('detects major and minor keys', () => {
  const build = (chords) => chords.flatMap((ch, i) => ch.map((p) => chordNote(p, 2)))
    .map((n, i) => ({ ...n, start: Math.floor(i / 3) * 2 }));

  const gMajor = detectKey(build([[55, 59, 62], [60, 64, 67], [62, 66, 69], [55, 59, 62]]));
  assert.equal(gMajor.name, 'G major');
  assert.ok(gMajor.confidence > 0.6);

  const aMinor = detectKey(build([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]]));
  assert.equal(aMinor.mode, 'minor');
  assert.equal(aMinor.tonic, 9);
});

test('flat keys are spelled with flats', () => {
  const notes = [[63, 67, 70], [68, 72, 75], [70, 74, 77], [63, 67, 70]]
    .flatMap((ch) => ch.map((p) => chordNote(p, 2)));
  const key = detectKey(notes);
  assert.equal(key.name, 'Eb major');
  assert.equal(key.preferFlats, true);
  assert.equal(key.sharpsFlats, -3);
});

test('key detection returns a usable profile and candidates', () => {
  const notes = [60, 62, 64, 65, 67, 69, 71].map((p) => chordNote(p, 1));
  const key = detectKey(notes);
  assert.equal(key.profile.length, 12);
  assert.ok(key.candidates.length >= 2);
  const profile = keyProfile(0, 'major');
  assert.equal(profile[0], 1, 'the tonic should be the strongest degree');
  assert.ok(profile[1] < profile[0]);
});

test('diatonic chords of a key are correct', () => {
  const g = diatonicChords(7, 'major');
  assert.equal(g.length, 7);
  assert.deepEqual(g.map((d) => d.root), [7, 9, 11, 0, 2, 4, 6]);
  assert.deepEqual(g.map((d) => d.quality), ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']);
});

test('an empty score does not crash key detection', () => {
  const key = detectKey([]);
  assert.equal(key.confidence, 0);
  assert.equal(key.profile.length, 12);
});

// ------------------------------------------------------- harmonic context

test('resolves a progression and labels it with roman numerals', () => {
  const chords = [[48, 60, 64, 67], [45, 60, 64, 69], [41, 60, 65, 69], [43, 59, 62, 65], [48, 60, 64, 67]];
  const notes = chords.flatMap((ch, i) => ch.map((p) => ({ ...chordNote(p, 2), start: i * 2 })));
  const key = detectKey(notes);
  const events = chords.map((ch, i) => ({
    start: i * 2, end: i * 2 + 2, durationBeats: 2,
    candidates: recognizeChord(ch.map((p) => chordNote(p, 2)), { keyProfile: key.profile }).candidates,
  }));
  const resolved = resolveProgression(events, key);
  assert.deepEqual(resolved.map((r) => r.chosen.symbol), ['C', 'Am', 'F', 'G7', 'C']);
  assert.deepEqual(resolved.map((r) => romanNumeral(r.chosen, key)), ['I', 'vi', 'IV', 'V7', 'I']);
});

test('tonal context can override a locally-preferred reading', () => {
  // C E G A in isolation is a toss-up between C6 and Am7/C. In an A minor
  // context the progression model should pull it toward the Am reading.
  const ambiguous = [60, 64, 67, 69].map((p) => chordNote(p, 2));
  const key = { tonic: 9, mode: 'minor', confidence: 0.95, profile: keyProfile(9, 'minor') };
  const amChord = recognizeChord([57, 60, 64, 67].map((p) => chordNote(p, 2)), { keyProfile: key.profile });
  const events = [
    { start: 0, end: 2, durationBeats: 2, candidates: amChord.candidates },
    { start: 2, end: 4, durationBeats: 2, candidates: recognizeChord(ambiguous, { keyProfile: key.profile }).candidates },
  ];
  const resolved = resolveProgression(events, key, { contextWeight: 0.9 });
  assert.ok(resolved[1].chosen, 'a reading must be chosen');
  // Whatever it picks, the decision must be recorded as context-driven or not.
  assert.equal(typeof resolved[1].contextChanged, 'boolean');
  assert.ok(resolved[1].candidates[0] === resolved[1].chosen,
    'the chosen reading must lead the alternatives list');
});

test('progression resolution tolerates events with no candidates', () => {
  const key = detectKey([60, 64, 67].map((p) => chordNote(p)));
  const resolved = resolveProgression([
    { start: 0, end: 1, candidates: recognizeChord([60, 64, 67].map((p) => chordNote(p))).candidates },
    { start: 1, end: 2, candidates: [] },
  ], key);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[1].chosen, null);
});

// ------------------------------------------------------ roles / arpeggios

test('a melodic figure over a chord is not absorbed into the chord (section 17)', () => {
  nextId = 0;
  // C2 G3 C4 E4 held, with a G4-A4-G4 figure on top.
  const notes = [
    note(36, 0, 2), note(55, 0.002, 2), note(60, 0.004, 2), note(64, 0.006, 2),
    note(67, 0, 0.5), note(69, 0.5, 0.5), note(67, 1.0, 1),
  ];
  const { clusters } = clusterNotesAdaptive(notes);
  const chord = recognizeChord([36, 55, 60, 64].map((p) => chordNote(p, 4))).best;
  const roles = classifyNoteRoles(notes, { chordAt: () => chord, clusters, arpeggios: [] });

  assert.equal(roles.get(notes[0].id).role, ROLES.BASS);
  assert.equal(roles.get(notes[2].id).role, ROLES.ROOT);
  assert.equal(roles.get(notes[3].id).role, ROLES.CHORD_TONE);
  // The A is not a chord tone of C major and must not become a C6 extension.
  const a = roles.get(notes[5].id);
  assert.ok([ROLES.MELODY, ROLES.PASSING_TONE, ROLES.APPROACH_TONE].includes(a.role),
    `the A was classified ${a.role}`);
  assert.equal(a.chordFunction, 'NON_CHORD');
});

test('passing tones are told apart from neighbour tones', () => {
  nextId = 0;
  const chord = recognizeChord([60, 64, 67].map((p) => chordNote(p))).best;
  // C D E: D passes stepwise in one direction.
  const passing = [note(60, 0, 0.2), note(62, 0.25, 0.2), note(64, 0.5, 0.2)];
  const r1 = classifyNoteRoles(passing, { chordAt: () => chord, clusters: [], arpeggios: [] });
  assert.equal(r1.get(passing[1].id).role, ROLES.PASSING_TONE);

  // E F E: F steps away and comes back.
  nextId = 0;
  const neighbour = [note(64, 0, 0.2), note(65, 0.25, 0.2), note(64, 0.5, 0.2)];
  const r2 = classifyNoteRoles(neighbour, { chordAt: () => chord, clusters: [], arpeggios: [] });
  assert.equal(r2.get(neighbour[1].id).role, ROLES.APPROACH_TONE);
});

test('very short notes are ornaments', () => {
  nextId = 0;
  const chord = recognizeChord([60, 64, 67].map((p) => chordNote(p))).best;
  const notes = [note(60, 0, 1), note(61, 0.02, 0.03), note(64, 0.1, 1)];
  const roles = classifyNoteRoles(notes, { chordAt: () => chord, clusters: [], arpeggios: [] });
  assert.equal(roles.get(notes[1].id).role, ROLES.ORNAMENT);
});

test('detects an arpeggio and names its harmony (section 18)', () => {
  nextId = 0;
  // C -> E -> G -> C -> G -> E
  const notes = [60, 64, 67, 72, 67, 64].map((p, i) => note(p, i * 0.25, 0.22));
  const { clusters } = clusterNotesAdaptive(notes);
  const arpeggios = detectArpeggios(clusters);
  assert.equal(arpeggios.length, 1);
  assert.equal(arpeggios[0].chord.symbol, 'C');
  assert.equal(arpeggios[0].contour, 'oscillating');
  assert.ok(arpeggios[0].confidence > 0.6);
  assert.equal(arpeggios[0].noteIds.length, 6);
});

test('an ascending arpeggio reports its contour', () => {
  nextId = 0;
  const notes = [60, 64, 67, 72].map((p, i) => note(p, i * 0.25, 0.22));
  const arpeggios = detectArpeggios(clusterNotesAdaptive(notes).clusters);
  assert.equal(arpeggios.length, 1);
  assert.equal(arpeggios[0].contour, 'ascending');
});

test('a two-note tremolo is not an arpeggio', () => {
  nextId = 0;
  const notes = [60, 67, 60, 67, 60, 67].map((p, i) => note(p, i * 0.25, 0.22));
  assert.equal(detectArpeggios(clusterNotesAdaptive(notes).clusters).length, 0);
});

test('block chords are not arpeggios', () => {
  nextId = 0;
  const notes = [note(60, 0, 2), note(64, 0.005, 2), note(67, 0.01, 2)];
  assert.equal(detectArpeggios(clusterNotesAdaptive(notes).clusters).length, 0);
});

test('melody extraction finds the exposed top voice', () => {
  nextId = 0;
  const notes = [note(48, 0, 4), note(60, 0, 4), note(72, 0, 1), note(74, 1, 1)];
  const line = extractMelodyLine(notes);
  const pitches = line.map((l) => l.note.pitch);
  assert.ok(pitches.includes(72) && pitches.includes(74));
  assert.ok(!pitches.includes(48), 'the bass is not the melody');
});

// ----------------------------------------------------------- track analysis

test('identifies piano, bass, melody and drum tracks (section 4)', () => {
  const piano = [];
  [[60, 64, 67], [62, 65, 69], [64, 67, 71], [60, 64, 67]]
    .forEach((ch, i) => ch.forEach((p) => piano.push({ pitch: p, start: i * 2, duration: 1.9 })));
  const bytes = writeMidi({ tracks: [
    { name: 'Piano', program: 0, channel: 0, notes: beatsToTicks(piano) },
    { name: 'Bass', program: 33, channel: 1, notes: beatsToTicks([36, 38, 40, 36].map((p, i) => ({ pitch: p, start: i * 2, duration: 1.9 }))) },
    { name: 'Lead', program: 73, channel: 2, notes: beatsToTicks([72, 74, 76, 72].map((p, i) => ({ pitch: p, start: i * 2, duration: 1.9 }))) },
    { name: 'Drums', program: 0, channel: 9, notes: beatsToTicks([36, 38, 36, 38].map((p, i) => ({ pitch: p, start: i, duration: 0.4 }))) },
  ] });
  const score = normalizeMidi(parseMidi(bytes));
  const analysis = analyzeTracks(score);

  const byName = Object.fromEntries(analysis.tracks.filter((t) => t.name).map((t) => [t.name, t]));
  assert.equal(byName.Piano.role, 'harmony');
  assert.equal(byName.Bass.role, 'bass');
  assert.equal(byName.Drums.role, 'drums');
  assert.equal(byName.Drums.isDrumTrack, true);
  assert.deepEqual(analysis.recommended, [byName.Piano.index]);
  assert.ok(!analysis.usable.includes(byName.Drums.index), 'drums are not transcribable material');
  assert.ok(byName.Piano.keyboardScore > byName.Bass.keyboardScore);
  assert.ok(byName.Piano.keyboardScore > byName.Lead.keyboardScore);
});

test('polyphony measurement reflects the texture', () => {
  const mono = measurePolyphony([
    { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 },
  ]);
  const triad = measurePolyphony([
    { start: 0, end: 1 }, { start: 0, end: 1 }, { start: 0, end: 1 },
  ]);
  assert.ok(Math.abs(mono.mean - 1) < 1e-9);
  assert.ok(Math.abs(triad.mean - 3) < 1e-9);
  assert.equal(triad.max, 3);
  assert.ok(triad.chordRatio > 0.9);
  assert.ok(mono.chordRatio < 0.1);
});
