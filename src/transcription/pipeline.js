/**
 * Engine orchestration: MIDI score in, guitar transcription out.
 *
 * This is the seam the brief draws in section 36 -- "keep harmonic analysis
 * independent from UI". Everything above this line is pure analysis and pure
 * fretboard maths; the UI only ever calls `transcribe()` and reads the result.
 * That is also what makes the same engine retargetable to bass, ukulele or
 * banjo: those are just different tunings (see guitar/tuning.js).
 */

import { analyzeHarmony, overrideRegionChord } from './eventBuilder.js';
import { selectSourceNotes, analyzeTracks } from '../analysis/trackAnalyzer.js';
import { resolveTuning } from '../guitar/tuning.js';
import { Fretboard, POSITION_WINDOWS } from '../guitar/fretboard.js';
import { generateVoicings } from '../guitar/voicingGenerator.js';
import { optimizeVoicingSequence, measureSequenceMovement } from '../guitar/positionOptimizer.js';
import { buildTab, buildChordChart } from './tabGenerator.js';
import { ROLES } from '../analysis/noteRoleClassifier.js';

/** Everything the user can steer (brief section 30), with its defaults. */
export const DEFAULT_SETTINGS = {
  // source
  source: { mode: 'single', trackIndices: [] },

  // instrument
  tuning: 'standard',
  customTuning: null,
  capo: 0,
  fretCount: 22,

  // interpretation
  transcriptionMode: 'balanced', // literal | balanced | playable
  chordComplexity: 'extended', // basic | extended | exact
  guitarPosition: 'auto', // open | low | mid | high | auto
  preservePianoVoicing: false,
  includeExtensions: 'sevenths', // triads | sevenths | ninths | all
  maxFretSpan: 4,

  // analysis tuning
  groupWindowMs: null, // null = adapt to the performance
  clusterThreshold: 0.52,
  clusterWeights: null,
  contextWeight: 0.45,
  detectArpeggios: true,

  // guitar search
  maxCandidates: 120,
  beamWidth: 14,
  transitionWeight: 0.55,
};

/**
 * Which events are worth putting on the page in each mode.
 * Literal keeps everything; Playable sheds pure decoration.
 */
function shouldRenderEvent(event, mode) {
  if (mode === 'literal') return true;
  const roles = event.notes.map((n) => n.role);
  const allOrnament = roles.length > 0 && roles.every((r) => r === ROLES.ORNAMENT);
  if (allOrnament && mode === 'playable') return false;
  return true;
}

/**
 * Run the whole pipeline.
 *
 * @param {object} score normalized MIDI (from normalizeMidi)
 * @param {object} [settings] see DEFAULT_SETTINGS
 * @returns {object} transcription result
 */
export function transcribe(score, settings = {}) {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  const trackAnalysis = analyzeTracks(score);

  // Default the source selection to whatever the track analyzer recommends.
  const source = config.source && (config.source.trackIndices?.length || config.source.mode !== 'single')
    ? config.source
    : { mode: trackAnalysis.recommendedMode, trackIndices: trackAnalysis.recommended };

  const notes = selectSourceNotes(score, source);

  const analysis = analyzeHarmony(notes, {
    chordComplexity: config.chordComplexity,
    clusterWeights: config.clusterWeights ?? undefined,
    groupWindowMs: config.groupWindowMs,
    clusterThreshold: config.clusterThreshold,
    contextWeight: config.contextWeight,
    detectArpeggios: config.detectArpeggios,
  });

  const result = realize(score, analysis, config, { trackAnalysis, source, notes });
  return result;
}

/**
 * Turn a finished harmonic analysis into guitar output.
 *
 * Split out from `transcribe` so a chord correction (section 32) or a settings
 * change can re-run only this half -- the MIDI is never re-read and the
 * analysis is never thrown away (section 2).
 */
export function realize(score, analysis, settings = {}, context = {}) {
  const config = { ...DEFAULT_SETTINGS, ...settings };

  const tuning = resolveTuning(
    config.tuning === 'custom' && config.customTuning ? config.customTuning : config.tuning,
    { capo: config.capo },
  );
  const fretboard = new Fretboard(tuning, { fretCount: config.fretCount });

  const window = POSITION_WINDOWS[config.guitarPosition] ?? POSITION_WINDOWS.auto;

  const renderable = analysis.events.filter((e) => shouldRenderEvent(e, config.transcriptionMode));

  const events = renderable.map((event) => {
    const candidates = generateVoicings(event, fretboard, {
      maxFretSpan: config.maxFretSpan,
      minFret: window.minFret ?? 0,
      maxFret: window.maxFret,
      maxCandidates: config.maxCandidates,
      includeExtensions: config.includeExtensions,
      transcriptionMode: config.transcriptionMode,
      preservePianoVoicing: config.preservePianoVoicing,
    });

    // If a narrow position window strangles the search, open it up rather than
    // emitting nothing: a chord out of position is better than no chord.
    const fallback = candidates.length === 0 && window.maxFret !== null
      ? generateVoicings(event, fretboard, {
        maxFretSpan: config.maxFretSpan + 1,
        maxCandidates: config.maxCandidates,
        includeExtensions: config.includeExtensions,
        transcriptionMode: config.transcriptionMode,
        preservePianoVoicing: config.preservePianoVoicing,
      })
      : [];

    return { ...event, candidates: candidates.length ? candidates : fallback };
  });

  const optimizerOptions = {
    positionWindow: window,
    beamWidth: config.beamWidth,
    transitionWeight: config.transitionWeight,
    preservePianoVoicing: config.preservePianoVoicing,
  };

  // Two passes. The first decides the chord shapes; the second re-runs the
  // decode knowing which strings those shapes occupy, so a melody note over a
  // held chord is nudged onto a free string. Candidates are reused, so this
  // costs one extra decode and no extra search.
  const firstPass = optimizeVoicingSequence(events, fretboard, optimizerOptions);

  const held = [];
  events.forEach((event, i) => {
    const chosen = firstPass[i] && firstPass[i].voicing;
    if (!chosen || event.kind !== 'chord') return;
    held.push({
      start: event.start,
      end: event.end,
      strings: new Set(chosen.played.map((p) => p.string)),
    });
  });

  const occupiedAt = (beat) => {
    const strings = new Set();
    for (const span of held) {
      if (span.start <= beat + 1e-9 && beat < span.end - 1e-9) {
        for (const s of span.strings) strings.add(s);
      }
    }
    return strings;
  };

  const annotated = events.map((event) => {
    if (event.kind === 'chord') return event;
    const occupied = occupiedAt(event.start);
    if (occupied.size === 0) return event;
    return {
      ...event,
      candidates: event.candidates.map((candidate) => ({
        ...candidate,
        stringCollision: candidate.played.some((p) => occupied.has(p.string)),
      })),
    };
  });

  const optimized = held.length > 0
    ? optimizeVoicingSequence(annotated, fretboard, optimizerOptions)
    : firstPass;

  const inWindow = (voicing) => {
    if (window.maxFret === null || window.maxFret === undefined) return true;
    if (voicing.fretSpan === 0) return true; // open shapes are position-free
    return voicing.minFret >= (window.minFret ?? 0) && voicing.maxFret <= window.maxFret;
  };

  const transcribed = annotated.map((event, i) => {
    const voicing = optimized[i] ? optimized[i].voicing : null;
    return {
      event,
      voicing,
      alternatives: optimized[i] ? optimized[i].alternatives : [],
      score: optimized[i] ? optimized[i].score : 0,
      parts: optimized[i] ? optimized[i].parts : null,
      // A high melody note simply cannot be played in open position. When the
      // engine has to leave the requested region it says so, rather than
      // silently dropping the note or pretending it complied.
      outOfPosition: voicing ? !inWindow(voicing) : false,
    };
  }).filter((item) => item.voicing);

  const tab = buildTab(transcribed, {
    timing: score.timing,
    tuning,
    endBeats: score.durationBeats,
  });

  const movement = measureSequenceMovement(optimized);
  const unplayable = transcribed.filter((t) => t.voicing.fingering && !t.voicing.fingering.playable);
  const lowConfidence = analysis.regions.filter((r) => (r.confidence ?? 0) < 0.6);

  return {
    settings: config,
    source: context.source ?? config.source,
    trackAnalysis: context.trackAnalysis ?? null,
    sourceNotes: context.notes ?? analysis.notes,
    analysis,
    tuning,
    fretboard,
    transcribed,
    tab,
    chart: buildChordChart(tab),
    stats: {
      noteCount: analysis.notes.length,
      clusterCount: analysis.clusters.length,
      eventCount: analysis.events.length,
      renderedCount: transcribed.length,
      regionCount: analysis.regions.length,
      arpeggioCount: analysis.arpeggios.length,
      key: analysis.key,
      movement,
      unplayableCount: unplayable.length,
      outOfPositionCount: transcribed.filter((t) => t.outOfPosition).length,
      lowConfidenceCount: lowConfidence.length,
      meanConfidence: analysis.regions.length
        ? analysis.regions.reduce((a, r) => a + (r.confidence ?? 0), 0) / analysis.regions.length
        : 0,
      timingCharacter: analysis.timingCharacter,
      groupWindowMs: analysis.groupWindowMs,
    },
  };
}

/**
 * Apply a manual chord correction and regenerate the guitar part (section 32).
 */
export function applyChordOverride(score, result, regionIndex, chord) {
  const analysis = overrideRegionChord(result.analysis, regionIndex, chord);
  return realize(score, analysis, result.settings, {
    trackAnalysis: result.trackAnalysis,
    source: result.source,
    notes: result.sourceNotes,
  });
}

/**
 * Swap in one of the alternative voicings for a single event (section 34),
 * leaving the rest of the transcription untouched.
 */
export function applyVoicingChoice(result, eventId, voicing) {
  const transcribed = result.transcribed.map((item) => {
    if (item.event.id !== eventId) return item;
    const alternatives = [
      ...item.alternatives.filter((a) => a.voicing !== voicing),
      { voicing: item.voicing, score: item.score, parts: item.parts },
    ];
    return { ...item, voicing, alternatives, manual: true };
  });

  const tab = buildTab(transcribed, {
    timing: result.tab.timing,
    tuning: result.tuning,
    endBeats: result.tab.totalBeats,
  });

  return { ...result, transcribed, tab, chart: buildChordChart(tab) };
}
