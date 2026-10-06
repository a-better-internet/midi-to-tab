/**
 * Application shell.
 *
 * This is the only file that knows about both the engine and the DOM. The
 * engine is called through `transcribe` / `applyChordOverride` /
 * `applyVoicingChoice` and never reaches back into the interface, which is the
 * separation section 36 asks for.
 *
 * State is deliberately small: the parsed score, the current settings, and the
 * latest transcription. Everything else is derived.
 */

import { parseMidi } from './midi/parser.js';
import { normalizeMidi } from './midi/normalizer.js';
import { analyzeTracks } from './analysis/trackAnalyzer.js';
import {
  transcribe, applyChordOverride, applyVoicingChoice, DEFAULT_SETTINGS,
} from './transcription/pipeline.js';
import { renderTabAscii } from './transcription/tabGenerator.js';
import { Player, guitarNotesFromTab, PLAYBACK_MODES } from './audio/midiPlayer.js';
import { PianoRoll, ROLE_LEGEND } from './ui/pianoRoll.js';
import { FretboardView } from './ui/fretboard.js';
import { TabRenderer } from './ui/tabRenderer.js';
import { ChordEditor } from './ui/chordEditor.js';
import { Controls } from './ui/controls.js';

const $ = (id) => document.getElementById(id);

const state = {
  fileName: null,
  score: null,
  trackAnalysis: null,
  settings: { ...DEFAULT_SETTINGS },
  source: null,
  result: null,
  selectedEventId: null,
  playbackMode: 'both',
};

let pianoRoll;
let fretboardView;
let tabRenderer;
let chordEditor;
let controls;
const player = new Player();

/* ------------------------------------------------------------------ errors */

function showNotice(message, kind = 'error') {
  const host = $('notices');
  host.textContent = '';
  if (!message) return;
  const el = document.createElement('div');
  el.className = `notice${kind === 'working' ? ' working' : ''}`;
  el.textContent = message;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.append(el);
}

/* -------------------------------------------------------------- file input */

async function loadFile(file) {
  showNotice(`Reading ${file.name}…`, 'working');
  try {
    const buffer = await file.arrayBuffer();
    const midi = parseMidi(buffer);
    const score = normalizeMidi(midi);

    if (score.notes.length === 0) {
      showNotice('That file parsed, but it contains no notes.');
      return;
    }

    const trackAnalysis = analyzeTracks(score);
    if (trackAnalysis.recommended.length === 0) {
      showNotice('That file has no pitched material to transcribe — only drums or empty tracks.');
      return;
    }

    state.fileName = file.name;
    state.score = score;
    state.trackAnalysis = trackAnalysis;
    state.source = {
      mode: trackAnalysis.recommendedMode,
      trackIndices: [...trackAnalysis.recommended],
    };
    state.settings = { ...DEFAULT_SETTINGS, source: state.source };
    state.selectedEventId = null;

    $('file-name').textContent = file.name;
    $('dropzone').hidden = true;
    $('workspace').hidden = false;
    showNotice(null);

    retranscribe();
  } catch (error) {
    console.error(error);
    showNotice(`Could not read that file: ${error.message}`);
  }
}

/* ------------------------------------------------------------- the pipeline */

function retranscribe() {
  if (!state.score) return;
  const started = performance.now();
  try {
    state.result = transcribe(state.score, { ...state.settings, source: state.source });
  } catch (error) {
    console.error(error);
    showNotice(`Transcription failed: ${error.message}`);
    return;
  }
  state.elapsedMs = performance.now() - started;
  afterResult();
}

function afterResult() {
  const result = state.result;
  pianoRoll.setResult(result);
  tabRenderer.setTab(result.tab);
  chordEditor.setResult(result);
  controls.timingCharacter = result.stats.timingCharacter;
  controls.setState({
    settings: state.settings,
    trackAnalysis: state.trackAnalysis,
    score: state.score,
    source: state.source,
  });
  renderStats();

  player.setSources({
    timing: state.score.timing,
    midiNotes: result.sourceNotes,
    guitarNotes: guitarNotesFromTab(result.tab),
    endBeat: result.tab.totalBeats,
  });

  // Keep the selection if it still exists, otherwise select the first chord.
  const stillThere = result.transcribed.some((t) => t.event.id === state.selectedEventId);
  const firstChord = result.transcribed.find((t) => t.event.kind === 'chord');
  selectEvent(stillThere ? state.selectedEventId : (firstChord ? firstChord.event.id : null));
}

function selectEvent(eventId, { audition = false } = {}) {
  state.selectedEventId = eventId;
  pianoRoll.setSelected(eventId);
  tabRenderer.setSelected(eventId);
  if (eventId === null) {
    chordEditor.clear();
    fretboardView.show(null, null);
    return;
  }
  chordEditor.select(eventId);
  const item = state.result.transcribed.find((t) => t.event.id === eventId);
  fretboardView.show(item ? item.voicing : null, state.result.tuning);

  // Hearing the shape is the whole point of picking it, so a click plays it.
  // Selections the app makes for itself (after a re-transcription, say) stay
  // silent.
  if (audition && item) auditionVoicing(item.voicing);
}

function auditionVoicing(voicing) {
  if (!voicing || player.playing) return;
  player.audition(voicing.played.map((p) => ({
    pitch: p.pitch,
    string: p.string,
    stringCount: state.result.tuning.stringCount,
  }))).catch((error) => showNotice(`Audio could not start: ${error.message}`));
}

/* -------------------------------------------------------------- statistics */

function renderStats() {
  const host = $('stats');
  host.textContent = '';
  const { stats, analysis } = state.result;

  const rows = [
    ['Key', `${stats.key.name} (${Math.round(stats.key.confidence * 100)}%)`,
      stats.key.confidence >= 0.7 ? 'ok' : 'warn'],
    ['Tempo', `${state.score.tempo.toFixed(1)} bpm`],
    ['Metre', `${state.score.timeSignature.numerator}/${state.score.timeSignature.denominator}`],
    ['Notes read', String(stats.noteCount)],
    ['Events', `${stats.eventCount} (${stats.regionCount} harmonies)`],
    ['Arpeggios', String(stats.arpeggioCount)],
    ['Grouping window', `${stats.groupWindowMs.toFixed(0)} ms`],
    ['Mean confidence', `${Math.round(stats.meanConfidence * 100)}%`,
      stats.meanConfidence >= 0.8 ? 'ok' : stats.meanConfidence >= 0.6 ? 'warn' : 'bad'],
    ['Uncertain chords', String(stats.lowConfidenceCount),
      stats.lowConfidenceCount === 0 ? 'ok' : 'warn'],
    ['Hand movement', `${stats.movement.totalMovement} frets, ${stats.movement.jumps} jump${stats.movement.jumps === 1 ? '' : 's'}`,
      stats.movement.jumps === 0 ? 'ok' : 'warn'],
    ['Unplayable', String(stats.unplayableCount), stats.unplayableCount === 0 ? 'ok' : 'bad'],
  ];

  if (stats.outOfPositionCount > 0) {
    rows.push(['Out of position', String(stats.outOfPositionCount), 'warn']);
  }
  if (state.elapsedMs) rows.push(['Analysed in', `${state.elapsedMs.toFixed(0)} ms`]);

  const list = document.createElement('div');
  list.className = 'status-list';
  for (const [key, value, kind] of rows) {
    const row = document.createElement('div');
    row.className = 'status-item';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = `v${kind ? ` ${kind}` : ''}`;
    v.textContent = value;
    row.append(k, v);
    list.append(row);
  }
  host.append(list);

  $('progression').textContent = analysis.regions
    .map((r) => (r.chord ? r.chord.symbol : '?'))
    .join('  ');
  $('roman').textContent = analysis.regions.map((r) => r.roman ?? '?').join('  ');
  $('tab-meta').textContent = `${state.result.transcribed.length} events · ${state.result.tuning.name}`;
}

/* ----------------------------------------------------------- settings flow */

function onSettingsChange(patch) {
  // A few controls need translating before they reach the engine.
  if ('sourceTrack' in patch) {
    state.source = { mode: 'single', trackIndices: [patch.sourceTrack] };
    delete patch.sourceTrack;
  }
  if ('sourceMode' in patch) {
    const mode = patch.sourceMode;
    state.source = {
      mode,
      trackIndices: mode === 'single'
        ? (state.source?.trackIndices?.length ? state.source.trackIndices : state.trackAnalysis.recommended)
        : [],
    };
    delete patch.sourceMode;
  }
  if ('contextWeightPercent' in patch) {
    patch.contextWeight = patch.contextWeightPercent / 100;
    delete patch.contextWeightPercent;
  }
  if ('groupWindowMs' in patch && patch.groupWindowMs === 0) {
    patch.groupWindowMs = null;
  }
  if (patch.tuning === 'custom' && !state.settings.customTuning) {
    patch.customTuning = { id: 'custom', name: 'Custom', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] };
  }

  state.settings = { ...state.settings, ...patch };
  retranscribe();
}

/* ------------------------------------------------------------- interactions */

function onChordChange(regionIndex, chord) {
  try {
    state.result = applyChordOverride(state.score, state.result, regionIndex, chord);
  } catch (error) {
    console.error(error);
    showNotice(`Could not apply that chord: ${error.message}`);
    return;
  }
  afterResult();
}

function onVoicingChange(eventId, voicing) {
  auditionVoicing(voicing);
  state.result = applyVoicingChoice(state.result, eventId, voicing);
  pianoRoll.setResult(state.result);
  tabRenderer.setTab(state.result.tab);
  chordEditor.setResult(state.result);
  player.setSources({
    timing: state.score.timing,
    midiNotes: state.result.sourceNotes,
    guitarNotes: guitarNotesFromTab(state.result.tab),
    endBeat: state.result.tab.totalBeats,
  });
  selectEvent(eventId);
}

/* ---------------------------------------------------------------- playback */

function formatTime(beat) {
  if (!state.score) return '0:00';
  const seconds = Math.max(0, state.score.timing.beatsToSeconds(beat));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function updateTransport(playbackState) {
  const beat = playbackState?.beat ?? 0;
  const playing = playbackState?.playing ?? false;
  const endBeat = state.result?.tab.totalBeats ?? 0;
  $('play-button').textContent = playbackState?.playing ? '⏸' : '▶';
  $('play-button').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const scrub = $('scrub');
  if (document.activeElement !== scrub) {
    scrub.max = String(Math.max(1, endBeat));
    scrub.value = String(Math.min(beat, endBeat));
  }
  const bar = state.score ? state.score.timing.barAndBeat(beat).bar : 1;
  $('time-display').textContent = `${formatTime(beat)} / ${formatTime(endBeat)}  bar ${bar}`;
  $('count-in-flash').textContent = playbackState?.countingIn ? 'count in…' : '';

  pianoRoll?.setPlayhead(beat);
  // Following only while playing: scrolling the tab out from under someone
  // who is reading it would be worse than not following at all.
  if (playing) tabRenderer?.setPlayhead(beat, { follow: true });
  else tabRenderer?.clearPlayhead();
}

/* ------------------------------------------------------------------ exports */

function downloadText(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function baseName() {
  return (state.fileName ?? 'transcription').replace(/\.midi?$/i, '');
}

function exportTab() {
  const header = [
    `${baseName()} — guitar transcription`,
    `Key: ${state.result.stats.key.name}`,
    `Tempo: ${state.score.tempo.toFixed(1)} bpm`,
    `Chords: ${state.result.analysis.regions.map((r) => (r.chord ? r.chord.symbol : '?')).join(' ')}`,
    '',
  ].join('\n');
  downloadText(`${baseName()}.tab.txt`, header + renderTabAscii(state.result.tab, { columnsPerLine: 14 }));
}

function exportJson() {
  // The analysis, not the internals: what was heard and what was decided.
  const payload = {
    file: state.fileName,
    settings: state.settings,
    key: {
      name: state.result.stats.key.name,
      confidence: state.result.stats.key.confidence,
    },
    tuning: {
      name: state.result.tuning.name,
      strings: state.result.tuning.stringNames,
      capo: state.result.tuning.capo,
    },
    harmony: state.result.analysis.regions.map((region) => ({
      start: region.start,
      end: region.end,
      chord: region.chord ? region.chord.symbol : null,
      roman: region.roman,
      confidence: region.confidence,
      alternatives: region.candidates.slice(1, 4).map((c) => ({
        symbol: c.symbol, confidence: c.confidence,
      })),
    })),
    tab: state.result.tab.columns.map((column) => ({
      bar: column.metric.bar,
      beat: column.start,
      duration: column.duration,
      value: column.value.symbol,
      chord: column.chordLabel,
      frets: column.strings,
      techniques: column.techniques.map((t) => t.type),
    })),
  };
  downloadText(`${baseName()}.analysis.json`, JSON.stringify(payload, null, 2), 'application/json');
}

/* -------------------------------------------------------------------- setup */

function buildLegend() {
  const host = $('legend');
  for (const entry of ROLE_LEGEND) {
    const span = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = entry.color;
    span.append(swatch, document.createTextNode(entry.label));
    host.append(span);
  }
}

function wireFileInput() {
  const input = $('file-input');
  const dropzone = $('dropzone');

  input.addEventListener('change', () => {
    if (input.files?.[0]) loadFile(input.files[0]);
  });
  for (const button of document.querySelectorAll('[data-open-file]')) {
    button.addEventListener('click', () => input.click());
  }

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (event) => {
      stop(event);
      dropzone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    document.addEventListener(type, (event) => {
      stop(event);
      if (type === 'dragleave' && event.relatedTarget) return;
      dropzone.classList.remove('over');
    });
  }
  document.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.midi?$/i.test(file.name)) {
      showNotice('That does not look like a .mid or .midi file.');
      return;
    }
    loadFile(file);
  });
}

function wireTransport() {
  $('play-button').addEventListener('click', async () => {
    if (!state.result) return;
    try {
      if (player.playing) player.pause();
      else await player.play();
    } catch (error) {
      showNotice(`Audio could not start: ${error.message}`);
    }
  });

  $('stop-button').addEventListener('click', () => player.stop({ rewind: true }));

  $('scrub').addEventListener('input', (event) => {
    player.seek(Number(event.target.value));
  });

  const modeGroup = $('playback-mode');
  for (const [mode, label] of Object.entries(PLAYBACK_MODES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(mode === state.playbackMode));
    button.addEventListener('click', () => {
      state.playbackMode = mode;
      player.setMode(mode);
      for (const sibling of modeGroup.children) {
        sibling.setAttribute('aria-pressed', String(sibling === button));
      }
    });
    modeGroup.append(button);
  }

  $('volume').addEventListener('input', (event) => {
    player.volume = Number(event.target.value) / 100;
  });

  $('speed').addEventListener('change', (event) => {
    player.setRate(Number(event.target.value));
  });

  $('count-in').addEventListener('change', (event) => {
    player.countInBeats = Number(event.target.value);
  });

  player.onTick(updateTransport);
  updateTransport(null);

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      $('play-button').click();
    }
  });
}

function init() {
  pianoRoll = new PianoRoll($('piano-roll'), {
    onSeek: (beat) => player.seek(beat),
    onSelect: (eventId) => { if (eventId !== null) selectEvent(eventId, { audition: true }); },
  });
  fretboardView = new FretboardView($('fretboard-diagram'));
  tabRenderer = new TabRenderer($('tab-view'), {
    onSelect: (eventId) => selectEvent(eventId, { audition: true }),
  });
  chordEditor = new ChordEditor({
    detail: $('event-detail'),
    candidates: $('chord-candidates'),
    quickPick: $('chord-quickpick'),
    voicings: $('voicing-options'),
  }, { onChordChange, onVoicingChange });
  controls = new Controls($('controls'), onSettingsChange);

  buildLegend();
  wireFileInput();
  wireTransport();
  chordEditor.clear();

  $('export-tab').addEventListener('click', exportTab);
  $('export-json').addEventListener('click', exportJson);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exposed for debugging in the console and for the browser audio check;
// the engine itself never reads this.
globalThis.midiToTab = { state, retranscribe, player };
