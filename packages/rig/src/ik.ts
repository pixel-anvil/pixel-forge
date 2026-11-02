/**
 * Inverse kinematics (FR-RIG-13): an analytic two-bone solver and FABRIK for longer chains, both
 * **baked to FK key angles** at the angle quantum. The result is a list of bone angles (degrees
 * relative to rest, like `BoneKey.angle`), never IK state: a target is a handle, and committing it
 * writes plain FK keys.
 *
 * **Model.** A chain is `n` rotating bones. Bone `i` turns the rest offset `segments[i]` of the next
 * joint (the next bone's pivot, the last one being the end effector), exactly as `snapSkeleton` does:
 * `joint[i + 1] = joint[i] + rotatePoint(segments[i], base + R[i])`, where `R[i]` is the sum of the
 * chain's key angles up to bone `i`. Bone lengths are the lengths of the rest offsets; FK only rotates
 * them, so they never change.
 *
 * **Steps.** (1) Solve for the world direction of every bone: the two-bone solver in closed form
 * (law of cosines / circle–circle intersection), FABRIK by iteration. (2) Bake: each direction becomes
 * a table step (0.25°) by an exact integer search of raster's Q16 table ({@link directionStep}), the
 * rotation away from rest is rounded to the quantum. (3) Refine, when the target is reachable: a small
 * deterministic local search over the quantised rotations (single bones and adjacent pairs,
 * `±1 … ±max(2, ⌈1°/q⌉)` quanta) lowers the distance from the **snapped** FK effector to the target,
 * so the pixel rounding of every joint is accounted for. An unreachable target keeps the baked,
 * straight chain. The output is that FK pose.
 *
 * **Limits.** "Within 1 px" needs a quantum fine enough for the bones: one quantum must move the
 * effector by about a pixel or less. Measured on random reachable targets (the FK image of random
 * poses): two-bone, all within 1 px for quanta 0.25° to 2° with bones up to 48 px, 1499 of 1500 at 1°
 * with bones up to 96 px; at 5° with 48 px bones 1450 of 1500. FABRIK (3 to 6 bones from a random
 * start pose): all within 1 px for quanta 0.25° to 2° with bones up to 96 px.
 *
 * **Determinism (ADR-010).** Everything in a decision is integer: coordinates are BigInt fixed point
 * (Q16, `× 65536`), square roots are exact integer square roots ({@link isqrt}), divisions round half
 * away from zero, directions come from the committed Q16 sine table. No `Math` trig, no `Math.sqrt`,
 * no randomness, no clock: the same input gives the same angles on every platform.
 * @packageDocumentation
 */
import { ANGLE_STEPS, cosQ16, rotatePoint, rotatePointQ16, sinQ16 } from '@pixel-forge/raster';
import { ANGLE_QUANTUM_DEFAULT, type BoneId, type Point } from '@pixel-forge/schema';
import {
  quantizeDyadic,
  quantumSteps,
  roundHalfAway,
  safeSteps,
  stepsToDeg,
  toDyadic,
  wrapSteps,
} from './angle.js';
import { RigError } from './errors.js';
import { checkCoord, own } from './keys.js';
import type { BoneGraph } from './order.js';
import { type Pose, type RestPose, snapSkeleton } from './snap.js';

/** Default and largest FABRIK iteration budget: one iteration is a forward and a backward pass. */
export const IK_ITERATIONS_DEFAULT = 64;
const IK_ITERATIONS_MAX = 10_000;
/** Most bones in one IK chain. */
export const IK_MAX_BONES = 64;

/** Which way the joint of a two-bone chain bends: the turn of the second bone from the first. */
export type IkBend = 'cw' | 'ccw';
/** The solver of {@link solveIk}. */
export type IkSolver = 'two-bone' | 'fabrik';

/** A chain of rotating bones (see the module notes). All coordinates are integer canvas pixels. */
export interface IkChain {
  /** Pivot of the first bone (it does not move). */
  readonly root: Readonly<Point>;
  /**
   * One per bone, parents first: the rest offset of the next joint from this bone's pivot (the next
   * bone's rest `(x, y)`, ADR-012). The last joint is the end effector.
   */
  readonly segments: readonly Readonly<Point>[];
  /**
   * Rotation away from rest of the first bone's parent, degrees, a multiple of 0.25 (a
   * `SnappedBone.rotation`). Default 0.
   */
  readonly baseRotation?: number;
  /**
   * The current key angle of each bone (degrees relative to rest), default all 0. FABRIK starts from
   * this pose, the two-bone solver takes its default bend from it, a bone the solve cannot turn
   * (zero length, or no direction to the target) keeps its key angle (relative to its parent's new
   * rotation, so it still turns with the parent), and every result angle is chosen within
   * 180° of it, so interpolating from the current key never spins.
   */
  readonly angles?: readonly number[];
}

/** Options of {@link solveTwoBone} and {@link solveFabrik}. */
export interface IkOptions {
  /** Angle quantum in degrees (a valid schema `AngleQuantum`); default 1. */
  readonly angleQuantum?: number;
  /**
   * Two-bone only: `'cw'` turns the second bone clockwise from the first (local joint angle in
   * `[0°, 180°]`; the joint lies counter-clockwise of the root → target line), `'ccw'` the other way.
   * Default: the side the chain bends to now (`chain.angles`), clockwise when it is straight.
   */
  readonly bend?: IkBend;
  /** FABRIK only: the iteration budget, an integer in `1..10000`. Default {@link IK_ITERATIONS_DEFAULT}. */
  readonly iterations?: number;
}

/** A baked IK solution. */
export interface IkSolution {
  /**
   * One key angle per bone, parents first: degrees relative to rest, multiples of the quantum, each
   * in `(cur − 180°, cur + 180°]` where `cur` is the bone's current key (`chain.angles`, quantised).
   */
  readonly angles: readonly number[];
  /** Where these angles put the end effector, by the snapped FK of `snapSkeleton` (integer pixel). */
  readonly effector: Readonly<Point>;
  /** True when the effector is within 1 px of the target on both axes. */
  readonly reached: boolean;
}

/** Input of {@link solveIk}. */
export interface IkInput {
  readonly rig: BoneGraph;
  readonly view: RestPose;
  /** The current pose (keys by bone; missing bones and channels at rest). Default: the rest pose. */
  readonly pose?: Pose;
  /** The bone whose pivot should reach the target (e.g. `hand_r`). */
  readonly effector: BoneId;
  /** Integer canvas pixel. */
  readonly target: Readonly<Point>;
  /** How many ancestors of the effector turn, nearest first counted upward. Default 2. */
  readonly chainLength?: number;
  /** Default: `'two-bone'` for a chain of 2, else `'fabrik'`. `'two-bone'` needs a chain of 2. */
  readonly solver?: IkSolver;
  /** Angle quantum in degrees; default 1 (use the animation's). */
  readonly angleQuantum?: number;
  /** Two-bone only (`RigError('BAD_VALUE')` with FABRIK or a chain other than 2). */
  readonly bend?: IkBend;
  readonly iterations?: number;
}

/** Result of {@link solveIk}. */
export interface IkPoseSolution {
  /** The new key angle of every chain bone, parents first (degrees relative to rest). */
  readonly angles: ReadonlyMap<BoneId, number>;
  /** The effector's snapped pivot with these angles and the rest of the pose unchanged. */
  readonly effector: Readonly<Point>;
  /** True when the effector is within 1 px of the target on both axes. */
  readonly reached: boolean;
}

type Vec = readonly [bigint, bigint];

const BENDS: ReadonlySet<string> = new Set<IkBend>(['cw', 'ccw']);

/** Q16 fixed point: one pixel is 65536 units. */
const Q = 16n;
const ONE = 1n << Q;
/** FABRIK stops when the effector is within 1/16 px of the target. */
const TOLERANCE2 = (ONE / 16n) ** 2n;
const QUARTER = ANGLE_STEPS / 4;
const HALF = ANGLE_STEPS / 2;
const MAX_REFINE_PASSES = 64;

/** The table directions of the first quadrant and its end, `0..360` steps, as BigInt Q16 vectors. */
const UNIT: readonly Vec[] = Array.from({ length: QUARTER + 1 }, (_, k): Vec => {
  const deg = stepsToDeg(k);
  return [BigInt(cosQ16(deg)), BigInt(sinQ16(deg))];
});

const unit = (k: number): Vec => UNIT[k] ?? [0n, 0n];
const cross = (a: Vec, x: bigint, y: bigint): bigint => a[0] * y - a[1] * x;
const norm2 = (v: Vec): bigint => v[0] * v[0] + v[1] * v[1];
const neg = (v: Vec): Vec => [-v[0], -v[1]];

/**
 * @internal The exact floor square root of a non-negative BigInt, by Newton's iteration from above
 * (`x ← ⌊(x + ⌊n/x⌋)/2⌋` from a power of two `≥ √n`; it decreases until it reaches `⌊√n⌋`). Integer
 * maths only, so it is the same on every platform.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RigError('BAD_VALUE', 'square root of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** `√n` rounded to the nearest integer (no tie is possible: `(r + ½)²` is not an integer). */
function sqrtRound(n: bigint): bigint {
  const r = isqrt(n);
  return n - r * r > r ? r + 1n : r;
}

/**
 * @internal The table step (`0..1439`, 0.25° each, clockwise, y down) whose direction in raster's Q16
 * table is nearest to the vector `(x, y)`; `undefined` for the zero vector. Exact: the vector is
 * turned by quarter turns into the first quadrant, the step just counter-clockwise of it is found by a
 * binary search on the sign of a cross product, and the nearer of that step and the next is chosen by
 * comparing `|sin|` of the two angle differences as exact BigInt ratios
 * (`cross² · |u_other|²`). A tie keeps the lower step. It is the integer replacement of `atan2`: every
 * table direction maps to its own step.
 */
export function directionStep(x: bigint, y: bigint): number | undefined {
  if (x === 0n && y === 0n) return undefined;
  let vx = x;
  let vy = y;
  let quarters = 0;
  while (!(vx > 0n && vy >= 0n)) {
    // Turn by -90° (counter-clockwise on screen): (x, y) -> (y, -x).
    const t = vx;
    vx = vy;
    vy = -t;
    quarters++;
  }
  // Largest k in 0..359 with the vector at or clockwise of u_k (u_0 always qualifies, u_360 never).
  let lo = 0;
  let hi = QUARTER - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cross(unit(mid), vx, vy) >= 0n) lo = mid;
    else hi = mid - 1;
  }
  const a = unit(lo);
  const b = unit(lo + 1);
  const ca = cross(a, vx, vy);
  const cb = cross(b, vx, vy);
  const k = cb * cb * norm2(a) < ca * ca * norm2(b) ? lo + 1 : lo;
  return (k + QUARTER * quarters) % ANGLE_STEPS;
}

/** Everything a solve needs, validated. Angles are in table steps. */
interface Context {
  readonly root: Readonly<Point>;
  readonly segs: readonly Readonly<Point>[];
  readonly target: Readonly<Point>;
  /** Base rotation, steps `0..1439`. */
  readonly base: number;
  readonly qSteps: number;
  /** Current key angles, quantised, in steps (not wrapped). */
  readonly cur: readonly number[];
  /** Current world rotation away from rest of each bone, minus the base: `Σ cur[0..i]`. */
  readonly curRel: readonly number[];
}

function context(
  chain: IkChain,
  target: Readonly<Point>,
  opts: IkOptions,
  min: number,
  max: number,
): Context {
  const n = chain.segments.length;
  if (n < min || n > max) {
    throw new RigError(
      'BAD_VALUE',
      min === max
        ? `the chain must have ${String(min)} bones, got ${String(n)}`
        : `the chain must have ${String(min)} to ${String(max)} bones, got ${String(n)}`,
    );
  }
  const qSteps = quantumSteps(opts.angleQuantum ?? ANGLE_QUANTUM_DEFAULT);
  checkCoord(chain.root.x, 'IK root x');
  checkCoord(chain.root.y, 'IK root y');
  checkCoord(target.x, 'IK target x');
  checkCoord(target.y, 'IK target y');
  chain.segments.forEach((s, i) => {
    checkCoord(s.x, `IK segment ${String(i)} x`);
    checkCoord(s.y, `IK segment ${String(i)} y`);
  });
  const baseDeg = chain.baseRotation ?? 0;
  const base4 = baseDeg * 4;
  if (!Number.isSafeInteger(base4)) {
    throw new RigError(
      'BAD_VALUE',
      `baseRotation must be a finite multiple of 0.25, got ${String(baseDeg)}`,
    );
  }
  const angles = chain.angles ?? [];
  if (chain.angles !== undefined && angles.length !== n) {
    throw new RigError(
      'BAD_VALUE',
      `the chain has ${String(n)} bones but ${String(angles.length)} angles`,
    );
  }
  const cur: number[] = [];
  const curRel: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = angles[i] ?? 0;
    const steps = safeSteps(
      quantizeDyadic(toDyadic(a, `IK angle ${String(i)}`), qSteps),
      'IK angle',
    );
    cur.push(steps);
    // Reduce the step first: `sum + steps` could pass 2^53 and lose its low bit.
    sum = wrapSteps(sum + wrapSteps(steps));
    curRel.push(sum);
  }
  if (opts.iterations !== undefined) {
    const it = opts.iterations;
    if (!Number.isInteger(it) || it < 1 || it > IK_ITERATIONS_MAX) {
      throw new RigError(
        'BAD_VALUE',
        `iterations must be an integer in 1..${String(IK_ITERATIONS_MAX)}, got ${String(it)}`,
      );
    }
  }
  return {
    root: chain.root,
    segs: chain.segments,
    target,
    base: wrapSteps(base4),
    qSteps,
    cur,
    curRel,
  };
}

/** Bone `i`'s current world segment as an exact Q16 vector. */
function curVec(ctx: Context, i: number): Vec {
  const s = ctx.segs[i] ?? { x: 0, y: 0 };
  const [x, y] = rotatePointQ16(s.x, s.y, stepsToDeg(wrapSteps(ctx.base + (ctx.curRel[i] ?? 0))));
  return [BigInt(x), BigInt(y)];
}

const segLen2 = (s: Readonly<Point>): bigint => BigInt(s.x) ** 2n + BigInt(s.y) ** 2n;

/**
 * Step (2), the bake: world directions → rotations away from rest relative to the base, taken in
 * `(−180°, 180°]` and rounded half away from zero to the quantum (odd, so a mirrored problem gives
 * mirrored angles). A bone with no direction (`undefined`, or a zero-length rest segment) keeps its
 * current local key: its rotation is the previous bone's plus that key (`frozen` marks these bones,
 * which {@link refine} turns together with their parent, never by themselves).
 */
function bake(
  ctx: Context,
  dirs: readonly (Vec | undefined)[],
): { rel: number[]; frozen: boolean[] } {
  const out: number[] = [];
  const frozen: boolean[] = [];
  ctx.segs.forEach((s, i) => {
    const d = dirs[i];
    const dir = d === undefined ? undefined : directionStep(d[0], d[1]);
    const restDir = directionStep(BigInt(s.x), BigInt(s.y));
    if (dir === undefined || restDir === undefined) {
      // Cannot turn: keep the local key, i.e. the same turn from the (new) parent's frame.
      out.push((out[i - 1] ?? 0) + wrapSteps(ctx.cur[i] ?? 0));
      frozen.push(true);
      return;
    }
    frozen.push(false);
    let rel = wrapSteps(dir - restDir - ctx.base);
    if (rel > HALF) rel -= ANGLE_STEPS;
    const q = BigInt(ctx.qSteps);
    out.push(Number(roundHalfAway(BigInt(rel), q) * q));
  });
  return { rel: out, frozen };
}

/** The snapped FK effector of the rotations `rel` (steps relative to the base), as in `snapSkeleton`. */
function effectorOf(ctx: Context, rel: readonly number[]): Point {
  let x = ctx.root.x;
  let y = ctx.root.y;
  ctx.segs.forEach((s, i) => {
    const [dx, dy] = rotatePoint(s.x, s.y, stepsToDeg(wrapSteps(ctx.base + (rel[i] ?? 0))));
    x += dx;
    y += dy;
  });
  return { x: x + 0, y: y + 0 };
}

function errorOf(ctx: Context, rel: readonly number[]): bigint {
  const e = effectorOf(ctx, rel);
  const dx = BigInt(e.x - ctx.target.x);
  const dy = BigInt(e.y - ctx.target.y);
  return dx * dx + dy * dy;
}

/**
 * Step (3), for a reachable target only: a deterministic local search on the snapped FK, among the
 * poses `allowed` accepts (the two-bone bend side). Moves of one bone by `±1 … ±r` quanta
 * (`r = max(2, ⌈1° / q⌉)`), then, when none helps, of two adjacent bones at once; a move is taken
 * only when it strictly lowers the squared distance to the target, in a fixed order, until no move
 * helps (at most 64 passes). Rotations are per bone (relative to the base), so moving one bone never
 * moves the bones after it, except the `frozen` ones (see {@link bake}), which turn with their parent
 * and are never moved alone.
 */
function refine(
  ctx: Context,
  start: readonly number[],
  frozen: readonly boolean[],
  allowed: (rel: readonly number[]) => boolean = () => true,
): number[] {
  const q = ctx.qSteps;
  const radius = Math.max(2, Math.ceil(4 / q));
  const moves: number[] = [];
  for (let k = 1; k <= radius; k++) moves.push(k * q, -k * q);
  let rel = [...start];
  let best = errorOf(ctx, rel);
  // Turns bone `i` by `m`, and the frozen bones after it with it, so they keep their local keys.
  const turn = (trial: number[], i: number, m: number): void => {
    trial[i] = (trial[i] ?? 0) + m;
    for (let j = i + 1; j < trial.length && frozen[j] === true; j++) {
      trial[j] = (trial[j] ?? 0) + m;
    }
  };
  const tryMove = (trial: number[]): boolean => {
    if (!allowed(trial)) return false;
    const e = errorOf(ctx, trial);
    if (e >= best) return false;
    best = e;
    rel = trial;
    return true;
  };
  for (let pass = 0; pass < MAX_REFINE_PASSES && best > 0n; pass++) {
    let improved = false;
    for (let i = 0; i < rel.length; i++) {
      if (frozen[i] === true) continue;
      for (const m of moves) {
        const trial = [...rel];
        turn(trial, i, m);
        if (tryMove(trial)) improved = true;
      }
    }
    if (!improved) {
      for (let i = 0; i + 1 < rel.length; i++) {
        if (frozen[i] === true || frozen[i + 1] === true) continue;
        for (const m1 of moves) {
          for (const m2 of moves) {
            const trial = [...rel];
            turn(trial, i, m1);
            turn(trial, i + 1, m2);
            if (tryMove(trial)) improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  return rel;
}

/** Turns per-bone rotations into key angles near the current keys, plus the FK effector. */
function finish(ctx: Context, rel: readonly number[]): IkSolution {
  const angles = rel.map((r, i) => {
    const cur = ctx.cur[i] ?? 0;
    const local = r - (i === 0 ? 0 : (rel[i - 1] ?? 0));
    let m = wrapSteps(local - wrapSteps(cur));
    if (m > HALF) m -= ANGLE_STEPS;
    return stepsToDeg(safeSteps(BigInt(cur) + BigInt(m), 'IK angle'));
  });
  const effector = effectorOf(ctx, rel);
  const reached =
    Math.abs(effector.x - ctx.target.x) <= 1 && Math.abs(effector.y - ctx.target.y) <= 1;
  return { angles, effector, reached };
}

function currentBend(ctx: Context): IkBend {
  const a = curVec(ctx, 0);
  const b = curVec(ctx, 1);
  return cross(a, b[0], b[1]) < 0n ? 'ccw' : 'cw';
}

/**
 * Step (1) of the two-bone solver: the world direction of both bones, exactly up to one integer square
 * root. With `d = target − root`, `D² = |d|²`, `K = L1² − L2² + D²` and `Δ = 4·L1²·D² − K²`, the joint
 * is at `root + (K·d ± √Δ·d⊥) / (2D²)` (the intersection of the circles of radius `L1` about the root
 * and `L2` about the target), so the first bone points along `K·d ± √Δ·d⊥` and the second along
 * `(2D² − K)·d ∓ √Δ·d⊥`. `Δ ≥ 0` exactly when the target is reachable (`|L1 − L2| ≤ D ≤ L1 + L2`).
 * Out of reach, both bones point at the target; too close, the chain folds (the longer bone toward
 * the target). On the root itself, the first bone keeps its direction and the second folds back.
 */
function twoBoneDirections(
  ctx: Context,
  bend: IkBend,
): { dirs: (Vec | undefined)[]; reachable: boolean } {
  const [s0, s1] = ctx.segs as [Readonly<Point>, Readonly<Point>];
  const l1 = segLen2(s0);
  const l2 = segLen2(s1);
  const dx = BigInt(ctx.target.x - ctx.root.x);
  const dy = BigInt(ctx.target.y - ctx.root.y);
  const d2 = dx * dx + dy * dy;
  const d: Vec | undefined = d2 === 0n ? undefined : [dx, dy];
  if (l1 === 0n || l2 === 0n) {
    // One bone (or none) moves the effector: pointing it at the target is the answer, and the
    // refinement can only fine-tune it.
    return { dirs: [l1 === 0n ? undefined : d, l2 === 0n ? undefined : d], reachable: true };
  }
  if (d === undefined) {
    const u = curVec(ctx, 0);
    return { dirs: [u, neg(u)], reachable: l1 === l2 };
  }
  const k = l1 - l2 + d2;
  const disc = 4n * l1 * d2 - k * k;
  if (disc >= 0n) {
    const sq = sqrtRound(disc * ONE * ONE);
    const sigma = bend === 'cw' ? -1n : 1n;
    // d⊥ = (-dy, dx): d turned 90° clockwise on screen.
    const m = 2n * d2 - k;
    const dirs: Vec[] = [
      [k * ONE * dx - sigma * sq * dy, k * ONE * dy + sigma * sq * dx],
      [m * ONE * dx + sigma * sq * dy, m * ONE * dy - sigma * sq * dx],
    ];
    return { dirs, reachable: true };
  }
  const e = d2 - l1 - l2;
  if (e > 0n && e * e > 4n * l1 * l2) return { dirs: [d, d], reachable: false };
  return { dirs: l1 >= l2 ? [d, neg(d)] : [neg(d), d], reachable: false };
}

/**
 * Analytic two-bone IK (law of cosines; equivalently the intersection of two circles), baked to FK.
 * `chain.segments` must hold exactly 2 bones. A reachable target is reached within 1 px on both axes
 * (tested at quanta 0.25 to 2 with bones of 3 to 48 px); an unreachable one gets the chain stretched
 * straight toward it (or folded, when it is closer to the root than `|L1 − L2|`). The joint bends to
 * `opts.bend`. See the module notes for the bake and the refinement.
 *
 * Throws `RigError`: `BAD_VALUE` (not 2 bones, a non-integer or out-of-range coordinate, a bad
 * angle, `baseRotation` or `bend`), `BAD_QUANTUM`.
 */
export function solveTwoBone(
  chain: IkChain,
  target: Readonly<Point>,
  opts: IkOptions = {},
): IkSolution {
  const ctx = context(chain, target, opts, 2, 2);
  const given: string | undefined = opts.bend;
  if (given !== undefined && !BENDS.has(given)) {
    throw new RigError('BAD_VALUE', `bend must be 'cw' or 'ccw', got ${JSON.stringify(given)}`);
  }
  const bend = opts.bend ?? currentBend(ctx);
  const { dirs, reachable } = twoBoneDirections(ctx, bend);
  const { rel: baked, frozen } = bake(ctx, dirs);
  if (!reachable) return finish(ctx, baked);
  const [s0, s1] = ctx.segs as [Readonly<Point>, Readonly<Point>];
  const r0 = directionStep(BigInt(s0.x), BigInt(s0.y));
  const r1 = directionStep(BigInt(s1.x), BigInt(s1.y));
  // The refinement keeps the joint on the requested side (straight and folded count as both).
  const side = (rel: readonly number[]): boolean => {
    if (r0 === undefined || r1 === undefined) return true;
    const turn = wrapSteps(r1 + (rel[1] ?? 0) - r0 - (rel[0] ?? 0));
    return turn === 0 || (bend === 'cw' ? turn <= HALF : turn >= HALF);
  };
  return finish(ctx, refine(ctx, baked, frozen, side));
}

/** @internal The FABRIK joints in Q16 (root first), the Q16 bone lengths and the iterations used. */
export interface FabrikJoints {
  readonly joints: readonly Vec[];
  readonly lengths: readonly bigint[];
  readonly iterations: number;
  /** False when the target is farther from the root than the sum of the bone lengths. */
  readonly reachable: boolean;
}

/**
 * `v` scaled to length `len`, each coordinate rounded half away from zero; `fallback` gives the
 * direction when `v` is zero. The norm is taken of `v · 2^32`, so even a vector of a few units keeps
 * its direction and the result its length (within the half-unit rounding of each coordinate).
 */
function scaleTo(v: Vec, len: bigint, fallback: Vec): Vec {
  if (len === 0n) return [0n, 0n];
  const w = v[0] === 0n && v[1] === 0n ? fallback : v;
  const m = sqrtRound(norm2(w) << 64n);
  return [roundHalfAway((w[0] * len) << 32n, m), roundHalfAway((w[1] * len) << 32n, m)];
}

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const same = (a: Vec, b: Vec): boolean => a[0] === b[0] && a[1] === b[1];

function fabrik(ctx: Context, iterations: number): FabrikJoints {
  const n = ctx.segs.length;
  const lengths = ctx.segs.map((s) => sqrtRound(segLen2(s) * ONE * ONE));
  const start = ctx.segs.map((_, i) => curVec(ctx, i));
  const root: Vec = [BigInt(ctx.root.x) << Q, BigInt(ctx.root.y) << Q];
  const target: Vec = [BigInt(ctx.target.x) << Q, BigInt(ctx.target.y) << Q];
  const p: Vec[] = [root];
  for (let i = 0; i < n; i++) p.push(add(p[i] ?? root, start[i] ?? [0n, 0n]));
  const at = (i: number): Vec => p[i] ?? root;
  const len = (i: number): bigint => lengths[i] ?? 0n;
  const fb = (i: number): Vec => start[i] ?? [0n, 0n];
  const total = lengths.reduce((a, b) => a + b, 0n);
  if (norm2(sub(target, root)) > total * total) {
    // Out of reach: every bone points at the target (Aristidou and Lasenby 2011, Algorithm 1).
    for (let i = 0; i < n; i++) p[i + 1] = add(at(i), scaleTo(sub(target, at(i)), len(i), fb(i)));
    return { joints: p, lengths, iterations: 0, reachable: false };
  }
  let it = 0;
  while (it < iterations && norm2(sub(at(n), target)) > TOLERANCE2) {
    it++;
    const before = p.slice();
    // Forward reaching: the effector on the target, each joint back toward its old place.
    p[n] = target;
    for (let i = n - 1; i >= 0; i--) {
      p[i] = add(at(i + 1), scaleTo(sub(at(i), at(i + 1)), len(i), neg(fb(i))));
    }
    // Backward reaching: the root back on its pivot, each joint out toward its new place.
    p[0] = root;
    for (let i = 0; i < n; i++) {
      p[i + 1] = add(at(i), scaleTo(sub(at(i + 1), at(i)), len(i), fb(i)));
    }
    // A pass that moved no joint is a fixed point (a target inside the minimum reach, a bone of
    // length 0, ...): the next passes would only repeat it.
    if (p.every((v, k) => same(v, before[k] ?? root))) break;
  }
  return { joints: p, lengths, iterations: it, reachable: true };
}

/** @internal FABRIK's fixed-point joints for `chain` (validated as {@link solveFabrik} does). */
export function fabrikJoints(
  chain: IkChain,
  target: Readonly<Point>,
  iterations: number,
  angleQuantum: number,
): FabrikJoints {
  return fabrik(context(chain, target, { angleQuantum, iterations }, 1, IK_MAX_BONES), iterations);
}

/**
 * FABRIK, "Forward And Backward Reaching Inverse Kinematics" (A. Aristidou and J. Lasenby, "FABRIK: A
 * fast, iterative solver for the Inverse Kinematics problem", Graphical Models 73(5), 243–260, 2011),
 * in Q16 fixed point, baked to FK. Starts from the current pose (`chain.angles`); each iteration puts
 * the effector on the target and walks the joints back to the root keeping every bone length, then
 * puts the root back and walks out again. It stops within 1/16 px of the target or after
 * `opts.iterations` (default {@link IK_ITERATIONS_DEFAULT}). An unreachable target gets the chain
 * stretched straight toward it. Every bone length is kept to the nearest Q16 unit at every step.
 * 1 to {@link IK_MAX_BONES} bones. FABRIK does not choose a bend side: it follows the start pose, so a
 * straight start pose bends to whichever side the first pass falls to.
 *
 * Throws `RigError`: `BAD_VALUE` (bone count, coordinates, angles, `baseRotation`, `iterations`),
 * `BAD_QUANTUM`.
 */
export function solveFabrik(
  chain: IkChain,
  target: Readonly<Point>,
  opts: IkOptions = {},
): IkSolution {
  const ctx = context(chain, target, opts, 1, IK_MAX_BONES);
  const { joints, reachable } = fabrik(ctx, opts.iterations ?? IK_ITERATIONS_DEFAULT);
  const dirs = ctx.segs.map((s, i): Vec | undefined => {
    const a = joints[i];
    const b = joints[i + 1];
    return a === undefined || b === undefined || segLen2(s) === 0n ? undefined : sub(b, a);
  });
  // Out of reach the baked straight chain is the answer: a search for the nearest pixel would trade
  // straightness for rounding, since a far target barely penalises a sideways error.
  const { rel: baked, frozen } = bake(ctx, dirs);
  return finish(ctx, reachable ? refine(ctx, baked, frozen) : baked);
}

/**
 * Rig-level IK (FR-RIG-13, for FR-AI-17's end-effector targets): moves the pivot of `effector` onto
 * `target` by turning its `chainLength` nearest ancestors, and returns their new key angles (plain FK,
 * relative to rest, multiples of the quantum). The chain is read from the snapped pose: its root is the
 * top bone's snapped pivot, its base rotation the rotation of that bone's parent, its segments the rest
 * offsets of the chain's children in `view`. Offset keys of the children are constant translations and
 * are taken off the target first. The rest of the pose is the caller's to keep; apply the angles with
 * the pose's other channels unchanged and `snapSkeleton` puts the effector at `effector`.
 *
 * Throws `RigError`: `UNKNOWN_BONE`, `BAD_VALUE` (a chain longer than the effector's ancestors, a
 * `chainLength` outside `1..64`, `'two-bone'` with a chain other than 2, a bad target, a `bend` that
 * is not `'cw'`/`'ccw'` or is given without the two-bone solver), `BAD_QUANTUM`,
 * and everything `snapSkeleton` throws.
 */
export function solveIk(input: IkInput): IkPoseSolution {
  const n = input.chainLength ?? 2;
  if (!Number.isInteger(n) || n < 1 || n > IK_MAX_BONES) {
    throw new RigError(
      'BAD_VALUE',
      `chainLength must be an integer in 1..${String(IK_MAX_BONES)}, got ${String(n)}`,
    );
  }
  const solver: string = input.solver ?? (n === 2 ? 'two-bone' : 'fabrik');
  if (solver !== 'fabrik' && (solver !== 'two-bone' || n !== 2)) {
    throw new RigError(
      'BAD_VALUE',
      `solver ${JSON.stringify(solver)} cannot solve a chain of ${String(n)} bones`,
    );
  }
  if (input.bend !== undefined) {
    const given: string = input.bend;
    if (!BENDS.has(given)) {
      throw new RigError('BAD_VALUE', `bend must be 'cw' or 'ccw', got ${JSON.stringify(given)}`);
    }
    if (solver !== 'two-bone') {
      throw new RigError(
        'BAD_VALUE',
        `bend applies to the two-bone solver only, not ${JSON.stringify(solver)} on ${String(n)} bones`,
      );
    }
  }
  checkCoord(input.target.x, 'IK target x');
  checkCoord(input.target.y, 'IK target y');
  const q = input.angleQuantum ?? ANGLE_QUANTUM_DEFAULT;
  const sk = snapSkeleton(input.rig, input.view, input.pose ?? new Map(), { angleQuantum: q });
  const effector = sk.bones.get(input.effector);
  if (effector === undefined) {
    throw new RigError('UNKNOWN_BONE', `the effector "${input.effector}" is not in the rig`);
  }
  const chain = [];
  let b = effector;
  for (let k = 0; k < n; k++) {
    const parent = b.parentId === undefined ? undefined : sk.bones.get(b.parentId);
    if (parent === undefined) {
      throw new RigError(
        'BAD_VALUE',
        `"${input.effector}" has ${String(k)} ancestors, fewer than chainLength ${String(n)}`,
      );
    }
    chain.unshift(parent);
    b = parent;
  }
  const top = b;
  const base = top.parentId === undefined ? 0 : (sk.bones.get(top.parentId)?.rotation ?? 0);
  const children = [...chain.slice(1), effector];
  let ox = 0;
  let oy = 0;
  const segments = children.map((c) => {
    ox += c.key.offset.x;
    oy += c.key.offset.y;
    const rest = own(input.view.rest, c.id);
    return { x: rest?.x ?? 0, y: rest?.y ?? 0 };
  });
  const ikChain: IkChain = {
    root: top.pivot,
    segments,
    baseRotation: base,
    angles: chain.map((c) => c.key.angle),
  };
  const target = { x: input.target.x - ox, y: input.target.y - oy };
  const opts: IkOptions = {
    angleQuantum: q,
    ...(input.bend === undefined ? {} : { bend: input.bend }),
    ...(input.iterations === undefined ? {} : { iterations: input.iterations }),
  };
  const s =
    solver === 'two-bone'
      ? solveTwoBone(ikChain, target, opts)
      : solveFabrik(ikChain, target, opts);
  return {
    angles: new Map(chain.map((c, i) => [c.id, s.angles[i] ?? 0])),
    effector: { x: s.effector.x + ox, y: s.effector.y + oy },
    reached: s.reached,
  };
}
