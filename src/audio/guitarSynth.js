/**
 * Guitar voice (brief section 35).
 *
 * A plucked-string tone built from a noise burst through a tuned comb filter --
 * Karplus-Strong, essentially -- which gives a far more convincing pluck than
 * stacked oscillators and costs almost nothing. Each string gets its own
 * feedback delay line, so the brightness and decay vary with register the way a
 * real guitar's do.
 *
 * The point of the audition is to tell the user whether a theoretically correct
 * voicing actually sounds right, so the tone has to be good enough to judge.
 */

const A4 = 440;

export function midiToFrequency(pitch) {
  return A4 * 2 ** ((pitch - 69) / 12);
}

/** One-shot noise buffer, reused by every pluck. */
function getNoiseBuffer(ctx, cache) {
  if (cache.noise) return cache.noise;
  const length = Math.floor(ctx.sampleRate * 0.12);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    // Decaying noise: a sharp pick attack rather than a wash.
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  }
  cache.noise = buffer;
  return buffer;
}

export class GuitarSynth {
  /**
   * @param {AudioContext} context
   * @param {AudioNode} destination
   */
  constructor(context, destination) {
    this.context = context;
    this.cache = {};

    this.output = context.createGain();
    this.output.gain.value = 0.9;

    // A gentle body resonance keeps it from sounding like a sine wave.
    this.body = context.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 220;
    this.body.Q.value = 1.1;
    this.body.gain.value = 3;

    this.tone = context.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4200;
    this.tone.Q.value = 0.4;

    this.output.connect(this.body);
    this.body.connect(this.tone);
    this.tone.connect(destination);
  }

  set gain(value) {
    this.output.gain.value = value;
  }

  /**
   * Pluck one note.
   *
   * @param {object} note
   * @param {number} note.pitch MIDI pitch
   * @param {number} note.when AudioContext time to start
   * @param {number} note.duration seconds
   * @param {number} [note.velocity=90]
   * @param {number} [note.string] string index, used to colour the tone
   */
  pluck({ pitch, when, duration, velocity = 90, string = null, stringCount = 6 }) {
    const ctx = this.context;
    const frequency = midiToFrequency(pitch);
    const level = (velocity / 127) ** 1.4;

    // Lower strings ring longer and darker.
    const registerFactor = Math.max(0.25, Math.min(1, (84 - pitch) / 40));
    const ring = Math.max(0.35, Math.min(3.4, duration + 0.9 * registerFactor));

    const source = ctx.createBufferSource();
    source.buffer = getNoiseBuffer(ctx, this.cache);

    const exciter = ctx.createBiquadFilter();
    exciter.type = 'lowpass';
    exciter.frequency.value = Math.min(ctx.sampleRate / 2.2, frequency * 14 + 900);

    // The comb filter: a delay of one period, fed back on itself.
    const period = 1 / frequency;
    const delay = ctx.createDelay(Math.max(0.02, period * 2));
    delay.delayTime.value = period;

    const feedback = ctx.createGain();
    // Longer feedback for low notes, which sustain more.
    feedback.gain.value = Math.min(0.995, 0.978 + registerFactor * 0.016);

    // Losses in the string: each pass through loses high frequencies.
    const damper = ctx.createBiquadFilter();
    damper.type = 'lowpass';
    damper.frequency.value = Math.max(900, 2600 + frequency * 3.2);
    damper.Q.value = 0.0001;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(level * 0.55, when + 0.004);
    // Release once the note is over, but let it ring a little past its duration
    // the way an unmuted string does.
    const releaseStart = when + Math.max(0.05, duration * 0.95);
    envelope.gain.setValueAtTime(level * 0.55, releaseStart);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + ring);

    source.connect(exciter);
    exciter.connect(delay);
    delay.connect(damper);
    damper.connect(feedback);
    feedback.connect(delay);
    delay.connect(envelope);
    envelope.connect(this.output);

    // A touch of stereo spread by string, so chords do not collapse to a point.
    if (string !== null && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = ((string / Math.max(1, stringCount - 1)) - 0.5) * 0.45;
      envelope.disconnect();
      envelope.connect(panner);
      panner.connect(this.output);
    }

    source.start(when);
    source.stop(when + Math.min(0.12, source.buffer.duration));

    const stopAt = when + ring + 0.05;
    return { stopAt, nodes: [source, delay, feedback, envelope] };
  }
}
