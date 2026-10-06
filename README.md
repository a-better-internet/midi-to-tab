# MIDI Keyboard → Guitar Tab

A browser app that reads a `.mid` / `.midi` keyboard or piano performance and
generates a playable guitar transcription.

It does not convert notes to frets. It works out what the keyboard part is
*doing* musically — chords, bass notes, inversions, arpeggios, melody, passing
tones — and then realizes that on a fretboard, preserving harmonic identity,
rhythm, approximate voicing, voice leading and playability.

No build step, no dependencies, no uploads. Everything runs in the browser.

```sh
npm run serve        # then open http://localhost:8080
npm test             # 148 tests, Node's built-in runner, no dependencies
npm run audio-check  # renders the audio in a real browser and measures it
```

(Browsers refuse to load ES modules over `file://`, so the page has to be
served. Any static server will do; `tools/serve.js` is there so you don't need
one installed.)

There are four generated sample files in `samples/` — a human-timed ballad with
rolled chords, a multi-track arrangement, an arpeggio study, and a set of jazz
voicings. `node tools/makeSamples.js` rebuilds them.

## What it actually does

The central idea is that **notes occurring together are not the same thing as a
chord**. A pianist's C major arrives as four separate onsets spread over 60 ms;
an arpeggio also arrives as four separate onsets. Timestamp equality cannot tell
those apart, so the pipeline runs:

```
MIDI file
   ↓  parse, no quantization — the raw timing is the evidence
Normalized note events
   ↓  track analysis: which track is the keyboard part?
   ↓  temporal clustering: five weighted signals, not timestamp equality
Simultaneity groups
   ↓  template-based chord recognition (partial matches, separate bass/root)
   ↓  key detection, then a Viterbi progression model for context
   ↓  arpeggio detection and musical role classification
   ↓  …then the harmony is re-read with decoration discounted
Chord events with per-note roles
   ↓  voicing generation derived from the actual pitches
   ↓  fingering feasibility
   ↓  sequence optimization for voice leading and position
Tab + chord chart + playback
```

A few decisions are worth calling out, because they are where the interesting
behaviour comes from.

**Clustering is scored, not thresholded.** Each pair of notes gets a grouping
score from temporal proximity (exponential, so 5 ms vs 15 ms matters while
200 ms reads as unrelated), duration overlap, velocity similarity, harmonic
compatibility and onset-pattern similarity. The weights are configurable. The
window itself adapts: the app measures whether the performance is quantized or
human-played and sizes the window accordingly, which you can see reported in the
Analysis panel.

**Chord recognition tests every root.** It never assumes the lowest note is the
root, allows missing and duplicated tones, and treats bass separately from root —
which is what makes `E2 G3 C4 E4` come out as `C/E` rather than some contortion
starting on E.

**Harmony is read twice.** There is a genuine chicken-and-egg problem here:
classifying a note as decoration needs to know the harmony, but naming the
harmony correctly needs to know which notes are decoration. So the first pass
produces a provisional reading, roles are classified against it, and the second
pass re-reads the harmony with melody and passing tones down-weighted. That is
what stops a sustained melodic E over F-A-C from being renamed `Fmaj7` — while a
genuinely voiced close-position `Fmaj7` still reads as `Fmaj7`.

**Voicings are derived, not looked up.** For each hand position the generator
enumerates the frets on each string whose pitch class the harmony wants, and
walks them depth-first. No chord dictionary is involved, so the alternatives it
offers are real alternatives rather than table entries.

**Voicings are chosen as a sequence.** Picking the best C, the best F and the
best G independently produces a part that leaps around the neck. The optimizer
is a Viterbi decode whose transitions cost voice-leading distance and positional
movement, so it picks the best *sequence*. On the bundled ballad that is the
difference between 105 frets of hand movement and 34.

**Rhythm is never regenerated.** The MIDI's timing stays the source of truth all
the way through. Note values shown in the tab are *descriptions* of the real
durations, which are kept alongside them — nothing is snapped to a grid.

**Technique comes from the performance.** Hammer-ons, pull-offs and slides are
inferred from how closely successive notes on one string join up; bends are read
directly from the file's pitch-bend data, with vibrato-sized wobble ignored.

**The synthesis is deliberately plain.** Each guitar note is one band-limited
oscillator shaped by a plucked envelope and a lowpass that sweeps downward, so
the upper partials die first. Karplus-Strong would sound better, but in Web
Audio it fails twice over: the biquad used for string damping has passband gain
above 1, so feedback near unity makes the loop *grow* rather than decay, and a
DelayNode inside a feedback cycle is clamped to 128 samples, which puts every
note above about 344 Hz at the wrong pitch. Doing it properly needs an
AudioWorklet. Pitch accuracy matters more here than timbre.

## Using it

Drop a file in. The app picks what looks like the keyboard part and transcribes
it; you can switch tracks, or analyze all harmonic tracks at once when the
keyboard part is split across several.

The piano roll shows the source MIDI with notes coloured by the role the engine
assigned them and detected chord regions banded behind them, so you can see what
it decided and where. Clicking a chord in the tab (or a note in the roll) opens
it in the right-hand panel: the notes it saw, the reading it chose, how confident
it was, what it nearly chose instead, and the fretboard shape.

Both of those are editable. Picking a different interpretation regenerates the
voicing and re-classifies the notes underneath it; picking a different shape
leaves the harmony alone. Neither re-reads the MIDI — the analysis stays live, so
nothing is lost by experimenting.

### Playing along

The transport plays the original MIDI, the generated guitar part, or both
together, which is the only real test of whether a theoretically correct
transcription actually sounds right.

For learning a part rather than just auditioning it:

- **Click any chord to hear it.** Clicking a column in the tab, a note in the
  piano roll, or an alternative shape in the fretboard panel plays it straight
  away, lightly strummed. That is the quickest way to connect a shape on the
  page with a sound.
- **The tab follows the music.** The sounding column is highlighted and scrolled
  into view, but only while playback is running — scrolling the tab out from
  under you while you are reading it would be worse than not following at all.
- **Speed** plays at 50–125% without changing pitch, for working a passage up
  to tempo.
- **Count-in** gives you a bar or two of clicks before the music starts, so you
  can come in with it.

### Controls

| Control | What it changes |
| --- | --- |
| Transcription mode | Literal voices every pitch; Balanced keeps harmony and melody; Playable favours comfortable shapes |
| Chord complexity | Triads only / sevenths and ninths / the full vocabulary |
| Include extensions | Which degrees may appear in the guitar voicing |
| Preserve piano voicing | Weights the result toward the original register and spacing |
| Neck position | Open, low, mid, high, or automatic |
| Maximum fret span | Rejects shapes wider than your hand |
| Tuning / capo / frets | 6-, 7- and 8-string guitar, bass, ukulele, banjo, mandolin, custom |
| Chord grouping window | Overrides the automatic simultaneity window |
| Harmonic context weight | How much the progression model may override local evidence |
| Speed / count-in | Practice tempo and a click-track lead-in, for playing along |

## Layout

```
src/
  midi/         parser.js  normalizer.js  timing.js
  analysis/     trackAnalyzer.js  noteClusterer.js  chordRecognizer.js
                keyDetector.js  harmonicContext.js  noteRoleClassifier.js
  guitar/       tuning.js  fretboard.js  voicingGenerator.js
                voicingScorer.js  positionOptimizer.js  fingering.js
  transcription/ eventBuilder.js  tabGenerator.js  rhythmMapper.js  pipeline.js
  audio/        midiPlayer.js  guitarSynth.js
  ui/           pianoRoll.js  fretboard.js  tabRenderer.js  chordEditor.js  controls.js
  app.js        the only file that knows about both the engine and the DOM
```

Nothing under `analysis/`, `guitar/` or `transcription/` touches the DOM, and
nothing under `ui/` makes a musical decision. That separation is why the engine
runs under `node --test` at all, and why retargeting to bass or ukulele is a
tuning change rather than a port.

The audio layer is tested two ways, because neither alone is enough. The unit
tests drive it against a stubbed Web Audio API (`test/fixtures/fakeAudio.js`),
which catches scheduling and lifecycle bugs exactly but cannot tell you whether
anything is audible. `npm run audio-check` renders the real graph in a real
browser and measures the samples, which catches a voice that has gone silent or
diverged. An early version of the guitar voice passed every other check while
producing a signal of around 1e28 that silenced the whole app.

## Limitations

Worth being straight about these:

- **Fingering is heuristic.** It models four fingers, barres, stretch and the
  fact that frets narrow up the neck. It is not a fingering AI, and it will
  occasionally pick something a guitarist would voice differently.
- **Key detection is only as good as the material.** Eight bars of `Em Dm C G`
  genuinely is ambiguous between C and G major; the app says 47% rather than
  pretending otherwise. Low confidence is reported, not hidden.
- **Wide chords lose something.** A piano chord spanning three octaves cannot be
  stated in full on six strings. The engine drops by priority — bass and chord
  quality first, duplicated tones last — and reports how many events were
  voiced incompletely.
- **A high melody can force a high position.** Chord-melody playing works this
  way too, but the result sometimes sits further up the neck than you'd like.
  The Neck position control overrides it, and the app flags events it had to
  move out of the requested region.
- **No notation output yet.** Tab, chord chart and fretboard diagrams, but not
  engraved standard notation. The rhythm model carries everything needed for it.
