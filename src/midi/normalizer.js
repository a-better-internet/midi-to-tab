/**
 * Turn raw SMF events into the normalized note stream the analysis layer wants.
 *
 * The shape is exactly the one specified in section 3 of the brief:
 *
 *   { pitch, start, duration, velocity, channel, track }
 *
 * plus the wall-clock mirrors (`startSec`, `durationSec`) the clusterer needs,
 * the original ticks (so nothing is lost), and a stable `id` so the UI can
 * cross-reference a note between the piano roll, the tab and the analysis.
 *
 * Crucially: NOTHING IS QUANTIZED HERE. Section 3 is explicit about this -- the
 * raw timing is the only evidence we have about whether four note-ons were one
 * chord or four melodic notes.
 */

import { TimingMap } from './timing.js';

const GM_INSTRUMENT_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

export function gmInstrumentName(program) {
  return GM_INSTRUMENT_NAMES[program] ?? `Program ${program}`;
}

const SUSTAIN_CONTROLLER = 64;

/**
 * Default pitch-bend range in semitones. The real range is set per-instrument
 * through RPN 0, which most keyboard exports never send, so +/- 2 is the
 * sensible assumption.
 */
const DEFAULT_BEND_RANGE = 2;

/**
 * Extract notes from one track's event list.
 * Handles overlapping identical pitches (a stack per pitch/channel) and
 * optionally extends releases using the sustain pedal.
 */
function extractTrackNotes(track, timing, options) {
  const { applySustain = true } = options;
  const notes = [];
  const active = new Map(); // `${channel}:${note}` -> array of pending note-ons
  const programByChannel = new Map();
  const pedalDown = new Map(); // channel -> boolean
  const sustainedByChannel = new Map(); // channel -> notes waiting for pedal release
  const bendEvents = []; // { tick, channel, semitones }
  let trackName = null;
  let instrumentName = null;

  const keyOf = (channel, note) => `${channel}:${note}`;

  const release = (note, tick) => {
    note.endTick = Math.max(tick, note.startTick + 1);
  };

  for (const event of track.events) {
    switch (event.kind) {
      case 'meta':
        if (event.subtype === 'trackName' && !trackName) trackName = event.text.trim();
        if (event.subtype === 'instrumentName' && !instrumentName) instrumentName = event.text.trim();
        break;

      case 'programChange':
        if (!programByChannel.has(event.channel)) programByChannel.set(event.channel, event.program);
        break;

      case 'controller':
        if (applySustain && event.controller === SUSTAIN_CONTROLLER) {
          const down = event.value >= 64;
          const wasDown = pedalDown.get(event.channel) === true;
          pedalDown.set(event.channel, down);
          if (wasDown && !down) {
            const held = sustainedByChannel.get(event.channel) || [];
            for (const note of held) release(note, event.tick);
            sustainedByChannel.set(event.channel, []);
          }
        }
        break;

      case 'noteOn': {
        const note = {
          pitch: event.note,
          startTick: event.tick,
          endTick: null,
          velocity: event.velocity,
          channel: event.channel,
          track: track.index,
          program: programByChannel.get(event.channel) ?? null,
        };
        const key = keyOf(event.channel, event.note);
        if (!active.has(key)) active.set(key, []);
        active.get(key).push(note);
        notes.push(note);
        break;
      }

      case 'noteOff': {
        const key = keyOf(event.channel, event.note);
        const stack = active.get(key);
        if (!stack || stack.length === 0) break;
        const note = stack.shift();
        if (applySustain && pedalDown.get(event.channel) === true) {
          // Key released but pedal is down: the note keeps sounding.
          if (!sustainedByChannel.has(event.channel)) sustainedByChannel.set(event.channel, []);
          sustainedByChannel.get(event.channel).push(note);
          note.keyReleaseTick = event.tick;
        } else {
          release(note, event.tick);
        }
        break;
      }

      case 'pitchBend':
        bendEvents.push({
          tick: event.tick,
          channel: event.channel,
          semitones: (event.value / 8192) * DEFAULT_BEND_RANGE,
        });
        break;

      default:
        break;
    }
  }

  // Attach each bend to the notes sounding on its channel when it happened.
  if (bendEvents.length > 0) {
    for (const note of notes) {
      const during = bendEvents.filter(
        (b) => b.channel === note.channel
          && b.tick >= note.startTick
          && b.tick <= (note.endTick ?? note.startTick),
      );
      if (during.length === 0) continue;
      let peak = 0;
      for (const bend of during) {
        if (Math.abs(bend.semitones) > Math.abs(peak)) peak = bend.semitones;
      }
      if (Math.abs(peak) < 0.25) continue; // vibrato and drift, not a bend
      note.bend = {
        semitones: peak,
        direction: peak > 0 ? 'up' : 'down',
        releases: Math.abs(during[during.length - 1].semitones) < Math.abs(peak) * 0.4,
      };
    }
  }

  // Anything still ringing at the end of the track gets closed at the last tick.
  const lastTick = track.events.length ? track.events[track.events.length - 1].tick : 0;
  for (const stack of active.values()) {
    for (const note of stack) if (note.endTick === null) release(note, lastTick);
  }
  for (const held of sustainedByChannel.values()) {
    for (const note of held) if (note.endTick === null) release(note, lastTick);
  }

  const program = programByChannel.size === 1
    ? programByChannel.values().next().value
    : (programByChannel.get(0) ?? null);

  return {
    notes,
    trackName,
    instrumentName,
    program,
    programByChannel,
  };
}

/**
 * @param {object} midi parsed SMF
 * @param {object} [options]
 * @param {boolean} [options.applySustain=true] extend notes under CC64
 * @returns {object} normalized score
 */
export function normalizeMidi(midi, options = {}) {
  const timing = new TimingMap(midi);
  const tracks = [];
  const allNotes = [];
  let noteId = 0;

  for (const track of midi.tracks) {
    const extracted = extractTrackNotes(track, timing, options);
    const notes = extracted.notes
      .map((note) => {
        const start = timing.ticksToBeats(note.startTick);
        const end = timing.ticksToBeats(note.endTick);
        const startSec = timing.ticksToSeconds(note.startTick);
        const endSec = timing.ticksToSeconds(note.endTick);
        return {
          id: noteId++,
          pitch: note.pitch,
          start,
          duration: Math.max(end - start, 1e-6),
          end,
          velocity: note.velocity,
          channel: note.channel,
          track: note.track,
          startTick: note.startTick,
          endTick: note.endTick,
          startSec,
          durationSec: Math.max(endSec - startSec, 1e-6),
          endSec,
          program: note.program,
          bend: note.bend ?? null,
        };
      })
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

    const channels = [...new Set(notes.map((n) => n.channel))].sort((a, b) => a - b);
    const isDrumTrack = channels.length > 0 && channels.every((c) => c === 9);

    tracks.push({
      index: track.index,
      name: extracted.trackName || null,
      instrumentName: extracted.instrumentName
        || (extracted.program !== null ? gmInstrumentName(extracted.program) : null),
      program: extracted.program,
      programByChannel: extracted.programByChannel,
      channels,
      isDrumTrack,
      notes,
      noteCount: notes.length,
      pitchRange: notes.length
        ? { min: Math.min(...notes.map((n) => n.pitch)), max: Math.max(...notes.map((n) => n.pitch)) }
        : null,
      events: track.events,
    });

    allNotes.push(...notes);
  }

  allNotes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const endBeats = allNotes.reduce((max, n) => Math.max(max, n.end), 0);

  return {
    format: midi.format,
    ticksPerBeat: midi.ticksPerBeat,
    division: midi.division,
    timing,
    tempo: timing.initialTempo,
    tempoEvents: timing.tempoEvents,
    timeSignature: timing.initialTimeSignature,
    timeSignatures: timing.timeSignatures,
    keySignatures: timing.keySignatures,
    tracks,
    notes: allNotes,
    durationBeats: endBeats,
    durationSeconds: timing.beatsToSeconds(endBeats),
    source: midi,
  };
}

export const PITCH_CLASS_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PITCH_CLASS_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function pitchToName(pitch, { flats = false } = {}) {
  const names = flats ? PITCH_CLASS_NAMES_FLAT : PITCH_CLASS_NAMES_SHARP;
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export function noteNameToPitch(name) {
  const match = /^([A-Ga-g])([#b]{0,2})(-?\d+)$/.exec(name.trim());
  if (!match) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1].toLowerCase()];
  let accidental = 0;
  for (const ch of match[2]) accidental += ch === '#' ? 1 : -1;
  return base + accidental + (parseInt(match[3], 10) + 1) * 12;
}
