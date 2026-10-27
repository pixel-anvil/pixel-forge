/**
 * Exact angle arithmetic (NFR-02). Every finite double is a dyadic rational `m / 2^e`, so key and rest
 * angles are converted to BigInt rationals without loss, interpolated exactly, and rounded once, half
 * away from zero, to a multiple of the angle quantum. Nothing here uses floating-point accumulation or
 * `Math` trig; results are integers counted in table steps of 0.25° (raster's `ANGLE_STEP_DEG`).
 * @packageDocumentation
 */
import { ANGLE_STEPS, ANGLE_STEP_DEG } from '@pixel-forge/raster';
import { angleQuantumSteps } from '@pixel-forge/schema';
import { RigError } from './errors.js';

/** Table steps per degree (4: one step is 0.25°). */
const STEPS_PER_DEG = 1 / ANGLE_STEP_DEG;

/** An exact dyadic rational `m / 2^e` with `e ≥ 0`. */
export interface Dyadic {
  readonly m: bigint;
  readonly e: number;
}

/** The exact rational `p / d` with `d > 0`. */
export interface Ratio {
  readonly p: bigint;
  readonly d: bigint;
}

/** Zero as a dyadic. */
export const ZERO: Dyadic = { m: 0n, e: 0 };

/**
 * The exact value of the finite double `x` as `m / 2^e`. Doubling a double is exact, and a non-integer
 * double has magnitude below 2^52, so the loop ends (after at most 1074 steps) with an exact integer.
 * Throws `RigError('BAD_VALUE')` for NaN or ±Infinity.
 */
export function toDyadic(x: number, what: string): Dyadic {
  if (!Number.isFinite(x))
    throw new RigError('BAD_VALUE', `${what} must be finite, got ${String(x)}`);
  let y = x;
  let e = 0;
  while (!Number.isInteger(y)) {
    y *= 2;
    e++;
  }
  return { m: BigInt(y), e };
}

/** `a`'s numerator over `2^e` (`e ≥ a.e`). */
export function align(a: Dyadic, e: number): bigint {
  return a.m << BigInt(e - a.e);
}

/** The exact sum `a + b`. */
export function addDyadic(a: Dyadic, b: Dyadic): Dyadic {
  const e = Math.max(a.e, b.e);
  return { m: align(a, e) + align(b, e), e };
}

/**
 * `p / d` rounded to the nearest integer, **half away from zero** (`d > 0`). BigInt division truncates
 * toward zero, which is a floor for the non-negative operands used here.
 */
export function roundHalfAway(p: bigint, d: bigint): bigint {
  return p >= 0n ? (2n * p + d) / (2n * d) : -((-2n * p + d) / (2n * d));
}

/**
 * The angle quantum in table steps (`4q`), checked with the schema's own rule
 * (`angleQuantumSteps`, the one that `AngleQuantum` validates documents with). Throws
 * `RigError('BAD_QUANTUM')` for anything but a multiple of 0.25 in `(0, 90]` that divides 360.
 */
export function quantumSteps(q: number): number {
  const steps = angleQuantumSteps(q);
  if (steps === undefined) {
    throw new RigError(
      'BAD_QUANTUM',
      `angleQuantum must be a multiple of 0.25 in (0, 90] that divides 360, got ${String(q)}`,
    );
  }
  return steps;
}

/**
 * Rounds the exact angle `r` (degrees) half away from zero to a multiple of the quantum `qSteps`
 * (in table steps) and returns it in table steps: `round(r / q) · 4q`.
 */
export function quantizeRatio(r: Ratio, qSteps: number): bigint {
  const n = BigInt(qSteps);
  return roundHalfAway(BigInt(STEPS_PER_DEG) * r.p, r.d * n) * n;
}

/** {@link quantizeRatio} of a dyadic. */
export function quantizeDyadic(a: Dyadic, qSteps: number): bigint {
  return quantizeRatio({ p: a.m, d: 1n << BigInt(a.e) }, qSteps);
}

/** A step count as a safe-integer `number`; `RigError('BAD_VALUE')` when it is not one. */
export function safeSteps(steps: bigint, what: string): number {
  const n = Number(steps);
  if (!Number.isSafeInteger(n)) {
    throw new RigError('BAD_VALUE', `${what} is too large: |angle| must stay below 2^51 degrees`);
  }
  return n + 0;
}

/** `steps` reduced into `0..1439` (one full turn). */
export function wrapSteps(steps: bigint): number {
  const turn = BigInt(ANGLE_STEPS);
  const r = steps % turn;
  return Number(r < 0n ? r + turn : r);
}

/** Table steps to degrees (exact: a division by 4). */
export function stepsToDeg(steps: number): number {
  return steps / STEPS_PER_DEG + 0;
}

/**
 * Rounds `deg` half away from zero to the nearest multiple of `quantum` (default 1°), exactly: the
 * double `deg` is taken at its exact binary value, so `quantizeAngle(0.5, 1)` is 1 and
 * `quantizeAngle(-0.5, 1)` is -1, and `quantizeAngle(-x, q) === -quantizeAngle(x, q)` always holds.
 * The result is not normalised (`quantizeAngle(-30.4, 1)` is -30). `quantum` must be a valid
 * `angleQuantum` (`RigError('BAD_QUANTUM')`); `deg` must be finite with `|deg| < 2^51`
 * (`RigError('BAD_VALUE')`).
 */
export function quantizeAngle(deg: number, quantum = 1): number {
  const qSteps = quantumSteps(quantum);
  return stepsToDeg(safeSteps(quantizeDyadic(toDyadic(deg, 'angle'), qSteps), 'angle'));
}

/**
 * `deg` reduced into `[0, 360)`. Exact: the remainder of two doubles is exact, and for multiples of
 * 0.25° (every quantised angle) the correction is exact too. Never returns `-0`. `deg` must be finite
 * (`RigError('BAD_VALUE')`).
 */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg))
    throw new RigError('BAD_VALUE', `angle must be finite, got ${String(deg)}`);
  let r = deg % 360;
  if (r < 0) r += 360;
  if (r >= 360) r -= 360; // a tiny negative remainder can round up to 360
  return r + 0;
}
