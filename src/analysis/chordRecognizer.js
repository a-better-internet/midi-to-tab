/**
 * Template-based chord recognition (brief sections 10-13).
 *
 * The analyzer never assumes the lowest note is the root and never requires a
 * chord to be complete. It compares the weighted pitch-class content of a note
 * group against every (root x template) pair and ranks the interpretations.
 *
 * Two scores drive everything:
 *
 *   coverage -- how much of the template the group actually contains, weighted
 *               by how much each degree matters (a missing third is fatal, a
 *               missing fifth is routine).
 *   explain  -- how much of the group's sounding weight the template accounts
 *               for. This is what stops "C E G A" from being read as Cmaj7/A
 *               or some other contortion that covers the notes by accident.
 *
 * Bass is handled separately from root, which is what makes inversions and
 * slash chords (C/E) fall out naturally rather than being special-cased.
 */

export const PC_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function pcName(pc, { flats = false } = {}) {
  const i = ((pc % 12) + 12) % 12;
  return (flats ? PC_FLAT : PC_SHARP)[i];
}

/**
 * Degree weights: how much a given chord degree contributes to the identity of
 * the chord. Used both for "is it present?" (coverage) and for deciding which
 * tones the guitar engine may drop (section 26).
 */
const DEGREE_WEIGHT = {
  0: 1.0, // root
  1: 0.8, // b9
  2: 0.6, // 9 / sus2
  3: 0.95, // minor third
  4: 0.95, // major third
  5: 0.65, // 11 / sus4
  6: 0.85, // b5 / #11
  7: 0.45, // fifth -- the most droppable tone on a guitar
  8: 0.8, // #5 / b13
  9: 0.6, // 6 / 13
  10: 0.78, // b7
  11: 0.78, // maj7
};

function degreeWeight(interval) {
  return DEGREE_WEIGHT[((interval % 12) + 12) % 12] ?? 0.5;
}

/**
 * The chord vocabulary required by section 10, plus the dyads/power chords that
 * real keyboard parts produce. `essential` degrees are the ones whose absence
 * disqualifies the reading. `complexity` groups templates for the
 * Basic / Extended / Exact user control (section 30).
 */
export const CHORD_TEMPLATES = [
  { id: 'maj', name: 'major', suffix: '', intervals: [0, 4, 7], essential: [0, 4], complexity: 0 },
  { id: 'min', name: 'minor', suffix: 'm', intervals: [0, 3, 7], essential: [0, 3], complexity: 0 },
  { id: 'dim', name: 'diminished', suffix: 'dim', intervals: [0, 3, 6], essential: [0, 3, 6], complexity: 1 },
  { id: 'aug', name: 'augmented', suffix: 'aug', intervals: [0, 4, 8], essential: [0, 4, 8], complexity: 1 },
  { id: '5', name: 'power chord', suffix: '5', intervals: [0, 7], essential: [0, 7], complexity: 0, dyad: true },

  { id: 'sus2', name: 'suspended 2nd', suffix: 'sus2', intervals: [0, 2, 7], essential: [0, 2], complexity: 1 },
  { id: 'sus4', name: 'suspended 4th', suffix: 'sus4', intervals: [0, 5, 7], essential: [0, 5], complexity: 1 },

  { id: '6', name: 'major 6th', suffix: '6', intervals: [0, 4, 7, 9], essential: [0, 4, 9], complexity: 1 },
  { id: 'm6', name: 'minor 6th', suffix: 'm6', intervals: [0, 3, 7, 9], essential: [0, 3, 9], complexity: 1 },
  { id: 'add9', name: 'added 9th', suffix: 'add9', intervals: [0, 4, 7, 2], essential: [0, 4, 2], complexity: 1 },
  { id: 'madd9', name: 'minor added 9th', suffix: 'm(add9)', intervals: [0, 3, 7, 2], essential: [0, 3, 2], complexity: 2 },

  { id: 'maj7', name: 'major 7th', suffix: 'maj7', intervals: [0, 4, 7, 11], essential: [0, 4, 11], complexity: 1 },
  { id: 'm7', name: 'minor 7th', suffix: 'm7', intervals: [0, 3, 7, 10], essential: [0, 3, 10], complexity: 1 },
  { id: '7', name: 'dominant 7th', suffix: '7', intervals: [0, 4, 7, 10], essential: [0, 4, 10], complexity: 1 },
  { id: 'm7b5', name: 'half-diminished', suffix: 'm7b5', intervals: [0, 3, 6, 10], essential: [0, 3, 6, 10], complexity: 2 },
  { id: 'dim7', name: 'diminished 7th', suffix: 'dim7', intervals: [0, 3, 6, 9], essential: [0, 3, 6, 9], complexity: 2 },
  { id: 'mMaj7', name: 'minor major 7th', suffix: 'm(maj7)', intervals: [0, 3, 7, 11], essential: [0, 3, 11], complexity: 3 },
  { id: '7sus4', name: 'dominant 7 sus4', suffix: '7sus4', intervals: [0, 5, 7, 10], essential: [0, 5, 10], complexity: 2 },

  { id: 'maj9', name: 'major 9th', suffix: 'maj9', intervals: [0, 4, 7, 11, 2], essential: [0, 4, 11], complexity: 2 },
  { id: 'm9', name: 'minor 9th', suffix: 'm9', intervals: [0, 3, 7, 10, 2], essential: [0, 3, 10], complexity: 2 },
  { id: '9', name: 'dominant 9th', suffix: '9', intervals: [0, 4, 7, 10, 2], essential: [0, 4, 10], complexity: 2 },
  { id: '6/9', name: 'six nine', suffix: '6/9', intervals: [0, 4, 7, 9, 2], essential: [0, 4, 9, 2], complexity: 3 },

  { id: '11', name: 'eleventh', suffix: '11', intervals: [0, 7, 10, 2, 5], essential: [0, 10, 5], complexity: 3 },
  { id: 'm11', name: 'minor 11th', suffix: 'm11', intervals: [0, 3, 7, 10, 2, 5], essential: [0, 3, 10, 5], complexity: 3 },
  { id: '13', name: 'thirteenth', suffix: '13', intervals: [0, 4, 7, 10, 2, 9], essential: [0, 4, 10, 9], complexity: 3 },
  { id: 'm13', name: 'minor 13th', suffix: 'm13', intervals: [0, 3, 7, 10, 2, 9], essential: [0, 3, 10, 9], complexity: 3 },

  { id: '7b5', name: 'dominant 7 flat 5', suffix: '7b5', intervals: [0, 4, 6, 10], essential: [0, 4, 6, 10], complexity: 3 },
  { id: '7#5', name: 'dominant 7 sharp 5', suffix: '7#5', intervals: [0, 4, 8, 10], essential: [0, 4, 8, 10], complexity: 3 },
  { id: '7b9', name: 'dominant 7 flat 9', suffix: '7b9', intervals: [0, 4, 7, 10, 1], essential: [0, 4, 10, 1], complexity: 3 },
];

export const TEMPLATES_BY_ID = new Map(CHORD_TEMPLATES.map((t) => [t.id, t]));

/**
 * How much the bass note counts toward the pitch-class profile. Low enough
 * that a sustained pedal cannot rename the harmony, high enough that a
 * root-position chord gets credit for stating its root.
 */
const BASS_PROFILE_WEIGHT = 0.45;

/** Max template complexity allowed by the user-facing Chord Complexity control. */
export const COMPLEXITY_LIMITS = { basic: 0, extended: 2, exact: 3 };

/**
 * Weighted pitch-class profile for a set of notes.
 * Longer and louder notes count for more -- a 2-beat C matters more to the
 * chord's identity than a 30 ms grace note.
 */
export function pitchClassProfile(notes, { durationWeight = 1, velocityWeight = 0.35 } = {}) {
  const profile = new Float64Array(12);
  let total = 0;
  for (const note of notes) {
    const dur = Math.max(note.duration ?? 0.25, 0.03);
    const vel = (note.velocity ?? 80) / 127;
    // `harmonicWeight` lets the caller say how much a note should count toward
    // the chord's identity. The refinement pass uses it to stop a sustained
    // melody note from renaming the harmony under it (section 16).
    const relevance = note.harmonicWeight ?? 1;
    const w = (dur ** 0.5) * durationWeight * (1 - velocityWeight + velocityWeight * vel * 1.6) * relevance;
    profile[((note.pitch % 12) + 12) % 12] += w;
    total += w;
  }
  if (total > 0) for (let i = 0; i < 12; i += 1) profile[i] /= total;
  return profile;
}

function formatSymbol(rootPc, template, bassPc, options = {}) {
  const root = pcName(rootPc, options);
  let symbol = `${root}${template.suffix}`;
  if (bassPc !== null && bassPc !== undefined && bassPc !== rootPc) {
    symbol += `/${pcName(bassPc, options)}`;
  }
  return symbol;
}

const INVERSION_NAMES = ['root position', 'first inversion', 'second inversion', 'third inversion', 'fourth inversion'];

/**
 * Score one (root, template) hypothesis against a weighted pitch-class profile.
 */
function scoreHypothesis(rootPc, template, profile, context) {
  const { bassPc, keyProfile, complexityPenalty, presentSet, extraPenaltyScale } = context;

  const templatePcs = new Set(template.intervals.map((i) => (rootPc + i) % 12));

  let coverageHave = 0;
  let coverageTotal = 0;
  const present = [];
  const missing = [];

  // A chord member carried only by a faint, down-weighted voice is only
  // partially present. Without this, one discounted melody note is enough to
  // "complete" a seventh chord that the actual harmony never states.
  const expectedShare = 1 / template.intervals.length;
  const presenceOf = (pc) => Math.min(1, profile[pc] / (expectedShare * 0.6));

  for (const interval of template.intervals) {
    const pc = (rootPc + interval) % 12;
    const w = degreeWeight(interval);
    coverageTotal += w;
    if (presentSet.has(pc)) {
      // The bass is excluded from the profile, so a pitch class that only
      // appears in the bass reads as zero mass: treat it as fully present.
      const strength = pc === bassPc ? 1 : Math.max(presenceOf(pc), 0.15);
      coverageHave += w * strength;
      present.push({ interval, pc, strength });
    } else {
      missing.push({ interval, pc });
    }
  }

  // An essential degree that is simply absent kills the hypothesis. A degree
  // present only as a faint, down-weighted voice does not count either --
  // otherwise a passing melody note can conjure a seventh chord out of a triad.
  for (const interval of template.essential) {
    const pc = (rootPc + interval) % 12;
    if (!presentSet.has(pc)) return null;
    // The bass is held out of the profile on purpose, so it legitimately has
    // zero mass there and must be exempt from the faint-voice check.
    if (pc !== bassPc && profile[pc] < 0.035 && interval !== 0) return null;
  }

  const coverage = coverageTotal > 0 ? coverageHave / coverageTotal : 0;

  // How much of what is actually sounding does this template explain?
  let explained = 0;
  let extraneous = 0;
  const extras = [];
  for (let pc = 0; pc < 12; pc += 1) {
    if (profile[pc] <= 0) continue;
    if (templatePcs.has(pc)) explained += profile[pc];
    else {
      extraneous += profile[pc];
      extras.push(pc);
    }
  }

  // Unexplained mass is punished super-linearly: one stray colour tone is
  // forgivable, two mean we have the wrong chord. The scale depends on what the
  // user asked for -- in Basic mode the extensions are *expected* to be left
  // unexplained, so they are not evidence against the triad underneath them.
  const explain = Math.max(0, explained
    - extraneous * 1.35 * extraPenaltyScale
    - extraneous ** 2 * 0.9 * extraPenaltyScale);

  let score = coverage * 0.46 + explain * 0.54;

  // Prefer the simplest template that fits (Occam). Without this, every triad
  // gets read as some 13th chord with four missing tones.
  score -= template.complexity * complexityPenalty;

  // A template with more tones than we have evidence for is suspicious.
  const unexplainedTemplateTones = missing.length;
  score -= unexplainedTemplateTones * 0.035;

  // Root in the bass is the single strongest root cue (section 12).
  if (bassPc !== null) {
    if (bassPc === rootPc) score += 0.14;
    else if (templatePcs.has(bassPc)) score += 0.012; // a real inversion, still plausible
    else score -= 0.09; // bass outside the chord: possible, but costly
  }

  // Tonal context (section 14/15): roots and chord tones that fit the key win.
  if (keyProfile) {
    let fit = 0;
    for (const { pc } of present) fit += keyProfile[pc] ?? 0;
    const avgFit = present.length ? fit / present.length : 0;
    score += (avgFit - 0.5) * 0.09;
  }

  if (template.dyad) score -= 0.04; // only pick a power chord when nothing better fits

  const bass = bassPc ?? rootPc;
  const bassInterval = ((bass - rootPc) % 12 + 12) % 12;
  const degreeOrder = [...template.intervals].sort((a, b) => a - b);
  const inversionIndex = Math.max(0, degreeOrder.indexOf(bassInterval));

  return {
    root: rootPc,
    templateId: template.id,
    quality: template.name,
    suffix: template.suffix,
    intervals: template.intervals,
    bass,
    inversion: inversionIndex,
    inversionName: INVERSION_NAMES[inversionIndex] ?? `inversion ${inversionIndex}`,
    present: present.map((p) => p.pc),
    missing: missing.map((m) => m.pc),
    extras,
    coverage,
    explain,
    score,
    complexity: template.complexity,
  };
}

/**
 * Recognize chords in a set of notes.
 *
 * @param {Array} notes normalized notes (pitch/duration/velocity)
 * @param {object} [options]
 * @param {number|null} [options.bass] explicit bass pitch; defaults to lowest note
 * @param {Float64Array|null} [options.keyProfile] per-pitch-class tonal weights
 * @param {string} [options.complexity] 'basic' | 'extended' | 'exact'
 * @param {number} [options.maxCandidates=6]
 * @param {boolean} [options.flats] spell with flats
 * @returns {{candidates:Array, best:object|null}}
 */
export function recognizeChord(notes, options = {}) {
  const {
    bass = null,
    keyProfile = null,
    complexity = 'extended',
    maxCandidates = 6,
    flats = false,
    separateBass = true,
  } = options;

  if (!notes || notes.length === 0) return { candidates: [], best: null };

  // A note explicitly weighted to zero is not part of this harmony at all.
  const relevant = notes.filter((n) => (n.harmonicWeight ?? 1) > 0);
  if (relevant.length === 0) return { candidates: [], best: null };

  const sorted = [...relevant].sort((a, b) => a.pitch - b.pitch);
  const bassPitch = bass ?? sorted[0].pitch;
  const bassPc = ((bassPitch % 12) + 12) % 12;

  // The bass is down-weighted rather than removed (section 12). Removing it
  // stops a pedal bass from dominating the profile, but it also robs a
  // root-position chord of any credit for stating its own root, which is the
  // opposite of what section 12 asks for. Weighting it low does both jobs.
  const profileNotes = separateBass && sorted.length > 2
    ? sorted.map((n) => (n.pitch === bassPitch
      ? { ...n, harmonicWeight: (n.harmonicWeight ?? 1) * BASS_PROFILE_WEIGHT }
      : n))
    : sorted;

  const profile = pitchClassProfile(profileNotes);
  const presentSet = new Set(sorted.map((n) => ((n.pitch % 12) + 12) % 12));

  const limit = COMPLEXITY_LIMITS[complexity] ?? 2;
  const complexityPenalty = complexity === 'exact' ? 0.012 : complexity === 'basic' ? 0.06 : 0.028;
  const extraPenaltyScale = complexity === 'basic' ? 0.35 : complexity === 'exact' ? 1.15 : 1;

  const context = { bassPc, keyProfile, complexityPenalty, presentSet, extraPenaltyScale };
  const hypotheses = [];

  for (let rootPc = 0; rootPc < 12; rootPc += 1) {
    if (!presentSet.has(rootPc)) continue; // a root nobody plays is not a reading we trust
    for (const template of CHORD_TEMPLATES) {
      if (template.complexity > limit) continue;
      if (template.dyad && presentSet.size > 2) continue;
      const h = scoreHypothesis(rootPc, template, profile, context);
      if (h) hypotheses.push(h);
    }
  }

  if (hypotheses.length === 0) {
    // Nothing in the vocabulary fits: report the raw material honestly rather
    // than forcing a chord name onto it.
    const pcs = [...presentSet].sort((a, b) => a - b);
    const fallback = {
      root: bassPc,
      templateId: null,
      quality: presentSet.size === 1 ? 'single note' : 'unclassified',
      suffix: '',
      symbol: presentSet.size === 1
        ? pcName(bassPc, { flats })
        : pcs.map((pc) => pcName(pc, { flats })).join(' '),
      bass: bassPc,
      inversion: 0,
      inversionName: 'root position',
      pitchClasses: pcs,
      confidence: presentSet.size === 1 ? 0.5 : 0.25,
      coverage: 0,
      explain: 0,
      score: 0,
      intervals: [],
      present: pcs,
      missing: [],
      extras: [],
    };
    return { candidates: [fallback], best: fallback };
  }

  hypotheses.sort((a, b) => b.score - a.score);

  // Confidence: absolute fit, tempered by how clearly the winner beats the
  // runner-up. Genuine ambiguity should read as ambiguous (section 31).
  const top = hypotheses[0];
  const runnerUp = hypotheses.find((h) => h.templateId !== top.templateId || h.root !== top.root);
  const margin = runnerUp ? Math.max(0, top.score - runnerUp.score) : 0.25;

  // Confidence must be monotonic with rank -- an alternative reading can never
  // display as more confident than the reading we chose.
  const clarity = Math.min(1, 0.55 + margin * 2.2);
  let ceiling = 1;
  const candidates = hypotheses.slice(0, maxCandidates).map((h, i) => {
    const absolute = Math.max(0, Math.min(1, h.score));
    const boost = i === 0 ? clarity : Math.max(0, clarity - 0.25 - i * 0.05);
    let confidence = Math.max(0.05, Math.min(0.99, absolute * 0.72 + absolute * boost * 0.28));
    confidence = Math.min(confidence, ceiling);
    ceiling = confidence;
    return {
      ...h,
      symbol: formatSymbol(h.root, TEMPLATES_BY_ID.get(h.templateId), h.bass, { flats }),
      rootName: pcName(h.root, { flats }),
      bassName: pcName(h.bass, { flats }),
      confidence,
    };
  });

  return { candidates, best: candidates[0] };
}

/**
 * How well does a set of pitch classes hang together as a single harmony?
 * Used by the note clusterer as its `harmonicScore` term (section 7) and by the
 * arpeggio detector. Cheap on purpose: it only needs triads/sevenths.
 */
export function harmonicCompatibility(pitches) {
  const pcs = [...new Set(pitches.map((p) => ((p % 12) + 12) % 12))];
  if (pcs.length <= 1) return 1;

  let best = 0;
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_TEMPLATES) {
      if (template.complexity > 2) continue;
      const set = new Set(template.intervals.map((i) => (root + i) % 12));
      let inside = 0;
      for (const pc of pcs) if (set.has(pc)) inside += 1;
      const outside = pcs.length - inside;
      const fit = inside / pcs.length - outside * 0.15 - (template.intervals.length - inside) * 0.04;
      if (fit > best) best = fit;
      if (best >= 1) return 1;
    }
  }
  return Math.max(0, best);
}

/** Interval content check used for quick dissonance screening. */
export function hasHarshCluster(pitches) {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap === 1) return true; // minor 2nd in the same register
  }
  return false;
}
