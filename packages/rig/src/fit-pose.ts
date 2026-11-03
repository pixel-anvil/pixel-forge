/**
 * Pose search (B0.1): find the bone angles, and the part variants, whose render matches a target
 * image. Pure: the renderer is a function the caller passes in, so this module knows nothing about
 * documents, parts or images beyond their RGBA bytes.
 *
 * **Search.** Every unknown is an integer: a bone angle is a grid index (a multiple of the angle
 * quantum, counted in table steps of 0.25°), a variant slot is a choice index. The error of a pose
 * is the number of pixels whose RGBA differs from the target (a pixel with alpha 0 equals any other
 * pixel with alpha 0). Error 0 is an **exact match**. The search is a seeded coordinate descent:
 *
 * 1. From the start pose, take the unknowns in the order given. For a bone, try a coarse grid over
 *    its range (at most {@link FIT_POSE_COARSE} + 1 angles), refine around the best with strides
 *    `s/2, s/4, … 1` (both directions), then walk downhill one quantum at a time. For a variant
 *    slot, try every choice. Keep the best; a tie keeps the earlier candidate (the current value
 *    first).
 * 2. Repeat sweeps over all unknowns while a sweep lowers the error. When one does not, try **two
 *    unknowns at once** (every pair of up to 8 unknowns, else neighbours in the list): a bone ±1 or
 *    ±2 quanta against another, a variant against a bone. A parent turned by a quantum moves its
 *    whole chain, so a child often has to turn back, which no single-unknown move can do.
 * 3. When neither lowers the error and it is not 0, restart from the best pose with a random subset
 *    of unknowns re-drawn and a random phase for the coarse grid, up to `restarts` times.
 *
 * On a three-bone arm with a variant (the test fixture) this recovered 99 of 100 random poses of
 * ±150° exactly, with the defaults, in 45 to 1852 renders (one pose of the 100 was not found). Other rigs differ: the result reports
 * `exact`, and the caller decides.
 *
 * Every candidate is rendered at most once (results are cached by pose), the search stops at once on
 * an exact match, and it never renders more than `maxRenders` times: that number is a hard bound.
 * One bone line search costs at most `FIT_POSE_COARSE + 1 + 2·⌊log2 s⌋` renders, where `s` is the
 * coarse stride `⌈span / 16⌉` (25 renders for a ±180° range at a 1° quantum).
 *
 * **Determinism (ADR-010).** The random numbers come from a 32-bit xorshift generator seeded by
 * `seed` (G. Marsaglia, "Xorshift RNGs", Journal of Statistical Software 8(14), 2003, the 13-17-5
 * triple); there is no `Math.random`, no clock and no float arithmetic in a decision: angles are
 * integers in table steps, so the same input and seed give the same result on every platform.
 *
 * **Limits.** The error counts pixels, so a bone whose part is entirely off the target's pixels gives
 * a flat error: the descent cannot see which way to turn. The restarts exist for that. A search over
 * many bones with a distant start can end in a local minimum; widen `restarts`, order the bones
 * parent first, or narrow the ranges.
 * @packageDocumentation
 */
import { quantumSteps } from './angle.js';
import { RigError } from './errors.js';

/** An RGBA8 image, row-major, straight alpha (a decoded PNG, or a rendered frame's `toRGBA()`). */
export interface FitImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** A bone angle to search: `[min, max]` degrees relative to rest (inclusive), clockwise. */
export interface FitBone {
  /** Key of the bone in {@link FitPoseCandidate.angles} and the result. Unique among bones. */
  readonly bone: string;
  /** Lowest angle, degrees. Default `-180`. */
  readonly min?: number;
  /** Highest angle, degrees. Default `180`. */
  readonly max?: number;
  /** First angle tried, degrees (rounded to the quantum, clamped to the range). Default `0`. */
  readonly start?: number;
}

/** A part whose variant is searched. */
export interface FitVariantSlot {
  /** Key of the part in {@link FitPoseCandidate.variants} and the result. Unique among slots. */
  readonly part: string;
  /** The variants to choose from (opaque keys the renderer understands), at least one. */
  readonly choices: readonly string[];
  /** First choice tried. Default: the first in `choices`. */
  readonly start?: string;
}

/** What the renderer is asked to draw: one angle per searched bone, one choice per searched slot. */
export interface FitPoseCandidate {
  /** Degrees relative to rest, a multiple of the quantum, by {@link FitBone.bone}. */
  readonly angles: Readonly<Record<string, number>>;
  /** The chosen variant key, by {@link FitVariantSlot.part}. */
  readonly variants: Readonly<Record<string, string>>;
}

/** Input of {@link fitPose}. */
export interface FitPoseInput {
  /** The image to match. */
  readonly target: FitImage;
  /** The renderer: draws a candidate at the target's size. It must be pure. */
  readonly render: (pose: FitPoseCandidate) => FitImage;
  /** Bones to search, **parents before children**. */
  readonly bones: readonly FitBone[];
  /** Part variants to search. */
  readonly variants?: readonly FitVariantSlot[];
  /** Seed of the random restarts: any safe integer (taken modulo 2^32). */
  readonly seed: number;
  /** Angle quantum, degrees (a valid `angleQuantum`). Default `1`. */
  readonly quantum?: number;
  /** Most renderer calls, at least 1. Default {@link FIT_POSE_MAX_RENDERS}. */
  readonly maxRenders?: number;
  /** Most restarts after the first descent stalls, `≥ 0`. Default {@link FIT_POSE_RESTARTS}. */
  readonly restarts?: number;
}

/** Result of {@link fitPose}. */
export interface FitPoseResult {
  /** The best angles found, degrees relative to rest, by bone key. */
  readonly angles: Readonly<Record<string, number>>;
  /** The best variant choices, by part key. */
  readonly variants: Readonly<Record<string, string>>;
  /** Pixels that differ from the target at the best pose; 0 is an exact match. */
  readonly error: number;
  /** `error === 0`. */
  readonly exact: boolean;
  /** Renderer calls made (never more than `maxRenders`). */
  readonly renders: number;
  /** Restarts used. */
  readonly restarts: number;
}

/** The coarse grid of a bone line search has at most this many cells (so `+ 1` angles). */
export const FIT_POSE_COARSE = 16;
/** Default for {@link FitPoseInput.maxRenders}. */
export const FIT_POSE_MAX_RENDERS = 3000;
/** Default for {@link FitPoseInput.restarts}. */
export const FIT_POSE_RESTARTS = 8;

/**
 * The number of pixels at which `a` and `b` differ: any of R, G, B or A, except that two pixels with
 * alpha 0 are equal whatever their colour. The error measure of {@link fitPose}.
 * @throws RigError `BAD_VALUE` when the sizes or the buffer lengths differ from `width × height × 4`.
 */
export function pixelMismatch(a: FitImage, b: FitImage): number {
  const n = a.width * a.height * 4;
  if (a.width !== b.width || a.height !== b.height || a.data.length !== n || b.data.length !== n) {
    throw new RigError(
      'BAD_VALUE',
      `images differ in size: ${String(a.width)}x${String(a.height)} (${String(a.data.length)} bytes) vs ${String(b.width)}x${String(b.height)} (${String(b.data.length)} bytes)`,
    );
  }
  let diff = 0;
  for (let o = 0; o < n; o += 4) {
    const alphaA = a.data[o + 3] ?? 0;
    const alphaB = b.data[o + 3] ?? 0;
    if (alphaA === 0 && alphaB === 0) continue;
    if (
      alphaA !== alphaB ||
      a.data[o] !== b.data[o] ||
      a.data[o + 1] !== b.data[o + 1] ||
      a.data[o + 2] !== b.data[o + 2]
    ) {
      diff++;
    }
  }
  return diff;
}

/** A 32-bit xorshift generator (Marsaglia 2003, 13-17-5). */
class Xorshift32 {
  private s: number;
  constructor(seed: number) {
    // Scramble the seed so small seeds do not start in a weak region; the state must not be 0.
    this.s = Math.imul((seed >>> 0) + 0x9e3779b9, 0x85ebca6b) >>> 0 || 0x2545f491;
    for (let i = 0; i < 4; i++) this.next();
  }
  next(): number {
    let x = this.s;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.s = x;
    return x;
  }
  /** An integer in `[0, n)`, from the high bits. */
  below(n: number): number {
    return (this.next() >>> 8) % n;
  }
}

/** One unknown: a bone angle (grid indices `lo..hi`) or a variant slot (choices `0..hi`). */
interface Dim {
  readonly key: string;
  readonly kind: 'bone' | 'variant';
  readonly lo: number;
  readonly hi: number;
}

/** Up to this many unknowns, every pair is tried together; beyond it, only neighbours in the list. */
const PAIR_ALL = 8;

/** Thrown inside the search to unwind at an exact match or when the render budget is spent. */
class Done extends Error {}

const checkInt = (v: number, min: number, what: string): void => {
  if (!Number.isSafeInteger(v) || v < min) {
    throw new RigError('BAD_VALUE', `${what} must be an integer of at least ${String(min)}`);
  }
};

/** `x` degrees as table steps (0.25°), rounded half away from zero, exactly. */
function toSteps(x: number, what: string): number {
  if (!Number.isFinite(x) || Math.abs(x) > 1e6) {
    throw new RigError('BAD_VALUE', `${what} must be a finite angle of at most 1e6 degrees`);
  }
  const t = x * 4; // exact: a power-of-two scale
  return (t < 0 ? -Math.floor(-t + 0.5) : Math.floor(t + 0.5)) + 0;
}

/**
 * Searches bone angles and part variants so that `render(pose)` matches `target`. See the module
 * comment for the algorithm, the bounds and the determinism rules.
 *
 * Angles are multiples of `quantum`; a bone range that holds no multiple is refused. Nothing is
 * rendered unless the input is valid.
 * @throws RigError `BAD_VALUE` for an empty search, a duplicate key, an empty or reversed range, a
 *   bad `maxRenders`, `restarts` or `seed`, a renderer result of another size than the target;
 *   `BAD_QUANTUM` for an invalid `quantum`.
 */
export function fitPose(input: FitPoseInput): FitPoseResult {
  const quantum = input.quantum ?? 1;
  const qs = quantumSteps(quantum); // quantum in 0.25° steps
  const slots = input.variants ?? [];
  const maxRenders = input.maxRenders ?? FIT_POSE_MAX_RENDERS;
  const maxRestarts = input.restarts ?? FIT_POSE_RESTARTS;
  checkInt(maxRenders, 1, 'maxRenders');
  checkInt(maxRestarts, 0, 'restarts');
  if (!Number.isSafeInteger(input.seed)) throw new RigError('BAD_VALUE', 'seed must be an integer');
  if (input.bones.length + slots.length === 0) {
    throw new RigError('BAD_VALUE', 'nothing to search: give at least one bone or variant slot');
  }

  const dims: Dim[] = [];
  const start: number[] = [];
  const seen = new Set<string>();
  const unique = (kind: string, key: string): void => {
    if (key === '' || seen.has(`${kind}:${key}`)) {
      throw new RigError('BAD_VALUE', `${kind} key "${key}" is empty or used twice`);
    }
    seen.add(`${kind}:${key}`);
  };
  for (const b of input.bones) {
    unique('bone', b.bone);
    const minS = toSteps(b.min ?? -180, `${b.bone} min`);
    const maxS = toSteps(b.max ?? 180, `${b.bone} max`);
    const lo = Math.ceil(minS / qs);
    const hi = Math.floor(maxS / qs);
    if (lo > hi) {
      throw new RigError(
        'BAD_VALUE',
        `bone ${b.bone}: no multiple of ${String(quantum)} degrees in [${String(b.min ?? -180)}, ${String(b.max ?? 180)}]`,
      );
    }
    const s0 = Math.round(toSteps(b.start ?? 0, `${b.bone} start`) / qs);
    dims.push({ key: b.bone, kind: 'bone', lo, hi });
    start.push(Math.min(hi, Math.max(lo, s0)) + 0);
  }
  for (const v of slots) {
    unique('variant', v.part);
    if (v.choices.length === 0) {
      throw new RigError('BAD_VALUE', `variant slot ${v.part} has no choices`);
    }
    const s0 = v.start === undefined ? 0 : v.choices.indexOf(v.start);
    if (s0 < 0) throw new RigError('BAD_VALUE', `variant slot ${v.part}: start is not a choice`);
    dims.push({ key: v.part, kind: 'variant', lo: 0, hi: v.choices.length - 1 });
    start.push(s0);
  }

  const rng = new Xorshift32(input.seed);
  const cache = new Map<string, number>();
  let renders = 0;
  let best = start.slice();
  let bestError = Number.POSITIVE_INFINITY;

  const candidate = (at: readonly number[]): FitPoseCandidate => {
    const angles: Record<string, number> = {};
    const variants: Record<string, string> = {};
    dims.forEach((d, i) => {
      const k = at[i] ?? 0;
      if (d.kind === 'bone') angles[d.key] = (k * qs) / 4 + 0;
      else variants[d.key] = slots.find((s) => s.part === d.key)?.choices[k] ?? '';
    });
    return { angles, variants };
  };

  /** The error of `at`: cached, else one render. Unwinds on an exact match or when the budget is spent. */
  const errorAt = (at: readonly number[]): number => {
    const key = at.join(',');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (renders >= maxRenders) throw new Done();
    renders++;
    const err = pixelMismatch(input.render(candidate(at)), input.target);
    cache.set(key, err);
    if (err < bestError) {
      bestError = err;
      best = at.slice();
    }
    if (err === 0) throw new Done();
    return err;
  };

  /** One line search over dimension `d`, in place on `cur`. Returns the error at `cur` afterwards. */
  const search = (cur: number[], d: number, phase: number): number => {
    const dim = dims[d];
    if (dim === undefined || dim.hi === dim.lo) return errorAt(cur);
    let bestK = cur[d] ?? dim.lo;
    const trial = (k: number): number => {
      const at = cur.slice();
      at[d] = k;
      return errorAt(at);
    };
    let bestE = trial(bestK);
    const consider = (k: number): void => {
      const e = trial(k);
      if (e < bestE) {
        bestE = e;
        bestK = k;
      }
    };
    if (dim.kind === 'variant') {
      for (let k = dim.lo; k <= dim.hi; k++) consider(k);
    } else {
      const span = dim.hi - dim.lo;
      const stride = Math.max(1, Math.ceil(span / FIT_POSE_COARSE));
      const first = dim.lo + (stride > 1 ? phase % stride : 0);
      for (let k = first; k <= dim.hi; k += stride) consider(k);
      consider(dim.hi);
      for (let s = Math.floor(stride / 2); s >= 1; s = Math.floor(s / 2)) {
        const centre = bestK;
        if (centre - s >= dim.lo) consider(centre - s);
        if (centre + s <= dim.hi) consider(centre + s);
      }
      // Walk downhill one quantum at a time to the bottom of the dip.
      for (let centre = bestK - 1; centre !== bestK;) {
        centre = bestK;
        if (centre - 1 >= dim.lo) consider(centre - 1);
        if (centre + 1 <= dim.hi) consider(centre + 1);
      }
    }
    cur[d] = bestK;
    return bestE;
  };

  /** The small moves of dimension `d` at `k`: a bone ±1 and ±2 quanta, a variant slot every other choice. */
  const moves = (d: number, k: number): number[] => {
    const dim = dims[d];
    if (dim === undefined) return [];
    const out: number[] = [];
    if (dim.kind === 'bone') {
      for (const m of [-2, -1, 1, 2]) if (k + m >= dim.lo && k + m <= dim.hi) out.push(k + m);
    } else {
      for (let c = dim.lo; c <= dim.hi; c++) if (c !== k) out.push(c);
    }
    return out;
  };

  /** The pairs of dimensions tried together: all pairs of at most 8 unknowns, else neighbours in the list. */
  const pairs: [number, number][] = [];
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < (dims.length <= PAIR_ALL ? dims.length : i + 2); j++)
      pairs.push([i, j]);
  }

  /**
   * Moves two unknowns at once (a parent against its child, a variant with an angle): the line
   * searches cannot, and a one-quantum parent move shifts everything below it. Per pair, the best
   * improving combination is applied. Returns the error at `cur` afterwards.
   */
  const pairPass = (cur: number[], from: number): number => {
    let e = from;
    for (const [i, j] of pairs) {
      const ki = cur[i] ?? 0;
      const kj = cur[j] ?? 0;
      let pick: [number, number] | undefined;
      for (const a of moves(i, ki)) {
        for (const b of moves(j, kj)) {
          const at = cur.slice();
          at[i] = a;
          at[j] = b;
          const err = errorAt(at);
          if (err < e) {
            e = err;
            pick = [a, b];
          }
        }
      }
      if (pick !== undefined) {
        cur[i] = pick[0];
        cur[j] = pick[1];
      }
    }
    return e;
  };

  /** Line-search sweeps, then pair moves, from `from`, until neither lowers the cost of the pose it works on. */
  const descend = (from: readonly number[], phase: number): void => {
    const cur = from.slice();
    let e = errorAt(cur);
    for (;;) {
      const before = e;
      for (let d = 0; d < dims.length; d++) e = search(cur, d, phase);
      if (e < before) continue;
      e = pairPass(cur, e);
      if (!(e < before)) return;
    }
  };

  let restarts = 0;
  try {
    descend(start, 0);
    while (restarts < maxRestarts) {
      restarts++;
      const from = best.slice();
      const order = dims.map((_, i) => i);
      const count = 1 + rng.below(dims.length);
      for (let i = 0; i < count; i++) {
        const j = i + rng.below(order.length - i);
        const d = order[j] ?? 0;
        order[j] = order[i] ?? 0;
        order[i] = d;
        const dim = dims[d];
        if (dim !== undefined) from[d] = dim.lo + rng.below(dim.hi - dim.lo + 1);
      }
      descend(from, rng.below(1 << 16));
    }
  } catch (e) {
    if (!(e instanceof Done)) throw e;
  }

  const out = candidate(best);
  return {
    angles: out.angles,
    variants: out.variants,
    error: bestError,
    exact: bestError === 0,
    renders,
    restarts,
  };
}
