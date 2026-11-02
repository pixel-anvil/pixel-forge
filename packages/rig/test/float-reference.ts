/**
 * An independent reference implementation of the whole pose chain (key resolution, interpolation,
 * quantisation, hierarchical snapping), written from the README formulas and sharing no code with
 * `src/`. Used as oracle (a), as the source of the arm-swing golden table and of the independent
 * rotations that oracle (c) and the "wrong method" test need.
 *
 * Exactness, so that ties are compared and not skipped:
 *
 * - **Offsets** are integers: `a + (b − a)·w` is a ratio of small integers (`w = num/den`, linear
 *   `i/n`, smoothstep `i²(3n − 2i)/n³`), rounded half away from zero with integer arithmetic.
 * - **Angles and rest sums** whose operands are multiples of 1/8° (every exact tie `(k + ½)·q` of the
 *   tested quanta is one) are scaled to integer eighths and handled the same way, exactly.
 * - **Rotations** (`x·cos − y·sin`, `x·sin + y·cos`) are exact where the trig values are: multiples of
 *   90° (0, ±1) and of 30° (sin or cos is ±½; the other is irrational and only appears multiplied by
 *   a coordinate that must be 0 for the result to be exact). Float64 `Math.sin(30°)` is
 *   0.49999999999999994, so exactness here comes from the known values, not from `Math.sin`.
 *
 * What is left is genuinely float-ambiguous: an angle with a non-1/8 operand within 1e-9 of k + ½
 * quanta, or a rotated coordinate within the Q16 table error `(|dx| + |dy|) / 131072` of k + ½
 * (ADR-010: the only place `rotatePoint` may differ from float64). At such a quantity the reference
 * accepts either neighbouring rounding, checks that the implementation picked one of the two, and
 * carries on **from the implementation's choice**, so descendants of an ambiguous bone are still
 * compared exactly (nothing is skipped through the chain). It is counted in {@link RefStats}.
 */
import type { BoneId, BoneKey, LoopMode, RestTransform } from '@pixel-forge/schema';
import type { PoseAnimation, SnappedSkeleton } from '../src/index.js';

/** A rig, rest pose and animation, as the reference reads them (a `RandomCase` fits). */
export interface RefCase {
  readonly rig: { readonly bones: readonly { readonly id: BoneId; readonly parentId?: BoneId }[] };
  readonly view: { readonly rest: Readonly<Partial<Record<BoneId, RestTransform>>> };
  readonly anim: PoseAnimation;
}

/** What the reference saw while running: exact ties it compared and ambiguities it had to accept. */
export interface RefStats {
  bones: number;
  /** Exact .5 ties, compared exactly against the implementation. */
  exactTies: { angle: number; offset: number; rest: number; rotation: number };
  /** Float-ambiguous quantities: either neighbouring rounding is accepted. */
  ambiguous: { angle: number; rest: number; rotation: number };
  /** Ambiguous quantities where the implementation chose the other rounding than float64 would. */
  ambiguousDiffering: number;
}

export const newStats = (): RefStats => ({
  bones: 0,
  exactTies: { angle: 0, offset: 0, rest: 0, rotation: 0 },
  ambiguous: { angle: 0, rest: 0, rotation: 0 },
  ambiguousDiffering: 0,
});

export interface RefBone {
  pivot: [number, number];
  angle: number;
  offset: [number, number];
  flipX: boolean;
  /** Degrees, not normalised: the sum of the key angles of the bone and its ancestors. */
  rotation: number;
  /** Degrees, not normalised. */
  restAngle: number;
  restSumFloat: number;
  /** The rest sum in integer eighths of a degree, or undefined once an operand was not a multiple of 1/8. */
  restEighths: number | undefined;
}

export const mod360 = (a: number): number => ((a % 360) + 360) % 360;

/** Half away from zero for a float. */
export const roundAway = (v: number): number =>
  (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)) + 0;

/** `p / d` (integers, `d > 0`) rounded half away from zero, with integer arithmetic only. */
function divRoundAway(p: number, d: number): number {
  const n = 2 * Math.abs(p) + d;
  const r = (n - (n % (2 * d))) / (2 * d);
  return (p < 0 ? -r : r) + 0;
}

/** `p / d` is exactly k + ½. */
const isHalf = (p: number, d: number): boolean => (2 * Math.abs(p) + d) % (2 * d) === 0;

const nearHalf = (v: number, tol: number): boolean =>
  Math.abs(Math.abs(v - Math.trunc(v)) - 0.5) <= tol;

const isEighth = (v: number): boolean => Number.isInteger(v * 8);

/** Previous and next keyed frame of a channel, by its own search. */
function neighbours(
  keyed: (f: number) => boolean,
  f: number,
  count: number,
  loop: LoopMode,
): { prev: number; next: number; dPrev: number; dNext: number } | undefined {
  if (keyed(f)) return { prev: f, next: f, dPrev: 0, dNext: 0 };
  if (loop === 'loop') {
    let dPrev = 1;
    while (dPrev <= count && !keyed((f - dPrev + count * 2) % count)) dPrev++;
    if (dPrev > count) return undefined;
    let dNext = 1;
    while (!keyed((f + dNext) % count)) dNext++;
    return { prev: (f - dPrev + count * 2) % count, next: (f + dNext) % count, dPrev, dNext };
  }
  let prev = f - 1;
  while (prev >= 0 && !keyed(prev)) prev--;
  let next = f + 1;
  while (next < count && !keyed(next)) next++;
  if (prev < 0 && next >= count) return undefined;
  if (prev < 0) return { prev: next, next, dPrev: 0, dNext: 0 };
  if (next >= count) return { prev, next: prev, dPrev: 0, dNext: 0 };
  return { prev, next, dPrev: f - prev, dNext: next - f };
}

/** The weight as a ratio of small integers: step 0, linear i/n, smoothstep i²(3n − 2i)/n³. */
function weight(interp: BoneKey['interp'], dPrev: number, span: number): [number, number] {
  if (span === 0 || interp === 'step') return [0, 1];
  if (interp === 'ease-in-out') return [dPrev * dPrev * (3 * span - 2 * dPrev), span ** 3];
  return [dPrev, span];
}

/** `cos` and `sin` of `r` degrees where they are exactly known (null: irrational). */
function knownTrig(r: number): { c: number | null; s: number | null } {
  if (r % 90 === 0) {
    const k = r / 90;
    return { c: [1, 0, -1, 0][k] ?? 0, s: [0, 1, 0, -1][k] ?? 0 };
  }
  switch (r) {
    case 30:
    case 150:
      return { c: null, s: 0.5 };
    case 210:
    case 330:
      return { c: null, s: -0.5 };
    case 60:
    case 300:
      return { c: 0.5, s: null };
    case 120:
    case 240:
      return { c: -0.5, s: null };
    default:
      return { c: null, s: null };
  }
}

/** The rotated offset of `(x, y)` by `rotation` degrees: each coordinate exact, or a float. */
function rotated(
  x: number,
  y: number,
  rotation: number,
): [{ v: number; exact: boolean }, { v: number; exact: boolean }] {
  const { c, s } = knownTrig(mod360(rotation));
  const exactX = (c !== null || x === 0) && (s !== null || y === 0);
  const exactY = (s !== null || x === 0) && (c !== null || y === 0);
  const th = (rotation * Math.PI) / 180;
  const cc = c ?? Math.cos(th);
  const ss = s ?? Math.sin(th);
  const fx = (c === null ? 0 : x * cc) - (s === null ? 0 : y * ss);
  const fy = (s === null ? 0 : x * ss) + (c === null ? 0 : y * cc);
  return [
    { v: exactX ? fx : x * cc - y * ss, exact: exactX },
    { v: exactY ? fy : x * ss + y * cc, exact: exactY },
  ];
}

/**
 * The reference pose of every bone of `c` at frame `f`. `impl` is the implementation's skeleton of the
 * same frame; it is consulted only at float-ambiguous quantities (see the module comment), where the
 * reference verifies the implementation's value is one of the two legal roundings and adopts it.
 */
export function reference(
  c: RefCase,
  f: number,
  impl: SnappedSkeleton,
  stats: RefStats = newStats(),
): Map<BoneId, RefBone> {
  const { rig, view, anim } = c;
  const q = anim.angleQuantum ?? 1;
  const q8 = q * 8; // an integer: q is a multiple of 0.25
  const count = anim.frames.length;
  const keyOf = (fr: number, id: BoneId): BoneKey | undefined => anim.frames[fr]?.boneKeys[id];
  const channel = <T>(id: BoneId, get: (k: BoneKey) => T | undefined) => {
    const nb = neighbours(
      (fr) => {
        const k = keyOf(fr, id);
        return k !== undefined && get(k) !== undefined;
      },
      f,
      count,
      anim.loop,
    );
    if (!nb) return undefined;
    const from = keyOf(nb.prev, id);
    const to = keyOf(nb.next, id);
    if (!from || !to) throw new Error('keyed frame without a key');
    const [num, den] = weight(from.interp, nb.dPrev, nb.dPrev + nb.dNext);
    return { a: get(from) as T, b: get(to) as T, num, den };
  };
  const depth = (id: BoneId): number => {
    let d = 0;
    for (
      let p = rig.bones.find((b) => b.id === id)?.parentId;
      p;
      p = rig.bones.find((b) => b.id === p)?.parentId
    )
      d++;
    return d;
  };
  const bones = [...rig.bones].sort((x, y) => depth(x.id) - depth(y.id));
  const out = new Map<BoneId, RefBone>();
  for (const b of bones) {
    const got = impl.bones.get(b.id);
    if (!got) throw new Error('missing bone');
    stats.bones++;
    const parent = b.parentId === undefined ? undefined : out.get(b.parentId);
    const rest = view.rest[b.id] ?? { x: 0, y: 0, angle: 0 };

    // Key angle.
    let angle = 0;
    const ac = channel(b.id, (k) => k.angle);
    if (ac) {
      // With weight 0 (a hold, a step, a keyed frame) the value is `a`, whatever `b` is.
      const bv = ac.num === 0 ? ac.a : ac.b;
      if (isEighth(ac.a) && isEighth(bv)) {
        const p = ac.a * 8 * ac.den + (bv * 8 - ac.a * 8) * ac.num;
        const d = ac.den * q8;
        if (isHalf(p, d)) stats.exactTies.angle++;
        angle = divRoundAway(p, d) * q;
      } else {
        const u = (ac.a + (bv - ac.a) * (ac.num / ac.den)) / q;
        angle = roundAway(u) * q;
        if (nearHalf(u, 1e-9 * Math.max(1, Math.abs(u)))) {
          stats.ambiguous.angle++;
          if (got.key.angle !== Math.floor(u) * q && got.key.angle !== Math.ceil(u) * q) {
            throw new Error(
              `bone ${JSON.stringify(b.id)}: angle ${String(got.key.angle)} is not a legal rounding`,
            );
          }
          if (got.key.angle !== angle) stats.ambiguousDiffering++;
          angle = got.key.angle;
        }
      }
    }

    // Key offset: exact integer arithmetic.
    const offset: [number, number] = [0, 0];
    const oc = channel(b.id, (k) => k.offset);
    if (oc) {
      for (const [i, axis] of (['x', 'y'] as const).entries()) {
        const a = oc.a[axis];
        const p = a * oc.den + (oc.b[axis] - a) * oc.num;
        if (isHalf(p, oc.den)) stats.exactTies.offset++;
        offset[i] = divRoundAway(p, oc.den);
      }
    }
    const fc = channel(b.id, (k) => k.flipX);
    const flipX = fc ? fc.a : false;

    // Rest world angle: the exact sum of the chain, rounded once.
    const restSumFloat = (parent?.restSumFloat ?? 0) + rest.angle;
    const parentEighths = parent === undefined ? 0 : parent.restEighths;
    const restEighths =
      parentEighths !== undefined && isEighth(rest.angle)
        ? parentEighths + rest.angle * 8
        : undefined;
    let restAngle: number;
    if (restEighths !== undefined) {
      if (isHalf(restEighths, q8)) stats.exactTies.rest++;
      restAngle = divRoundAway(restEighths, q8) * q;
    } else {
      const u = restSumFloat / q;
      restAngle = roundAway(u) * q;
      if (nearHalf(u, 1e-9 * Math.max(1, Math.abs(u)))) {
        stats.ambiguous.rest++;
        const legal = [Math.floor(u) * q, Math.ceil(u) * q];
        if (!legal.some((l) => mod360(l) === got.restAngle)) {
          throw new Error(
            `bone ${JSON.stringify(b.id)}: restAngle ${String(got.restAngle)} is not legal`,
          );
        }
        if (mod360(restAngle) !== got.restAngle) stats.ambiguousDiffering++;
        restAngle = legal.find((l) => mod360(l) === got.restAngle) ?? restAngle;
      }
    }

    // Pivot: the only rounding of a child is the rotation of its rest offset, added to the parent's pivot.
    const rotation = (parent?.rotation ?? 0) + angle;
    let pivot: [number, number];
    if (!parent) {
      pivot = [rest.x + offset[0], rest.y + offset[1]];
    } else {
      const [ex, ey] = rotated(rest.x, rest.y, parent.rotation);
      const tol = (Math.abs(rest.x) + Math.abs(rest.y)) / 131072 + 1e-9;
      const r: [number, number] = [0, 0];
      for (const [i, e] of [ex, ey].entries()) {
        r[i] = roundAway(e.v);
        if (e.exact) {
          if (Math.abs(e.v % 1) === 0.5) stats.exactTies.rotation++;
        } else if (nearHalf(e.v, tol)) {
          stats.ambiguous.rotation++;
          const actual =
            (i === 0 ? got.pivot.x : got.pivot.y) - (parent.pivot[i] ?? 0) - (offset[i] ?? 0);
          if (actual !== Math.floor(e.v) && actual !== Math.ceil(e.v)) {
            throw new Error(
              `bone ${JSON.stringify(b.id)}: rotated offset ${String(actual)} is not legal`,
            );
          }
          if (actual !== r[i]) stats.ambiguousDiffering++;
          r[i] = actual;
        }
      }
      pivot = [parent.pivot[0] + r[0] + offset[0], parent.pivot[1] + r[1] + offset[1]];
    }
    out.set(b.id, {
      pivot,
      angle,
      offset,
      flipX,
      rotation,
      restAngle,
      restSumFloat,
      restEighths,
    });
  }
  return out;
}

/** What `evaluatePose` should return for every bone, per the reference (normalised angles). */
export function expectedBone(r: RefBone): {
  pivot: { x: number; y: number };
  key: { angle: number; offset: { x: number; y: number }; flipX: boolean };
  rotation: number;
  restAngle: number;
  worldAngle: number;
  flipX: boolean;
} {
  return {
    pivot: { x: r.pivot[0], y: r.pivot[1] },
    key: { angle: r.angle, offset: { x: r.offset[0], y: r.offset[1] }, flipX: r.flipX },
    rotation: mod360(r.rotation),
    restAngle: mod360(r.restAngle),
    worldAngle: mod360(r.restAngle + r.rotation),
    flipX: r.flipX,
  };
}
