/**
 * Standard MIDI File (SMF) parser.
 *
 * Produces a raw, loss-free representation of the file: every track, every
 * event, in ticks. No musical interpretation happens here -- that is the job of
 * `normalizer.js` and the analysis layer. Keeping this stage dumb is what makes
 * the pipeline reversible (section 2 of the brief): the parse result is kept
 * alive for the whole session so interpretations can be recomputed without
 * re-importing the file.
 *
 * Supports format 0, 1 and 2 files. Running status, SysEx, meta events and
 * unknown chunk types are all handled.
 */

const HEADER_CHUNK = 0x4d546864; // 'MThd'
const TRACK_CHUNK = 0x4d54726b; // 'MTrk'

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  get remaining() {
    return this.bytes.length - this.pos;
  }

  uint8() {
    if (this.pos >= this.bytes.length) throw new RangeError('MIDI: unexpected end of file');
    return this.bytes[this.pos++];
  }

  uint16() {
    return (this.uint8() << 8) | this.uint8();
  }

  uint32() {
    return ((this.uint8() << 24) | (this.uint8() << 16) | (this.uint8() << 8) | this.uint8()) >>> 0;
  }

  int16() {
    const v = this.uint16();
    return v & 0x8000 ? v - 0x10000 : v;
  }

  /** Variable-length quantity, as used for delta times and meta lengths. */
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.uint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new RangeError('MIDI: variable-length quantity longer than 4 bytes');
  }

  slice(length) {
    if (length < 0 || this.pos + length > this.bytes.length) {
      throw new RangeError('MIDI: slice beyond end of file');
    }
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  peek() {
    return this.bytes[this.pos];
  }
}

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

function decodeText(bytes) {
  if (textDecoder) return textDecoder.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

const KEY_SIGNATURE_NAMES = {
  '-7': ['Cb major', 'Ab minor'],
  '-6': ['Gb major', 'Eb minor'],
  '-5': ['Db major', 'Bb minor'],
  '-4': ['Ab major', 'F minor'],
  '-3': ['Eb major', 'C minor'],
  '-2': ['Bb major', 'G minor'],
  '-1': ['F major', 'D minor'],
  0: ['C major', 'A minor'],
  1: ['G major', 'E minor'],
  2: ['D major', 'B minor'],
  3: ['A major', 'F# minor'],
  4: ['E major', 'C# minor'],
  5: ['B major', 'G# minor'],
  6: ['F# major', 'D# minor'],
  7: ['C# major', 'A# minor'],
};

function parseMetaEvent(reader, tick, type) {
  const length = reader.varint();
  const data = reader.slice(length);
  const event = { kind: 'meta', tick, metaType: type, data };

  switch (type) {
    case 0x00:
      event.subtype = 'sequenceNumber';
      event.number = length >= 2 ? (data[0] << 8) | data[1] : 0;
      break;
    case 0x01:
      event.subtype = 'text';
      event.text = decodeText(data);
      break;
    case 0x02:
      event.subtype = 'copyright';
      event.text = decodeText(data);
      break;
    case 0x03:
      event.subtype = 'trackName';
      event.text = decodeText(data);
      break;
    case 0x04:
      event.subtype = 'instrumentName';
      event.text = decodeText(data);
      break;
    case 0x05:
      event.subtype = 'lyric';
      event.text = decodeText(data);
      break;
    case 0x06:
      event.subtype = 'marker';
      event.text = decodeText(data);
      break;
    case 0x07:
      event.subtype = 'cuePoint';
      event.text = decodeText(data);
      break;
    case 0x20:
      event.subtype = 'channelPrefix';
      event.channel = data[0];
      break;
    case 0x2f:
      event.subtype = 'endOfTrack';
      break;
    case 0x51: {
      event.subtype = 'setTempo';
      // Microseconds per quarter note.
      event.microsecondsPerBeat = (data[0] << 16) | (data[1] << 8) | data[2];
      event.bpm = event.microsecondsPerBeat > 0 ? 60000000 / event.microsecondsPerBeat : 120;
      break;
    }
    case 0x54:
      event.subtype = 'smpteOffset';
      event.hour = data[0];
      event.minute = data[1];
      event.second = data[2];
      event.frame = data[3];
      event.subFrame = data[4];
      break;
    case 0x58: {
      event.subtype = 'timeSignature';
      event.numerator = data[0];
      event.denominator = 2 ** data[1];
      event.metronome = data[2];
      event.thirtyseconds = data[3];
      break;
    }
    case 0x59: {
      event.subtype = 'keySignature';
      const sf = data[0] & 0x80 ? data[0] - 0x100 : data[0];
      event.sharpsFlats = sf;
      event.scale = data[1] === 1 ? 'minor' : 'major';
      const names = KEY_SIGNATURE_NAMES[String(sf)];
      event.name = names ? names[data[1] === 1 ? 1 : 0] : null;
      break;
    }
    case 0x7f:
      event.subtype = 'sequencerSpecific';
      break;
    default:
      event.subtype = 'unknownMeta';
      break;
  }
  return event;
}

function parseTrackEvents(reader, endPos) {
  const events = [];
  let tick = 0;
  let runningStatus = null;

  while (reader.pos < endPos) {
    tick += reader.varint();

    let status = reader.peek();
    if (status === undefined) break;

    if (status & 0x80) {
      reader.uint8();
      if (status < 0xf0) runningStatus = status;
      else if (status !== 0xf7 && status !== 0xf0) runningStatus = null;
    } else {
      // Running status: reuse the previous channel status byte.
      if (runningStatus === null) throw new Error('MIDI: running status used before any status byte');
      status = runningStatus;
    }

    if (status === 0xff) {
      events.push(parseMetaEvent(reader, tick, reader.uint8()));
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = reader.varint();
      events.push({ kind: 'sysex', tick, data: reader.slice(length) });
      continue;
    }

    const type = status & 0xf0;
    const channel = status & 0x0f;

    switch (type) {
      case 0x80: {
        const note = reader.uint8();
        const velocity = reader.uint8();
        events.push({ kind: 'noteOff', tick, channel, note, velocity });
        break;
      }
      case 0x90: {
        const note = reader.uint8();
        const velocity = reader.uint8();
        // A note-on with zero velocity is a note-off. This is extremely common.
        events.push({ kind: velocity === 0 ? 'noteOff' : 'noteOn', tick, channel, note, velocity });
        break;
      }
      case 0xa0: {
        const note = reader.uint8();
        const amount = reader.uint8();
        events.push({ kind: 'noteAftertouch', tick, channel, note, amount });
        break;
      }
      case 0xb0: {
        const controller = reader.uint8();
        const value = reader.uint8();
        events.push({ kind: 'controller', tick, channel, controller, value });
        break;
      }
      case 0xc0: {
        const program = reader.uint8();
        events.push({ kind: 'programChange', tick, channel, program });
        break;
      }
      case 0xd0: {
        const amount = reader.uint8();
        events.push({ kind: 'channelAftertouch', tick, channel, amount });
        break;
      }
      case 0xe0: {
        const lsb = reader.uint8();
        const msb = reader.uint8();
        events.push({ kind: 'pitchBend', tick, channel, value: ((msb << 7) | lsb) - 8192 });
        break;
      }
      default:
        throw new Error(`MIDI: unhandled status byte 0x${status.toString(16)}`);
    }
  }

  return events;
}

/**
 * Parse an SMF byte buffer.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{format:number, ticksPerBeat:number, division:object, tracks:Array}}
 */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 14) throw new Error('MIDI: file is too short to be a Standard MIDI File');

  const reader = new ByteReader(bytes);
  if (reader.uint32() !== HEADER_CHUNK) {
    throw new Error('MIDI: missing MThd header -- this does not look like a .mid file');
  }

  const headerLength = reader.uint32();
  const headerEnd = reader.pos + headerLength;
  const format = reader.uint16();
  const declaredTrackCount = reader.uint16();
  const rawDivision = reader.int16();
  reader.pos = headerEnd; // Skip any header bytes we do not understand.

  let division;
  let ticksPerBeat;
  if (rawDivision > 0) {
    division = { type: 'ticksPerBeat', ticksPerBeat: rawDivision };
    ticksPerBeat = rawDivision;
  } else {
    // SMPTE time division: negative frames-per-second in the high byte.
    const framesPerSecond = -(rawDivision >> 8);
    const ticksPerFrame = rawDivision & 0xff;
    division = { type: 'smpte', framesPerSecond, ticksPerFrame };
    // Treat SMPTE as a fixed tick rate; the timing layer converts via tempo 120.
    ticksPerBeat = Math.max(1, Math.round((framesPerSecond * ticksPerFrame) / 2));
  }

  const tracks = [];
  while (reader.remaining >= 8) {
    const chunkType = reader.uint32();
    const chunkLength = reader.uint32();
    if (chunkLength > reader.remaining) {
      // Truncated final chunk: salvage what is there rather than failing.
      const salvage = reader.remaining;
      if (chunkType === TRACK_CHUNK && salvage > 0) {
        tracks.push({ index: tracks.length, events: parseTrackEvents(reader, reader.pos + salvage) });
      }
      break;
    }
    const chunkEnd = reader.pos + chunkLength;
    if (chunkType === TRACK_CHUNK) {
      tracks.push({ index: tracks.length, events: parseTrackEvents(reader, chunkEnd) });
    }
    reader.pos = chunkEnd;
  }

  if (tracks.length === 0) throw new Error('MIDI: file contains no MTrk track chunks');

  return {
    format,
    declaredTrackCount,
    ticksPerBeat,
    division,
    tracks,
    byteLength: bytes.length,
  };
}

export { ByteReader, decodeText };
