/**
 * A minimal stand-in for the Web Audio API.
 *
 * Node has no AudioContext, which left the playback layer untested and let a
 * clock-conversion bug ship. This records what the synths ask for -- which
 * voice, at which AudioContext time, at which pitch -- so the scheduler's
 * arithmetic can be checked exactly, without rendering a single sample.
 *
 * It deliberately does not model sound. Audible output is verified separately
 * in a real browser by tools/audioCheck.mjs.
 */

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }

  setValueAtTime(value, time) { this.events.push({ type: 'set', value, time }); this.value = value; return this; }
  linearRampToValueAtTime(value, time) { this.events.push({ type: 'linear', value, time }); return this; }
  exponentialRampToValueAtTime(value, time) {
    if (value === 0) throw new RangeError('exponentialRampToValueAtTime cannot target zero');
    this.events.push({ type: 'exp', value, time });
    return this;
  }
  setTargetAtTime(value, time, constant) { this.events.push({ type: 'target', value, time, constant }); return this; }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); return this; }
}

class FakeNode {
  constructor(context, type) {
    this.context = context;
    this.type = type;
    this.outputs = [];
    this.connected = 0;
    this.disconnected = 0;
  }

  connect(target) { this.outputs.push(target); this.connected += 1; return target; }
  disconnect() { this.disconnected += 1; this.outputs = []; }
}

class FakeGain extends FakeNode {
  constructor(context) { super(context, 'gain'); this.gain = new FakeParam(1); }
}

class FakeBiquad extends FakeNode {
  constructor(context) {
    super(context, 'biquad');
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
    this.gain = new FakeParam(0);
  }
}

class FakeOscillator extends FakeNode {
  constructor(context) {
    super(context, 'oscillator');
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.onended = null;
    this.startedAt = null;
    this.stoppedAt = null;
  }

  setPeriodicWave(wave) { this.wave = wave; }
  start(when) { this.startedAt = when; this.context._started.push(this); }
  stop(when) { if (this.stoppedAt === null) this.stoppedAt = when; }
}

class FakeBufferSource extends FakeNode {
  constructor(context) {
    super(context, 'bufferSource');
    this.buffer = null;
    this.startedAt = null;
    this.stoppedAt = null;
  }

  start(when) { this.startedAt = when; }
  stop(when) { if (this.stoppedAt === null) this.stoppedAt = when; }
}

class FakePanner extends FakeNode {
  constructor(context) { super(context, 'panner'); this.pan = new FakeParam(0); }
}

export class FakeAudioContext {
  constructor({ sampleRate = 44100, currentTime = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = currentTime;
    this.state = 'running';
    this.destination = new FakeNode(this, 'destination');
    this._started = [];
    this.resumed = 0;
  }

  async resume() { this.resumed += 1; this.state = 'running'; }

  createGain() { return new FakeGain(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createStereoPanner() { return new FakePanner(this); }
  createDelay() { const n = new FakeNode(this, 'delay'); n.delayTime = new FakeParam(0); return n; }
  createPeriodicWave() { return { periodicWave: true }; }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }

  /** Advance the clock, as the browser's audio thread would. */
  advance(seconds) { this.currentTime += seconds; return this; }
}

/**
 * Wrap a Player's synths so every note they are asked to play is recorded.
 * @returns {{guitar:Array, piano:Array, clicks:Array}}
 */
export function recordVoices(player) {
  const log = { guitar: [], piano: [], clicks: [] };

  const realPluck = player.guitar.pluck.bind(player.guitar);
  player.guitar.pluck = (note) => { log.guitar.push({ ...note }); return realPluck(note); };

  const realStrike = player.piano.strike.bind(player.piano);
  player.piano.strike = (note) => { log.piano.push({ ...note }); return realStrike(note); };

  const realClick = player.click.bind(player);
  player.click = (when, accent) => { log.clicks.push({ when, accent }); return realClick(when, accent); };

  return log;
}
