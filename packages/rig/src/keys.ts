/**
 * Key resolution and interpolation (FR-RIG-11, FR-RIG-12; FR-RIG-20 step 1).
 * @packageDocumentation
 */
import { MAX_ROTATE_COORD } from '@pixel-forge/raster';
import {
  ANGLE_QUANTUM_DEFAULT,
  INTERPOLATIONS,
  INTERPOLATION_DEFAULT,
  type BoneId,
  type BoneKey,
  type FrameId,
  type FrameRef,
  type Interpolation,
  type LoopMode,
  type Point,
} from '@pixel-forge/schema';
import {
  type Dyadic,
  type Ratio,
  align,
  quantizeDyadic,
  quantizeRatio,
  quantumSteps,
  roundHalfAway,
  safeSteps,
  stepsToDeg,
  toDyadic,
} from './angle.js';
import { RigError } from './errors.js';
import { type BoneGraph, boneOrder } from './order.js';

/** A frame of an animation as key resolution reads it. A schema `Frame` (or a deep-readonly one) fits. */
export interface PoseFrame {
  readonly id: FrameId;
  readonly boneKeys: Readonly<Partial<Record<BoneId, Readonly<BoneKey>>>>;
}

/**
 * What key resolution reads from an animation. A schema `AuthoredAnimation` (or a deep-readonly one)
 * fits. A `MirrorAnimation` does not: evaluate its source, mirrors are derived in core (FR-RIG-16).
 */
export interface PoseAnimation {
  readonly frames: readonly PoseFrame[];
  readonly loop: LoopMode;
  /** Missing means `ANGLE_QUANTUM_DEFAULT` (1°). */
  readonly angleQuantum?: number;
}

/** Options of {@link resolvePose} and `evaluatePose`. */
export interface PoseOptions {
  /** Replaces the animation's `angleQuantum` (e.g. a preview at a coarser quantum). */
  readonly angleQuantum?: number;
}

/**
 * A bone's key values at one frame after interpolation and quantisation (FR-RIG-12). With no key on a
 * channel, the value is the rest value: angle 0, offset (0, 0), flipX false.
 */
export interface ResolvedBoneKey {
  /**
   * Rotation relative to the bone's rest angle, degrees clockwise: a multiple of the quantum, **not**
   * normalised (−30 stays −30), so negating every key negates every resolved angle exactly.
   */
  readonly angle: number;
  /** Integer translation of the pivot, canvas pixels. */
  readonly offset: Readonly<Point>;
  readonly flipX: boolean;
}

/** A resolved pose: one entry per bone of the rig, in {@link boneOrder}. */
export type ResolvedPose = ReadonlyMap<BoneId, ResolvedBoneKey>;

/**
 * Where a channel's value at one frame comes from: the key at frame index `from`, interpolated toward
 * the key at `to` by `i / n` (`i` frames from `from`, `n` frames from `from` to `to`). `n === 0` means
 * the value is exactly the key at `from` (the frame is keyed, or the value holds).
 */
export interface KeySpan {
  readonly from: number;
  readonly to: number;
  readonly i: number;
  readonly n: number;
}

/**
 * Locates frame `frame` among the frames `keyed` (strictly ascending indices in `0..frameCount-1`)
 * that key one channel. Interpolation is **by frame index**, not by time: durations are timing, keys
 * are spacing, so retiming a frame never moves a pose.
 *
 * - On a keyed frame: `{from: frame, to: frame, i: 0, n: 0}`.
 * - Between two keys: from the previous key to the next.
 * - Before the first or after the last key with `wrap` false: hold the nearest key (`n = 0`).
 * - With `wrap` true (a `loop` animation), the keys are cyclic: after the last key the span runs to
 *   the first key one loop later (`n = first + frameCount − last`), and before the first key it runs
 *   from the last key one loop earlier. A single key spans the whole loop onto itself, so it holds.
 *
 * Returns `undefined` when `keyed` is empty. Throws `RigError('BAD_VALUE')` for an invalid
 * `frameCount`, `frame` or `keyed`.
 */
export function keySpan(
  keyed: readonly number[],
  frame: number,
  frameCount: number,
  wrap: boolean,
): KeySpan | undefined {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new RigError(
      'BAD_VALUE',
      `frameCount must be a positive integer, got ${String(frameCount)}`,
    );
  }
  if (!Number.isInteger(frame) || frame < 0 || frame >= frameCount) {
    throw new RigError(
      'BAD_VALUE',
      `frame ${String(frame)} is not in 0..${String(frameCount - 1)}`,
    );
  }
  let prevKey = -1;
  for (const [j, k] of keyed.entries()) {
    const before = j === 0 ? -1 : (keyed[j - 1] ?? -1);
    if (!Number.isInteger(k) || k <= before || k >= frameCount) {
      throw new RigError('BAD_VALUE', 'keyed frames must be strictly ascending frame indices');
    }
    if (k <= frame) prevKey = j;
  }
  const first = keyed[0];
  const last = keyed.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const prev = keyed[prevKey];
  if (prev === frame) return { from: frame, to: frame, i: 0, n: 0 };
  if (prev === undefined) {
    return wrap
      ? { from: last, to: first, i: frame - last + frameCount, n: first - last + frameCount }
      : { from: first, to: first, i: 0, n: 0 };
  }
  const next = keyed[prevKey + 1];
  if (next === undefined) {
    return wrap
      ? { from: last, to: first, i: frame - last, n: first - last + frameCount }
      : { from: last, to: last, i: 0, n: 0 };
  }
  return { from: prev, to: next, i: frame - prev, n: next - prev };
}

const INTERP_SET: ReadonlySet<string> = new Set(INTERPOLATIONS);

/**
 * The interpolation weight `w(i / n)` as an exact ratio `[N, D]`: step `0`; linear `t`; ease-in-out the
 * cubic smoothstep `3t² − 2t³ = i²(3n − 2i) / n³` (zero slope at both keys, `w(1 − t) = 1 − w(t)`).
 *
 * `i` counts frames from the previous key and `n` from the previous to the next key, so `0 ≤ i ≤ n`
 * and `n ≥ 1` (a {@link KeySpan} with `n === 0` needs no weight: its value is the key itself). Throws
 * `RigError('BAD_VALUE')` for an unknown `interp`, a non-integer `i` or `n`, `n ≤ 0`, `i < 0` or `i > n`.
 */
export function interpWeight(
  interp: Interpolation,
  i: number,
  n: number,
): readonly [bigint, bigint] {
  if (!INTERP_SET.has(interp)) {
    throw new RigError('BAD_VALUE', `unknown interp ${JSON.stringify(interp)}`);
  }
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || n <= 0 || i < 0 || i > n) {
    throw new RigError(
      'BAD_VALUE',
      `interpolation position ${String(i)}/${String(n)} must satisfy 0 <= i <= n and n >= 1`,
    );
  }
  if (i === 0 || interp === 'step') return [0n, 1n];
  const bi = BigInt(i);
  const bn = BigInt(n);
  return interp === 'linear' ? [bi, bn] : [bi * bi * (3n * bn - 2n * bi), bn * bn * bn];
}

/** The weight of a span: exactly the `from` key when `n === 0`, else {@link interpWeight}. */
function spanWeight(interp: Interpolation, span: KeySpan): readonly [bigint, bigint] {
  return span.n === 0 ? [0n, 1n] : interpWeight(interp, span.i, span.n);
}

/** The exact `a + (b − a)·w` as a ratio (degrees). */
function lerpDyadic(a: Dyadic, b: Dyadic, [wn, wd]: readonly [bigint, bigint]): Ratio {
  const e = Math.max(a.e, b.e);
  const pa = align(a, e);
  const pb = align(b, e);
  return { p: pa * wd + (pb - pa) * wn, d: wd << BigInt(e) };
}

/** `a + (b − a)·w` for integers, rounded half away from zero. */
function lerpInt(a: number, b: number, [wn, wd]: readonly [bigint, bigint]): number {
  const pa = BigInt(a);
  return Number(roundHalfAway(pa * wd + (BigInt(b) - pa) * wn, wd)) + 0;
}

/** Checks an integer pixel coordinate (`|v| ≤ 2^31`, raster's `MAX_ROTATE_COORD`). */
export function checkCoord(v: number, what: string): void {
  if (!Number.isInteger(v) || Math.abs(v) > MAX_ROTATE_COORD) {
    throw new RigError(
      'BAD_VALUE',
      `${what} must be an integer with magnitude at most 2^31, got ${String(v)}`,
    );
  }
}

/**
 * Checks one key: a finite angle whose quantisation at `qSteps` is a safe integer (so every
 * interpolation between valid keys is too: quantisation is monotone), integer offsets in range, and a
 * known interp.
 */
function checkKey(key: Readonly<BoneKey>, where: string, qSteps: number): void {
  if (key.angle !== undefined) {
    safeSteps(quantizeDyadic(toDyadic(key.angle, `${where} angle`), qSteps), `${where} angle`);
  }
  if (key.offset !== undefined) {
    checkCoord(key.offset.x, `${where} offset.x`);
    checkCoord(key.offset.y, `${where} offset.y`);
  }
  if (key.interp !== undefined && !INTERP_SET.has(key.interp)) {
    throw new RigError('BAD_VALUE', `${where} has unknown interp "${key.interp}"`);
  }
}

/** Index of `frame` in `animation.frames`; `RigError('UNKNOWN_FRAME')` when absent. */
export function frameIndex(animation: PoseAnimation, frame: FrameRef): number {
  if (typeof frame === 'number') {
    if (Number.isInteger(frame) && frame >= 0 && frame < animation.frames.length) return frame;
    throw new RigError('UNKNOWN_FRAME', `frame index ${String(frame)} is out of range`);
  }
  const index = animation.frames.findIndex((f) => f.id === frame);
  if (index < 0) throw new RigError('UNKNOWN_FRAME', `frame "${frame}" is not in the animation`);
  return index;
}

/** Own-property lookup in a record (never reads `Object.prototype`). */
export function own<V>(rec: Readonly<Partial<Record<string, V>>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Per bone, the indices of the frames that key each channel. */
interface ChannelFrames {
  readonly angle: number[];
  readonly offset: number[];
  readonly flipX: number[];
}

const PREPARED = new WeakSet<object>();

/**
 * An animation whose keys have been validated and indexed once for a rig and a quantum
 * ({@link prepareAnimation}). Pass it to {@link resolvePose} or `evaluatePose` in place of the
 * animation to evaluate many frames without repeating the validation, the per-channel key index or the
 * {@link boneOrder} computation. It is a snapshot: edit the animation, prepare again.
 */
export interface PreparedAnimation {
  /** The animation that was prepared. */
  readonly animation: PoseAnimation;
  /** The rig it was prepared for. */
  readonly rig: BoneGraph;
  /** The rig's bones in {@link boneOrder}. */
  readonly order: readonly BoneId[];
  /** The quantum the keys were validated and will be quantised at, degrees. */
  readonly angleQuantum: number;
  /** @internal The quantum in table steps. */
  readonly qSteps: number;
  /** @internal Per bone, the frames that key each channel. */
  readonly channels: ReadonlyMap<BoneId, ChannelFrames>;
}

/**
 * Validates every key of `animation` up front and indexes the keyed frames of every channel, once.
 * Errors therefore never depend on which frame is evaluated later. Checked: `UNKNOWN_BONE` (a key for
 * a bone not in the rig), `BAD_VALUE` (non-finite angle, a quantised angle of 2^51° or more,
 * non-integer or out-of-range offset, unknown interp), `BAD_QUANTUM`, and the {@link boneOrder} errors.
 * The quantum is `opts.angleQuantum ?? animation.angleQuantum ?? 1`.
 */
export function prepareAnimation(
  rig: BoneGraph,
  animation: PoseAnimation,
  opts: PoseOptions = {},
): PreparedAnimation {
  const order = boneOrder(rig);
  const angleQuantum = opts.angleQuantum ?? animation.angleQuantum ?? ANGLE_QUANTUM_DEFAULT;
  const qSteps = quantumSteps(angleQuantum);
  const channels = new Map<BoneId, ChannelFrames>(
    order.map((id) => [id, { angle: [], offset: [], flipX: [] }]),
  );
  for (const [f, fr] of animation.frames.entries()) {
    for (const id of Object.keys(fr.boneKeys)) {
      const key = own(fr.boneKeys, id);
      if (key === undefined) continue;
      const ch = channels.get(id as BoneId);
      if (ch === undefined) {
        throw new RigError('UNKNOWN_BONE', `frame "${fr.id}" keys unknown bone "${id}"`);
      }
      checkKey(key, `key of bone "${id}" in frame "${fr.id}"`, qSteps);
      if (key.angle !== undefined) ch.angle.push(f);
      if (key.offset !== undefined) ch.offset.push(f);
      if (key.flipX !== undefined) ch.flipX.push(f);
    }
  }
  const prepared: PreparedAnimation = { animation, rig, order, angleQuantum, qSteps, channels };
  PREPARED.add(prepared);
  return prepared;
}

/**
 * `animation` as a {@link PreparedAnimation} for `rig` at the quantum `opts.angleQuantum ??
 * animation.angleQuantum ?? 1`: a prepared animation is reused when it matches the rig and quantum
 * (by identity), otherwise it is prepared again; a plain animation is prepared.
 * @internal
 */
export function ensurePrepared(
  rig: BoneGraph,
  animation: PoseAnimation | PreparedAnimation,
  opts: PoseOptions,
): PreparedAnimation {
  if (PREPARED.has(animation)) {
    const p = animation as PreparedAnimation;
    if (
      p.rig === rig &&
      (opts.angleQuantum === undefined || opts.angleQuantum === p.angleQuantum)
    ) {
      return p;
    }
    return prepareAnimation(
      rig,
      p.animation,
      opts.angleQuantum === undefined ? { angleQuantum: p.angleQuantum } : opts,
    );
  }
  return prepareAnimation(rig, animation as PoseAnimation, opts);
}

/**
 * Step 1 of FR-RIG-20: every bone's key values at `frame`, interpolated and quantised (FR-RIG-12).
 *
 * - Keys are sparse (`Frame.boneKeys`). Each channel (`angle`, `offset`, `flipX`) is resolved on its
 *   own over the frames that key it ({@link keySpan}): by frame index; holding the nearest key before
 *   the first and after the last key, except in a `loop` animation, which wraps from the last key to
 *   the first across the loop boundary (`once` and `pingpong` hold).
 * - Between two keys the **previous** key's `interp` applies (missing means `linear`): `step` holds,
 *   `linear` is `t`, `ease-in-out` is the cubic smoothstep `3t² − 2t³`. `flipX` always steps.
 * - Arithmetic is exact: angles are taken at their exact binary value, interpolated as BigInt
 *   rationals, and rounded **once**, half away from zero, to a multiple of the quantum
 *   (`opts.angleQuantum ?? animation.angleQuantum ?? 1`). Offsets are interpolated the same way and
 *   rounded half away from zero to integers.
 * - A channel no frame keys takes its rest value (angle 0, offset (0, 0), flipX false).
 *
 * Every key of the animation is checked ({@link prepareAnimation}), not only the ones used, so the
 * outcome never depends on the frame; `UNKNOWN_FRAME` is thrown for a frame the animation lacks. Pass
 * a {@link PreparedAnimation} to evaluate many frames with one validation.
 */
export function resolvePose(
  rig: BoneGraph,
  animation: PoseAnimation | PreparedAnimation,
  frame: FrameRef,
  opts: PoseOptions = {},
): ResolvedPose {
  return resolvePrepared(ensurePrepared(rig, animation, opts), frame);
}

/** {@link resolvePose} of an already prepared animation (no validation beyond the frame). @internal */
export function resolvePrepared(prepared: PreparedAnimation, frame: FrameRef): ResolvedPose {
  const { animation, order, channels, qSteps } = prepared;
  const index = frameIndex(animation, frame);
  const frames = animation.frames;
  const wrap = animation.loop === 'loop';
  const keyAt = (f: number, id: BoneId): Readonly<BoneKey> => {
    const key = own(frames[f]?.boneKeys ?? {}, id);
    /* v8 ignore next */
    if (key === undefined) throw new Error('unreachable: keyed frame without a key');
    return key;
  };
  const pose = new Map<BoneId, ResolvedBoneKey>();
  for (const id of order) {
    const ch = channels.get(id);
    /* v8 ignore next */
    if (ch === undefined) throw new Error('unreachable: bone without channels');
    let angle = 0;
    let offset: Readonly<Point> = { x: 0, y: 0 };
    let flipX = false;
    const aSpan = keySpan(ch.angle, index, frames.length, wrap);
    if (aSpan) {
      const from = keyAt(aSpan.from, id);
      const w = spanWeight(from.interp ?? INTERPOLATION_DEFAULT, aSpan);
      const a = toDyadic(from.angle ?? 0, 'angle');
      const b = toDyadic(keyAt(aSpan.to, id).angle ?? 0, 'angle');
      angle = stepsToDeg(
        safeSteps(quantizeRatio(lerpDyadic(a, b, w), qSteps), `angle of bone "${id}"`),
      );
    }
    const oSpan = keySpan(ch.offset, index, frames.length, wrap);
    if (oSpan) {
      const from = keyAt(oSpan.from, id);
      const w = spanWeight(from.interp ?? INTERPOLATION_DEFAULT, oSpan);
      const a = from.offset ?? { x: 0, y: 0 };
      const b = keyAt(oSpan.to, id).offset ?? { x: 0, y: 0 };
      offset = { x: lerpInt(a.x, b.x, w), y: lerpInt(a.y, b.y, w) };
    }
    const fSpan = keySpan(ch.flipX, index, frames.length, wrap);
    if (fSpan) flipX = keyAt(fSpan.from, id).flipX ?? false;
    pose.set(id, { angle, offset, flipX });
  }
  return pose;
}
