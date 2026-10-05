/**
 * Fingering feasibility and difficulty (brief section 27).
 *
 * The brief is clear that this does not need to be a human-fingering AI: "a
 * strong heuristic system will already produce useful results." So this models
 * the handful of constraints that actually decide whether a shape is playable:
 *
 *   - four fingers, one of which can barre
 *   - a barre mutes every string it crosses, so no open string may sit inside it
 *   - stretch is harder low on the neck, where the frets are wider
 *   - interior muted strings need deliberate damping
 */

export const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'];

export const DEFAULT_FINGERING_OPTIONS = {
  maxFingers: 4,
  maxSpan: 4,
  /** Spans this wide are rejected outright even in Literal mode. */
  impossibleSpan: 6,
  allowBarre: true,
  allowThumb: false,
};

/**
 * Frets get physically narrower as you move up the neck, so the same numeric
 * span is much harder at fret 1 than at fret 15.
 */
export function stretchDifficulty(span, position) {
  if (span <= 1) return 0;
  const extra = span - 1;
  const positionFactor = 1 + Math.max(0, (7 - position)) * 0.12; // low frets hurt
  return extra * 0.22 * positionFactor;
}

/**
 * Assign fingers to a voicing and rate the result.
 *
 * @param {object} voicing from generateVoicings
 * @param {Fretboard} fretboard
 * @param {object} [options]
 * @returns {{playable:boolean, difficulty:number, fingers:Array, barre:object|null, issues:string[]}}
 */
export function analyzeFingering(voicing, fretboard, options = {}) {
  const opts = { ...DEFAULT_FINGERING_OPTIONS, ...options };
  const capo = fretboard.capo ?? 0;
  const issues = [];

  const fretted = voicing.played
    .filter((p) => p.fret > capo)
    .sort((a, b) => a.fret - b.fret || a.string - b.string);

  if (fretted.length === 0) {
    return {
      playable: true,
      difficulty: 0,
      fingers: [],
      barre: null,
      issues: [],
      fingersUsed: 0,
      isOpenShape: true,
    };
  }

  const minFret = fretted[0].fret;
  const maxFret = fretted[fretted.length - 1].fret;
  const span = maxFret - minFret + 1;

  if (span > opts.impossibleSpan) {
    return {
      playable: false, difficulty: 10, fingers: [], barre: null,
      issues: [`fret span of ${span} is unplayable`], fingersUsed: 0,
    };
  }

  // Barre candidate: two or more strings sharing the lowest fretted fret.
  const atMinFret = fretted.filter((p) => p.fret === minFret);
  let barre = null;
  if (opts.allowBarre && atMinFret.length >= 2) {
    const lowString = Math.min(...atMinFret.map((p) => p.string));
    const highString = Math.max(...atMinFret.map((p) => p.string));

    // A barre physically crosses every string between its ends. Any string in
    // that range that has to ring open is impossible, and any string in that
    // range fretted *below* the barre is impossible too.
    let blocked = false;
    for (let s = lowString; s <= highString; s += 1) {
      const fret = voicing.frets[s];
      if (fret === 0 && capo === 0) { blocked = true; break; }
      if (fret !== null && fret > capo && fret < minFret) { blocked = true; break; }
    }
    if (!blocked) {
      barre = { fret: minFret, fromString: lowString, toString: highString, strings: atMinFret.map((p) => p.string) };
    }
  }

  // Finger assignment: barre takes the index; the rest go in ascending fret
  // order, which is how a hand naturally lies across a shape.
  const fingers = [];
  let nextFinger = 0;

  if (barre) {
    for (const p of atMinFret) {
      fingers.push({ string: p.string, fret: p.fret, finger: 1, isBarre: true });
    }
    nextFinger = 1;
  }

  const remaining = fretted.filter((p) => !(barre && p.fret === minFret));
  let lastFret = barre ? minFret : null;
  for (const p of remaining) {
    if (lastFret !== null && p.fret === lastFret && fingers.length > 0) {
      // Same fret, different string, no barre: needs its own finger unless an
      // adjacent string can share (we assume it cannot, to stay conservative).
      nextFinger = Math.min(nextFinger + 1, opts.maxFingers);
    } else if (lastFret === null) {
      nextFinger = 1;
    } else {
      nextFinger = Math.min(nextFinger + 1, opts.maxFingers);
    }
    fingers.push({ string: p.string, fret: p.fret, finger: nextFinger, isBarre: false });
    lastFret = p.fret;
  }

  const distinctFingers = new Set(fingers.map((f) => f.finger));
  const fingersUsed = distinctFingers.size;

  // Count how many distinct fretted positions actually need separate fingers.
  const distinctPositions = new Set(
    fretted.filter((p) => !(barre && p.fret === minFret)).map((p) => `${p.string}:${p.fret}`),
  ).size + (barre ? 1 : 0);

  let playable = true;
  if (distinctPositions > opts.maxFingers) {
    playable = false;
    issues.push(`needs ${distinctPositions} fingers`);
  }
  if (span > opts.maxSpan) {
    issues.push(`${span}-fret stretch`);
  }

  // Awkward crossing: a higher fret on a higher-pitched string below a lower
  // fret on a lower-pitched string forces the hand to arch backwards.
  let crossings = 0;
  for (let i = 0; i < fretted.length; i += 1) {
    for (let j = i + 1; j < fretted.length; j += 1) {
      const a = fretted[i];
      const b = fretted[j];
      if (a.string < b.string && a.fret > b.fret + 2) crossings += 1;
      if (a.string > b.string && b.fret > a.fret + 2) crossings += 1;
    }
  }
  if (crossings > 2) issues.push('awkward finger crossing');

  let difficulty = 0;
  difficulty += stretchDifficulty(span, minFret);
  // Reaching past the twelfth fret is progressively more awkward, and the very
  // top of the neck is rarely where a part belongs. Without this, a single note
  // has no reason to prefer B-string fret 1 over low-E fret 20.
  difficulty += Math.max(0, maxFret - 12) * 0.07;
  difficulty += Math.max(0, fingersUsed - 2) * 0.18;
  difficulty += crossings * 0.12;
  difficulty += (voicing.mutedInterior ?? 0) * 0.35;
  if (barre && span >= 4) difficulty += 0.3; // barre plus a wide reach
  if (minFret >= 1 && minFret <= 2 && span >= 4) difficulty += 0.25;
  if (!playable) difficulty += 3;

  // Open shapes and shapes that use open strings are easier.
  difficulty -= Math.min(0.3, (voicing.openStrings ?? 0) * 0.08);
  difficulty = Math.max(0, difficulty);

  return {
    playable,
    difficulty,
    fingers,
    barre,
    issues,
    fingersUsed,
    span,
    position: minFret,
    crossings,
    isOpenShape: minFret <= 3 && (voicing.openStrings ?? 0) > 0,
  };
}

/** Difficulty of moving the hand from one shape to the next. */
export function transitionDifficulty(fromVoicing, toVoicing) {
  if (!fromVoicing || !toVoicing) return 0;
  const a = fromVoicing.position ?? 0;
  const b = toVoicing.position ?? 0;
  const jump = Math.abs(a - b);

  // Staying put, or moving within a fret or two, is nearly free.
  let cost = jump <= 1 ? 0 : (jump - 1) * 0.14;

  // Shapes that share fretted strings are easier to move between.
  let shared = 0;
  for (let s = 0; s < fromVoicing.frets.length; s += 1) {
    const f = fromVoicing.frets[s];
    const t = toVoicing.frets[s];
    if (f !== null && t !== null && f === t) shared += 1;
  }
  cost -= Math.min(0.25, shared * 0.06);

  return Math.max(0, cost);
}
