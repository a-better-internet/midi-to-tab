/**
 * Minimal Standard MIDI File writer -- test fixtures only.
 * Lets the test suite build MIDI with exact, deliberately human-ish timing
 * instead of shipping binary blobs in the repo.
 */

function varint(value) {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function chunk(type, data) {
  const out = [];
  for (const ch of type) out.push(ch.charCodeAt(0));
  out.push((data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
  return out.concat(data);
}

/**
 * @param {object} spec
 * @param {number} [spec.ticksPerBeat=480]
 * @param {number} [spec.tempo=120]
 * @param {[number,number]} [spec.timeSignature=[4,4]]
 * @param {Array<{name?:string, program?:number, channel?:number, notes:Array}>} spec.tracks
 *        note: { pitch, startTicks, durationTicks, velocity? }
 */
export function writeMidi(spec) {
  const ticksPerBeat = spec.ticksPerBeat ?? 480;
  const tempo = spec.tempo ?? 120;
  const [num, den] = spec.timeSignature ?? [4, 4];
  const tracks = spec.tracks ?? [];
  const format = tracks.length > 1 ? 1 : 0;

  const header = chunk('MThd', [
    0, format,
    0, tracks.length + (format === 1 ? 1 : 0),
    (ticksPerBeat >> 8) & 0xff, ticksPerBeat & 0xff,
  ]);

  const out = [...header];

  const microsPerBeat = Math.round(60000000 / tempo);
  const conductor = [
    ...varint(0), 0xff, 0x51, 0x03,
    (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff,
    ...varint(0), 0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8,
  ];

  if (format === 1) {
    out.push(...chunk('MTrk', [...conductor, ...varint(0), 0xff, 0x2f, 0x00]));
  }

  tracks.forEach((track, trackIndex) => {
    const data = [];
    if (format === 0) data.push(...conductor);

    if (track.name) {
      const nameBytes = [...track.name].map((c) => c.charCodeAt(0) & 0x7f);
      data.push(...varint(0), 0xff, 0x03, ...varint(nameBytes.length), ...nameBytes);
    }
    const channel = track.channel ?? trackIndex % 16;
    if (track.program !== undefined) {
      data.push(...varint(0), 0xc0 | channel, track.program & 0x7f);
    }

    // Flatten to a sorted event list (note-ons and note-offs interleaved).
    const events = [];
    for (const note of track.notes) {
      events.push({ tick: note.startTicks, on: true, pitch: note.pitch, velocity: note.velocity ?? 80 });
      events.push({ tick: note.startTicks + note.durationTicks, on: false, pitch: note.pitch, velocity: 0 });
    }
    // Offs before ons at the same tick keeps repeated pitches unambiguous.
    events.sort((a, b) => a.tick - b.tick || (a.on === b.on ? a.pitch - b.pitch : a.on ? 1 : -1));

    let last = 0;
    for (const event of events) {
      data.push(...varint(event.tick - last));
      last = event.tick;
      data.push(event.on ? 0x90 | channel : 0x80 | channel, event.pitch & 0x7f, event.velocity & 0x7f);
    }
    data.push(...varint(0), 0xff, 0x2f, 0x00);
    out.push(...chunk('MTrk', data));
  });

  return new Uint8Array(out);
}

/** Convenience: build notes from beat-based specs. */
export function beatsToTicks(notes, ticksPerBeat = 480) {
  return notes.map((n) => ({
    pitch: n.pitch,
    startTicks: Math.round(n.start * ticksPerBeat),
    durationTicks: Math.max(1, Math.round(n.duration * ticksPerBeat)),
    velocity: n.velocity ?? 80,
  }));
}
