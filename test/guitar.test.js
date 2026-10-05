import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTuning, parseCustomTuning, stringLabel, TUNINGS, TUNINGS_BY_ID,
} from '../src/guitar/tuning.js';
import { Fretboard, POSITION_WINDOWS } from '../src/guitar/fretboard.js';
import {
  generateVoicings, buildVoicingTargets, formatShape, EXTENSION_LEVELS,
} from '../src/guitar/voicingGenerator.js';
import { analyzeFingering, transitionDifficulty, stretchDifficulty } from '../src/guitar/fingering.js';
import {
  scoreVoicing, voiceLeadingDistance, transitionCost, pitchAccuracyScore,
  voicingSimilarityScore, positionWindowScore,
} from '../src/guitar/voicingScorer.js';
import { optimizeVoicingSequence, measureSequenceMovement } from '../src/guitar/positionOptimizer.js';
import { recognizeChord } from '../src/analysis/chordRecognizer.js';
import { pitchToName } from '../src/midi/normalizer.js';

const standard = resolveTuning('standard');
const board = new Fretboard(standard, { fretCount: 22 });

/** Build a chord event the way eventBuilder would. */
function chordEvent(pitches, { duration = 2 } = {}) {
  const notes = pitches.map((p) => ({ pitch: p, duration, velocity: 80 }));
  const chord = recognizeChord(notes).best;
  const roled = pitches.map((p, i) => {
    const interval = ((p - chord.root) % 12 + 12) % 12;
    let role = 'CHORD_TONE';
    let priority = 2;
    if (i === 0) { role = 'BASS'; priority = 1; } else if (interval === 0) { role = 'ROOT'; priority = 1; }
    return { pitch: p, duration, velocity: 80, role, priority };
  });
  return { id: 0, kind: 'chord', chord, notes: roled, start: 0, end: duration, duration };
}

/** Build a voicing object directly from a fret array, for scoring tests. */
function shape(frets) {
  const played = [];
  frets.forEach((f, s) => {
    if (f !== null) played.push({ string: s, fret: f, pitch: board.openPitches[s] + f });
  });
  const fingered = played.filter((p) => p.fret > 0).map((p) => p.fret);
  return {
    frets,
    played,
    pitches: played.map((p) => p.pitch),
    stringsUsed: played.length,
    openStrings: played.filter((p) => p.fret === 0).length,
    minFret: fingered.length ? Math.min(...fingered) : 0,
    maxFret: fingered.length ? Math.max(...fingered) : 0,
    fretSpan: fingered.length ? Math.max(...fingered) - Math.min(...fingered) + 1 : 0,
    position: fingered.length ? Math.min(...fingered) : 0,
    mutedInterior: 0,
    coverage: 1,
    lowestPitch: Math.min(...played.map((p) => p.pitch)),
    highestPitch: Math.max(...played.map((p) => p.pitch)),
  };
}

// ----------------------------------------------------------------- tunings

test('standard tuning is E2 A2 D3 G3 B3 E4', () => {
  assert.deepEqual(standard.openPitches, [40, 45, 50, 55, 59, 64]);
  assert.deepEqual(standard.stringNames, ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']);
  assert.equal(standard.stringCount, 6);
});

test('every listed tuning resolves', () => {
  for (const tuning of TUNINGS) {
    const resolved = resolveTuning(tuning.id);
    assert.equal(resolved.openPitches.length, tuning.strings.length);
    assert.ok(resolved.openPitches.every((p) => Number.isFinite(p)));
  }
  assert.ok(TUNINGS_BY_ID.has('drop-d'));
  assert.ok(TUNINGS_BY_ID.has('dadgad'));
  assert.ok(TUNINGS_BY_ID.has('open-g'));
  assert.ok(TUNINGS_BY_ID.has('open-d'));
});

test('7- and 8-string tunings are supported (section 21)', () => {
  assert.equal(resolveTuning('seven-standard').stringCount, 7);
  assert.equal(resolveTuning('eight-standard').stringCount, 8);
  assert.equal(resolveTuning('seven-standard').stringNames[0], 'B1');
});

test('other fretted instruments work through the same model (section 36)', () => {
  assert.equal(resolveTuning('bass-4').instrument, 'bass');
  assert.equal(resolveTuning('ukulele').instrument, 'ukulele');
  assert.equal(resolveTuning('banjo-g').instrument, 'banjo');
  assert.deepEqual(resolveTuning('ukulele').stringNames, ['G4', 'C4', 'E4', 'A4']);
});

test('a capo raises every open string', () => {
  const capo3 = resolveTuning('standard', { capo: 3 });
  assert.deepEqual(capo3.openPitches, [43, 48, 53, 58, 62, 67]);
  assert.equal(capo3.capo, 3);
});

test('custom tunings parse from plain letters or note names', () => {
  assert.deepEqual(parseCustomTuning('D A D G A D').strings, ['D2', 'A2', 'D3', 'G3', 'A3', 'D4']);
  assert.deepEqual(parseCustomTuning('E A D G B E').strings, ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']);
  assert.deepEqual(parseCustomTuning('C G C F A D').strings, ['C2', 'G2', 'C3', 'F3', 'A3', 'D4']);
  assert.deepEqual(parseCustomTuning('E2 A2 D3').strings, ['E2', 'A2', 'D3']);
  assert.equal(parseCustomTuning('X Y'), null);
});

test('a custom tuning can be used directly', () => {
  const resolved = resolveTuning({ strings: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'], name: 'Open D' });
  assert.equal(resolved.openPitches[3], 54);
  assert.equal(resolved.name, 'Open D');
});

test('strings are labelled the way players number them', () => {
  assert.equal(stringLabel(standard, 0), '6th');
  assert.equal(stringLabel(standard, 5), '1st');
});

test('an unknown tuning id is rejected', () => {
  assert.throws(() => resolveTuning('not-a-tuning'), /Unknown tuning/);
});

// --------------------------------------------------------------- fretboard

test('lists every position for a pitch (section 20)', () => {
  // The brief's example: E4 on each string of a 24-fret guitar.
  const wide = new Fretboard(standard, { fretCount: 24 });
  const positions = wide.positionsFor(64);
  const byString = Object.fromEntries(positions.map((p) => [p.string, p.fret]));
  assert.deepEqual(byString, { 0: 24, 1: 19, 2: 14, 3: 9, 4: 5, 5: 0 });
  assert.equal(positions.find((p) => p.string === 5).isOpen, true);
});

test('knows what it cannot play, and folds it into range (section 26)', () => {
  assert.equal(board.canPlay(64), true);
  assert.equal(board.canPlay(96), false, 'C7 is above a 22-fret guitar');
  const folded = board.foldIntoRange(96);
  assert.equal(folded.pitch % 12, 0);
  assert.ok(board.canPlay(folded.pitch));
  assert.equal(folded.octaveShift, -1);

  const low = board.foldIntoRange(24); // C1, below the guitar
  assert.equal(low.pitch % 12, 0);
  assert.ok(low.pitch >= board.lowestPitch);
  assert.equal(pitchToName(low.pitch), 'C3');
});

test('reports its range and finds pitch classes', () => {
  const described = board.describe();
  assert.equal(described.range, 'E2-D6');
  const cs = board.positionsForPitchClass(0, { maxFret: 5 });
  assert.ok(cs.length > 0);
  assert.ok(cs.every((p) => p.pitch % 12 === 0));
  assert.equal(board.pitchAt(5, 0), 64);
  assert.equal(board.pitchAt(99, 0), null);
  assert.equal(board.pitchAt(0, 99), null);
});

test('position windows cover the section 30 options', () => {
  for (const key of ['open', 'low', 'mid', 'high', 'auto']) {
    assert.ok(POSITION_WINDOWS[key], `missing window: ${key}`);
  }
  assert.equal(POSITION_WINDOWS.auto.maxFret, null);
});

// ------------------------------------------------------ voicing generation

test('derives real voicings from the MIDI pitches, not a dictionary', () => {
  const event = chordEvent([48, 60, 64, 67]); // C major, C in the bass
  const candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 300 });
  assert.ok(candidates.length > 20, `only ${candidates.length} candidates`);

  const shapes = new Set(candidates.map(formatShape));
  // The two shapes section 22 lists for C major must both be reachable.
  assert.ok(shapes.has('x 3 2 0 1 0'), 'open C shape missing');
  assert.ok(shapes.has('8 10 10 9 8 8'), 'barre C shape missing');

  for (const candidate of candidates) {
    for (const pitch of candidate.pitches) {
      assert.ok(board.canPlay(pitch));
    }
  }
});

test('every candidate respects the maximum fret span (section 27)', () => {
  const event = chordEvent([48, 60, 64, 67]);
  for (const span of [3, 4, 5]) {
    const candidates = generateVoicings(event, board, { maxFretSpan: span, maxCandidates: 300 });
    for (const candidate of candidates) {
      assert.ok(candidate.fretSpan <= span,
        `${formatShape(candidate)} spans ${candidate.fretSpan}, limit ${span}`);
    }
  }
});

test('the bass note stays in the bass (section 12/26 priority 1)', () => {
  const event = chordEvent([40, 55, 60, 64]); // C/E
  const candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 300 });
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    const lowestPc = candidate.lowestPitch % 12;
    assert.ok(lowestPc === 4 || lowestPc === 0,
      `${formatShape(candidate)} has ${pitchToName(candidate.lowestPitch)} in the bass`);
  }
});

test('a position window constrains the search', () => {
  const event = chordEvent([48, 60, 64, 67]);
  const high = generateVoicings(event, board, {
    maxFretSpan: 4, minFret: 9, maxFret: 17, maxCandidates: 200,
  });
  assert.ok(high.length > 0);
  for (const candidate of high) {
    if (candidate.fretSpan === 0) continue; // all-open shapes are position-free
    assert.ok(candidate.minFret >= 9, `${formatShape(candidate)} is below fret 9`);
    assert.ok(candidate.maxFret <= 17);
  }
});

test('voicing targets follow section 26\'s priority hierarchy', () => {
  const event = {
    chord: recognizeChord([48, 60, 64, 67, 71].map((p) => ({ pitch: p, duration: 2 }))).best,
    notes: [
      { pitch: 48, role: 'BASS', priority: 1 },
      { pitch: 64, role: 'CHORD_TONE', priority: 2 },
      { pitch: 71, role: 'EXTENSION', priority: 3 },
      { pitch: 74, role: 'MELODY', priority: 4 },
      { pitch: 62, role: 'PASSING_TONE', priority: 5 },
    ],
  };
  const targets = buildVoicingTargets(event, { includeExtensions: 'ninths' });
  const byPc = new Map(targets.targets.map((t) => [t.pc, t]));
  assert.equal(byPc.get(0).priority, 1, 'bass/root is priority 1');
  assert.equal(byPc.get(4).priority, 2, 'chord quality is priority 2');
  assert.equal(byPc.get(11).priority, 3, 'extensions are priority 3');
  assert.equal(byPc.get(2).priority, 4, 'melody is priority 4');
  // The passing tone must not be treated as harmony (section 16).
  assert.ok(!byPc.has(62 % 12) || byPc.get(62 % 12).priority === 4);
  assert.equal(targets.bassPc, 0);
  assert.equal(targets.rootPc, 0);
});

test('Include Extensions controls which degrees are voiced (section 30)', () => {
  const event = chordEvent([48, 60, 64, 67, 70, 74]); // C9
  for (const level of Object.keys(EXTENSION_LEVELS)) {
    const targets = buildVoicingTargets(event, { includeExtensions: level });
    assert.ok(targets.allowedPcs.has(0), 'the root is always wanted');
    assert.ok(targets.allowedPcs.has(4), 'the third is always wanted');
  }
  const triads = buildVoicingTargets(event, { includeExtensions: 'triads' });
  const all = buildVoicingTargets(event, { includeExtensions: 'all' });
  assert.ok(all.allowedPcs.size >= triads.allowedPcs.size);
});

test('single notes get single-note voicings', () => {
  const event = {
    id: 1, kind: 'note', start: 0, end: 1, duration: 1,
    chord: null,
    notes: [{ pitch: 64, role: 'MELODY', priority: 4, duration: 1 }],
  };
  const candidates = generateVoicings(event, board, { maxCandidates: 10 });
  assert.ok(candidates.length > 1);
  for (const candidate of candidates) {
    assert.equal(candidate.stringsUsed, 1);
    assert.equal(candidate.pitches[0], 64);
    assert.equal(candidate.isSingleNote, true);
  }
});

test('a note outside the guitar range is folded, not dropped', () => {
  const event = {
    id: 1, kind: 'note', start: 0, end: 1, duration: 1, chord: null,
    notes: [{ pitch: 100, role: 'MELODY', priority: 4, duration: 1 }], // E7
  };
  const candidates = generateVoicings(event, board, { maxCandidates: 10 });
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].pitches[0] % 12, 100 % 12, 'pitch class is preserved');
  assert.ok(candidates[0].octaveShift < 0);
});

// --------------------------------------------------------------- fingering

test('rates real chord shapes sensibly', () => {
  const openE = analyzeFingering(shape([0, 2, 2, 1, 0, 0]), board);
  const openC = analyzeFingering(shape([null, 3, 2, 0, 1, 0]), board);
  const fBarre = analyzeFingering(shape([1, 3, 3, 2, 1, 1]), board);

  assert.ok(openE.playable && openC.playable && fBarre.playable);
  assert.ok(openE.difficulty < openC.difficulty, 'open E is the easiest shape there is');
  assert.ok(openC.difficulty < fBarre.difficulty, 'a barre is harder than open C');
  assert.equal(fBarre.barre.fret, 1);
  assert.ok(fBarre.fingersUsed >= 3);
});

test('rejects impossible stretches (section 27)', () => {
  // The brief's example of an undesirable shape: lowest fret 2, highest 9.
  const wide = analyzeFingering(shape([2, null, null, 9, null, null]), board);
  assert.equal(wide.playable, false);
  assert.ok(wide.issues.length > 0);
  assert.ok(wide.difficulty > 2);
});

test('a barre cannot cross a string that must ring open', () => {
  const blocked = analyzeFingering(shape([1, 0, 3, 3, 1, 1]), board);
  assert.equal(blocked.barre, null, 'an open string inside the barre makes it impossible');
});

test('stretch is harder low on the neck', () => {
  assert.ok(stretchDifficulty(4, 1) > stretchDifficulty(4, 12));
  assert.equal(stretchDifficulty(1, 5), 0);
});

test('an all-open shape needs no fingers', () => {
  const open = analyzeFingering(shape([0, 0, 0, 0, 0, 0]), board);
  assert.equal(open.difficulty, 0);
  assert.equal(open.fingersUsed, 0);
  assert.equal(open.isOpenShape, true);
});

test('hand movement between shapes is costed', () => {
  const near = transitionDifficulty(shape([null, 3, 2, 0, 1, 0]), shape([null, null, 0, 2, 3, 2]));
  const far = transitionDifficulty(shape([null, 3, 2, 0, 1, 0]), shape([null, 15, 14, 12, 13, 12]));
  assert.ok(far > near);
});

// ----------------------------------------------------------------- scoring

test('pitch accuracy rewards the actual MIDI pitches', () => {
  const event = chordEvent([48, 60, 64, 67]); // C3 C4 E4 G4
  // This shape holds all four source pitches exactly (E8=C3, D10=C4, G9=E4, B8=G4).
  const everyPitch = pitchAccuracyScore(shape([8, 10, 10, 9, 8, 8]), event);
  // The open C shape puts G an octave below where the pianist played it.
  const octaveDisplaced = pitchAccuracyScore(shape([null, 3, 2, 0, 1, 0]), event);
  // A bare power chord abandons the third altogether.
  const incomplete = pitchAccuracyScore(shape([null, 3, 5, null, null, null]), event);

  assert.equal(everyPitch, 1, 'reproducing every pitch is full marks');
  assert.ok(octaveDisplaced < everyPitch, 'octave displacement must cost something');
  assert.ok(octaveDisplaced > 0.85, 'but only a little -- the pitch class survives');
  assert.ok(incomplete < octaveDisplaced, 'a missing chord tone costs more than a moved one');
});

test('voicing similarity notices when bass and melody swap places', () => {
  const event = chordEvent([48, 60, 64, 67]);
  const faithful = voicingSimilarityScore(shape([null, 3, 2, 0, 1, 0]), event);
  const octaveUp = voicingSimilarityScore(shape([8, 10, 10, 9, 8, 8]), event);
  assert.ok(faithful > octaveUp);
});

test('voice-leading distance grows with movement (section 24)', () => {
  const c = shape([null, 3, 2, 0, 1, 0]);
  const am = shape([null, 0, 2, 2, 1, 0]);
  const cHigh = shape([8, 10, 10, 9, 8, 8]);
  assert.ok(voiceLeadingDistance(c, am) < voiceLeadingDistance(c, cHigh));
  assert.equal(voiceLeadingDistance(c, null), 0);
});

test('transition cost combines voice leading with position movement', () => {
  const c = shape([null, 3, 2, 0, 1, 0]);
  const near = transitionCost(c, shape([null, 0, 2, 2, 1, 0]));
  const far = transitionCost(c, shape([8, 10, 10, 9, 8, 8]));
  assert.ok(far > near);
  assert.ok(near >= 0 && far <= 1);
});

test('unplayable shapes are heavily penalized', () => {
  const event = chordEvent([48, 60, 64, 67]);
  const impossible = scoreVoicing(shape([2, null, null, 9, null, null]), event, board, {});
  const fine = scoreVoicing(shape([null, 3, 2, 0, 1, 0]), event, board, {});
  assert.ok(fine.score > impossible.score * 2);
});

test('position window scoring prefers the requested region', () => {
  const low = shape([null, 3, 2, 0, 1, 0]);
  const high = shape([8, 10, 10, 9, 8, 8]);
  assert.equal(positionWindowScore(high, POSITION_WINDOWS.mid), 1);
  assert.ok(positionWindowScore(high, POSITION_WINDOWS.open) < 1);
  assert.equal(positionWindowScore(low, POSITION_WINDOWS.auto), 1);
});

// -------------------------------------------------------------- optimizer

test('optimizes the sequence, not each chord alone (section 24)', () => {
  const events = [[48, 60, 64, 67], [41, 60, 65, 69], [43, 59, 62, 67]].map((p) => chordEvent(p));
  for (const event of events) {
    event.candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 200 });
  }
  const optimized = optimizeVoicingSequence(events, board, {});
  const greedy = optimizeVoicingSequence(events, board, { transitionWeight: 0 });

  const optimizedMovement = measureSequenceMovement(optimized);
  const greedyMovement = measureSequenceMovement(greedy);
  assert.ok(optimizedMovement.totalMovement <= greedyMovement.totalMovement,
    `optimized moved ${optimizedMovement.totalMovement}, greedy ${greedyMovement.totalMovement}`);
  assert.equal(optimizedMovement.jumps, 0, 'C-F-G should need no position jumps');

  // All three shapes should sit in the low neck, as section 24 wants.
  for (const result of optimized) {
    assert.ok(result.voicing.position <= 5,
      `${formatShape(result.voicing)} is at position ${result.voicing.position}`);
  }
});

test('produces the idiomatic open-position shapes for C-F-G', () => {
  const events = [[48, 60, 64, 67], [41, 60, 65, 69], [43, 59, 62, 67]].map((p) => chordEvent(p));
  for (const event of events) {
    event.candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 200 });
  }
  const shapes = optimizeVoicingSequence(events, board, {}).map((r) => formatShape(r.voicing));
  assert.equal(shapes[0], 'x 3 2 0 1 0');
  assert.ok(shapes[1].startsWith('1 3 3 2'), `F was ${shapes[1]}`);
  assert.ok(shapes[2].startsWith('3 2 0 0 0'), `G was ${shapes[2]}`);
});

test('offers alternative voicings for each event (section 34)', () => {
  const event = chordEvent([48, 60, 64, 67]);
  event.candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 200 });
  const [result] = optimizeVoicingSequence([event], board, {});
  assert.ok(result.alternatives.length > 1);
  for (const alternative of result.alternatives) {
    assert.notEqual(formatShape(alternative.voicing), formatShape(result.voicing));
  }
});

test('an event with no candidates does not break the decode', () => {
  const event = chordEvent([48, 60, 64, 67]);
  event.candidates = generateVoicings(event, board, { maxFretSpan: 4, maxCandidates: 50 });
  const empty = { ...chordEvent([48, 60, 64, 67]), candidates: [] };
  const results = optimizeVoicingSequence([event, empty], board, {});
  assert.equal(results.length, 2);
  assert.ok(results[0].voicing);
  assert.equal(results[1].voicing, null);
});
