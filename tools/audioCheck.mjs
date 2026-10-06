#!/usr/bin/env node
/**
 * Verifies that the app actually makes a sound.
 *
 * The unit tests cover the scheduling arithmetic against a stubbed Web Audio
 * API, which is where the clock bugs live, but a stub cannot tell you whether
 * anything is audible. This renders the real audio graph in a real browser and
 * measures the samples.
 *
 * It exists because an earlier version of the guitar voice used a feedback
 * loop whose gain exceeded 1: it diverged to ~1e28, swamped the shared output
 * and made the whole app silent, while every other check still passed.
 *
 *   npm run serve                  # in one terminal
 *   node tools/audioCheck.mjs      # in another
 *
 * Needs Playwright and a Chromium build; it is a development aid, not a
 * dependency of the app.
 */

const URL_BASE = process.env.APP_URL ?? 'http://localhost:8080';
const SAMPLE = process.env.SAMPLE ?? '/samples/ballad-human-timing.mid';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  process.stderr.write(
    'This check needs Playwright:\n  npm install --no-save playwright\n',
  );
  process.exit(2);
}

const launchOptions = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

try {
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
} catch {
  process.stderr.write(`Could not reach ${URL_BASE}. Is "npm run serve" running?\n`);
  await browser.close();
  process.exit(2);
}

const results = await page.evaluate(async (sample) => {
  const { GuitarSynth } = await import('/src/audio/guitarSynth.js');
  const { Player, guitarNotesFromTab } = await import('/src/audio/midiPlayer.js');
  const { parseMidi } = await import('/src/midi/parser.js');
  const { normalizeMidi } = await import('/src/midi/normalizer.js');
  const { transcribe } = await import('/src/transcription/pipeline.js');

  const measure = (buffer) => {
    let peak = 0;
    let sum = 0;
    let count = 0;
    let nan = 0;
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) {
        const v = data[i];
        if (Number.isNaN(v)) { nan += 1; continue; }
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
        count += 1;
      }
    }
    return { peak, rms: Math.sqrt(sum / Math.max(1, count)), nan };
  };

  const out = {};

  // The whole range of the instrument, plucked in turn.
  const ctx = new OfflineAudioContext(2, 44100 * 6, 44100);
  const synth = new GuitarSynth(ctx, ctx.destination);
  [40, 45, 50, 55, 59, 64, 69, 76, 83, 88].forEach((pitch, i) => {
    synth.pluck({ pitch, when: 0.1 + i * 0.4, duration: 0.8, velocity: 100, string: i % 6 });
  });
  out.guitarRange = measure(await ctx.startRendering());

  // Each playback mode, rendered through the real Player.
  const response = await fetch(sample);
  const score = normalizeMidi(parseMidi(new Uint8Array(await response.arrayBuffer())));
  const result = transcribe(score);

  for (const mode of ['midi', 'guitar', 'both']) {
    const offline = new OfflineAudioContext(2, 44100 * 8, 44100);
    const player = new Player({ createContext: () => offline });
    await player.ensureContext();
    player.setSources({
      timing: score.timing,
      midiNotes: result.sourceNotes,
      guitarNotes: guitarNotesFromTab(result.tab),
      endBeat: result.tab.totalBeats,
    });
    player.setMode(mode);
    player.scheduleAll({ fromBeat: 0, anchorTime: 0.05 });
    out[mode] = measure(await offline.startRendering());
  }

  return out;
}, SAMPLE);

const FLOOR = 0.004; // below this nobody would hear it
const CEILING = 1.5; // above this it is clipping, or diverging

let failed = false;
for (const [name, m] of Object.entries(results)) {
  const issues = [];
  if (m.nan > 0) issues.push(`${m.nan} NaN samples`);
  if (m.rms < FLOOR) issues.push('silent');
  if (m.peak > CEILING) issues.push('diverging or clipping');
  const status = issues.length ? `FAIL (${issues.join(', ')})` : 'ok';
  if (issues.length) failed = true;
  process.stdout.write(
    `${name.padEnd(14)} rms ${m.rms.toFixed(5).padEnd(9)} peak ${m.peak.toFixed(4).padEnd(9)} ${status}\n`,
  );
}

for (const problem of problems) {
  failed = true;
  process.stdout.write(`${problem}\n`);
}

await browser.close();
process.stdout.write(failed ? '\naudio check FAILED\n' : '\naudio check passed\n');
process.exit(failed ? 1 : 0);
