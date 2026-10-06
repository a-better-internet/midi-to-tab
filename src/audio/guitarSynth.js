/**
 * Guitar voice (brief section 35).
 *
 * The audition exists so the user can tell whether a theoretically correct
 * voicing actually sounds right, which means two things matter above all:
 * every note must sound, and every note must be at the right pitch.
 *
 * This is a single band-limited oscillator per note, shaped by a plucked
 * envelope and a lowpass that sweeps downward so the upper partials die away
 * first -- which is most of what makes a plucked string sound plucked.
 *
 * An earlier version used Karplus-Strong (a noise burst through a delay line
 * fed back on itself). It is the better-sounding technique in principle, but
 * in Web Audio it fails twice over: the biquad used for string damping has
 * passband gain above 1, so any feedback near unity makes the loop *grow*
 * instead of decay, and a DelayNode inside a feedback cycle is clamped to one
 * render quantum (128 samples), which puts every note above roughly 344 Hz at
 * the wrong pitch. Doing it properly needs an AudioWorklet. This approach is
 * unconditionally stable and exact across the whole range, which is what the
 * feature is for.
 */

const A4 = 440;

export function midiToFrequency(pitch) {
  return A4 * 2 ** ((pitch - 69) / 12);
}

/**
 * Harmonic spectrum of a plucked steel string, as a Fourier series.
 *
 * Amplitudes fall off roughly as 1/n, with the even harmonics slightly
 * recessed, which is the characteristic of a string plucked away from its
 * midpoint. Index 0 is the DC term and must stay zero.
 */
function buildPluckWave(context, cache) {
  if (cache.wave) return cache.wave;
  const harmonics = 16;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n += 1) {
    const even = n % 2 === 0;
    imag[n] = (1 / n ** 1.1) * (even ? 0.6 : 1) * Math.sin((n * Math.PI) / 5);
  }
  cache.wave = context.createPeriodicWave(real, imag, { disableNormalization: false });
  return cache.wave;
}

/** A short noise burst for the pick attack, shared by every note. */
function buildPickNoise(context, cache) {
  if (cache.noise) return cache.noise;
  const length = Math.floor(context.sampleRate * 0.03);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  cache.noise = buffer;
  return cache.noise;
}

/**
 * How long a string rings, in seconds, before the note is released.
 * Low strings sustain considerably longer than high ones.
 */
export function ringTime(pitch, duration) {
  const registerFactor = Math.max(0, Math.min(1, (84 - pitch) / 44));
  return Math.max(0.4, Math.min(4.5, duration + 0.6 + 2.2 * registerFactor));
}

export class GuitarSynth {
  /**
   * @param {BaseAudioContext} context
   * @param {AudioNode} destination
   */
  constructor(context, destination) {
    this.context = context;
    this.cache = {};
    this.voices = new Set();

    this.output = context.createGain();
    this.output.gain.value = 0.5;

    // A gentle body resonance, well below unity so it cannot add energy.
    this.body = context.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 200;
    this.body.Q.value = 1.2;
    this.body.gain.value = 2.5;

    this.output.connect(this.body);
    this.body.connect(destination);
  }

  set gain(value) {
    this.output.gain.value = value;
  }

  /** Release every sounding voice and free its nodes. */
  allNotesOff() {
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
  }

  /**
   * Pluck one note.
   *
   * @param {object} note
   * @param {number} note.pitch MIDI pitch
   * @param {number} note.when AudioContext time to start
   * @param {number} note.duration seconds the note is held
   * @param {number} [note.velocity=90]
   * @param {number} [note.string] string index, used for stereo placement
   * @param {number} [note.stringCount=6]
   */
  pluck({ pitch, when, duration, velocity = 90, string = null, stringCount = 6 }) {
    const ctx = this.context;
    const frequency = midiToFrequency(pitch);
    if (!Number.isFinite(frequency) || frequency <= 0) return null;

    const level = Math.max(0.0005, ((velocity / 127) ** 1.4) * 0.5);
    const ring = ringTime(pitch, duration);
    const nodes = [];

    // --- the string itself -------------------------------------------------
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(buildPluckWave(ctx, this.cache));
    osc.frequency.value = frequency;

    // The brightness sweep: open at the pluck, closing as the note decays.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.6;
    const openHz = Math.min(ctx.sampleRate / 2.2, frequency * 12 + 1200);
    const closedHz = Math.min(openHz, Math.max(frequency * 2.2, 320));
    tone.frequency.setValueAtTime(openHz, when);
    tone.frequency.exponentialRampToValueAtTime(closedHz, when + ring * 0.85);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(level, when + 0.004);
    // The body of the decay, then a faster release once the note is over.
    envelope.gain.exponentialRampToValueAtTime(level * 0.28, when + Math.min(ring, 0.35));
    const releaseAt = when + Math.max(0.06, duration * 0.92);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + ring);

    osc.connect(tone);
    tone.connect(envelope);
    nodes.push(osc, tone, envelope);

    // --- the pick attack ---------------------------------------------------
    const pick = ctx.createBufferSource();
    pick.buffer = buildPickNoise(ctx, this.cache);
    const pickFilter = ctx.createBiquadFilter();
    pickFilter.type = 'bandpass';
    pickFilter.frequency.value = Math.min(ctx.sampleRate / 2.2, frequency * 6 + 900);
    pickFilter.Q.value = 0.8;
    const pickGain = ctx.createGain();
    pickGain.gain.setValueAtTime(level * 0.35, when);
    pickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    pick.connect(pickFilter);
    pickFilter.connect(pickGain);
    nodes.push(pick, pickFilter, pickGain);

    // --- stereo placement by string ----------------------------------------
    let sink = this.output;
    if (string !== null && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = ((string / Math.max(1, stringCount - 1)) - 0.5) * 0.4;
      panner.connect(this.output);
      nodes.push(panner);
      sink = panner;
    }
    envelope.connect(sink);
    pickGain.connect(sink);

    const stopAt = when + ring + 0.05;
    osc.start(when);
    osc.stop(stopAt);
    pick.start(when);
    pick.stop(when + pick.buffer.duration);

    // Nodes are explicitly torn down once the note has finished, rather than
    // being left for the garbage collector to find.
    const voice = {
      stopAt,
      stop: () => {
        try { osc.stop(); } catch { /* already stopped */ }
        for (const node of nodes) {
          try { node.disconnect(); } catch { /* already disconnected */ }
        }
      },
    };
    this.voices.add(voice);
    osc.onended = () => {
      voice.stop();
      this.voices.delete(voice);
    };

    return { stopAt, nodes, releaseAt };
  }
}
