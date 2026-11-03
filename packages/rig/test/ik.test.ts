/**
 * E1.1 IK (FR-RIG-13): the analytic two-bone solver and FABRIK, baked to FK key angles.
 *
 * Oracles: properties checked through `snapSkeleton` (the real FK, not the solver's own model):
 * a reachable target is reached within 1 px, an unreachable one stretches the chain toward it, bone
 * lengths never change; the bend side of the two-bone solver; plus the determinism suite (a committed
 * SHA-256 of a case table, and runs with `Math` trig, `Math.sqrt`, `Math.random` and `Date.now` stubbed
 * to throw).
 */
import { createHash } from 'node:crypto';
import { cosQ16, rotatePointQ16, sinQ16 } from '@pixel-forge/raster';
import type { BoneId, Point } from '@pixel-forge/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IK_ITERATIONS_DEFAULT,
  humanoidSide,
  snapSkeleton,
  solveFabrik,
  solveIk,
  solveTwoBone,
  type IkBend,
  type IkChain,
  type IkSolution,
  type PoseKey,
} from '../src/index.js';
import { directionStep, fabrikJoints, isqrt } from '../src/ik.js';
import { bone, errorCode, makeRig, makeView, prng } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type V = readonly [number, number];

/** A rig of one chain: bone `j0` (root, pivot `chain.root`) -> `j1` -> ... -> `jn` (the effector). */
function chainRig(chain: IkChain) {
  const ids = Array.from({ length: chain.segments.length + 1 }, (_, i) => bone(`j${String(i)}`));
  const rig = makeRig(ids.map((id, i) => (i === 0 ? [id] : [id, ids[i - 1]])));
  const view = makeView(
    ids.map((id, i) => {
      if (i === 0) return [id, chain.root.x, chain.root.y, 0];
      const s = chain.segments[i - 1];
      if (!s) throw new Error('segment');
      return [id, s.x, s.y, 0];
    }),
  );
  return { ids, rig, view };
}

/** The real FK (`snapSkeleton`) of a solution: every joint pivot, root first. */
function pivots(chain: IkChain, angles: readonly number[], q: number): V[] {
  const { ids, rig, view } = chainRig(chain);
  const pose = new Map<BoneId, PoseKey>();
  angles.forEach((a, i) => {
    const id = ids[i];
    if (id) pose.set(id, { angle: a });
  });
  const sk = snapSkeleton(rig, view, pose, { angleQuantum: q });
  return ids.map((id) => {
    const b = sk.bones.get(id);
    if (!b) throw new Error('bone');
    return [b.pivot.x, b.pivot.y];
  });
}

/** `xs[i]`, which must exist. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${String(i)}`);
  return x;
}

const last = (ps: readonly V[]): V => {
  const p = ps[ps.length - 1];
  if (!p) throw new Error('empty');
  return p;
};
const cheb = (a: V, b: Point): number => Math.max(Math.abs(a[0] - b.x), Math.abs(a[1] - b.y));
const dist = (a: V, b: V): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lengthOf = (s: Point): number => Math.hypot(s.x, s.y);

/** A random integer vector of length in [min, max] (integer maths: the trig-free run uses it too). */
function randomSegment(rand: () => number, min: number, max: number): Point {
  for (;;) {
    const x = Math.floor(rand() * (2 * max + 1)) - max;
    const y = Math.floor(rand() * (2 * max + 1)) - max;
    const l2 = x * x + y * y;
    if (l2 >= min * min && l2 <= max * max) return { x, y };
  }
}

function randomChain(rand: () => number, n: number, min = 3, max = 40): IkChain {
  const segments = Array.from({ length: n }, () => randomSegment(rand, min, max));
  return { root: { x: Math.floor(rand() * 64), y: Math.floor(rand() * 64) }, segments };
}

/** A random multiple of `q` in [-180, 180). */
const randomAngle = (rand: () => number, q: number): number =>
  Math.floor(rand() * (360 / q)) * q - 180;

/** Checks the invariants every solution has, whatever the target. */
function checkSolution(chain: IkChain, s: IkSolution, q: number): V[] {
  expect(s.angles).toHaveLength(chain.segments.length);
  s.angles.forEach((a, i) => {
    // Multiples of the quantum, and within 180° of the current key (0 when none).
    expect(Number.isInteger(a / q)).toBe(true);
    const cur = chain.angles?.[i] ?? 0;
    expect(a).toBeGreaterThan(cur - 180);
    expect(a).toBeLessThanOrEqual(cur + 180);
  });
  const ps = pivots(chain, s.angles, q);
  // The solver reports the effector the real FK puts there.
  expect([s.effector.x, s.effector.y]).toEqual(last(ps));
  // Bone lengths never change: FK only rotates the rest offsets, so a joint moves off its true
  // length by the pivot rounding alone (at most half a pixel per axis, plus the Q16 table error).
  chain.segments.forEach((seg, i) => {
    const a = ps[i];
    const b = ps[i + 1];
    if (!a || !b) throw new Error('pivot');
    expect(Math.abs(dist(a, b) - lengthOf(seg))).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-3);
  });
  return ps;
}

describe('isqrt and directionStep (internal)', () => {
  it('isqrt is the exact floor square root', () => {
    const cases = [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99n, 100n, 2n ** 64n, 2n ** 64n - 1n];
    for (const n of cases) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    const big = 12345678901234567890123456789n;
    const r = isqrt(big * big + big);
    expect(r).toBe(big);
    expect(() => isqrt(-1n)).toThrow();
  });

  it('directionStep inverts the table: the direction of every table vector is its own step', () => {
    for (let k = 0; k < 1440; k++) {
      const deg = k / 4;
      expect(directionStep(BigInt(cosQ16(deg)), BigInt(sinQ16(deg)))).toBe(k);
      const [x, y] = rotatePointQ16(1000, 0, deg);
      expect(directionStep(BigInt(x), BigInt(y))).toBe(k);
    }
  });

  it('directionStep rounds to the nearest table direction and is undefined for the zero vector', () => {
    expect(directionStep(0n, 0n)).toBeUndefined();
    expect(directionStep(1n, 0n)).toBe(0);
    expect(directionStep(0n, 1n)).toBe(360);
    expect(directionStep(-1n, 0n)).toBe(720);
    expect(directionStep(0n, -1n)).toBe(1080);
    expect(directionStep(1n, 1n)).toBe(180);
    expect(directionStep(-3n, 3n)).toBe(540);
    // atan2(1, 100) = 0.5729°: nearest step 2 (0.5°), not 3 (0.75°).
    expect(directionStep(100n, 1n)).toBe(2);
    // Just below 360°: atan2(-1, 1000) = -0.0573° -> step 0 (360°), not 1439 (359.75°).
    expect(directionStep(1000n, -1n)).toBe(0);
    expect(directionStep(100n, -1n)).toBe(1438); // -0.5729° -> 359.5°
  });
});

describe('solveTwoBone: reachable targets', () => {
  it('reaches the FK image of random poses within 1 px (quanta 0.25, 1, 2)', () => {
    const rand = prng(11);
    let exact = 0;
    let total = 0;
    for (const q of [0.25, 1, 2]) {
      for (let n = 0; n < 150; n++) {
        const chain = randomChain(rand, 2, 3, 40);
        const truth = [randomAngle(rand, q), randomAngle(rand, q)];
        const target = last(pivots(chain, truth, q));
        const t = { x: target[0], y: target[1] };
        const s = solveTwoBone(chain, t, { angleQuantum: q });
        checkSolution(chain, s, q);
        expect(cheb(last(pivots(chain, s.angles, q)), t)).toBeLessThanOrEqual(1);
        expect(s.reached).toBe(true);
        total++;
        if (s.effector.x === t.x && s.effector.y === t.y) exact++;
      }
    }
    // Most land exactly on the target pixel.
    expect(exact / total).toBeGreaterThan(0.9);
  });

  it('reaches random integer targets inside the reach annulus within 1 px', () => {
    const rand = prng(12);
    let tried = 0;
    while (tried < 300) {
      const chain = randomChain(rand, 2, 4, 48);
      const [a, b] = chain.segments.map(lengthOf) as [number, number];
      const t = {
        x: chain.root.x + Math.floor(rand() * 200) - 100,
        y: chain.root.y + Math.floor(rand() * 200) - 100,
      };
      const d = Math.hypot(t.x - chain.root.x, t.y - chain.root.y);
      // A margin of a pixel from both edges of the annulus.
      if (d < Math.abs(a - b) + 1 || d > a + b - 1) continue;
      tried++;
      const s = solveTwoBone(chain, t, { angleQuantum: 1 });
      checkSolution(chain, s, 1);
      expect(cheb([s.effector.x, s.effector.y], t)).toBeLessThanOrEqual(1);
      expect(s.reached).toBe(true);
    }
  });

  it('bends to the requested side, and by default keeps the current side', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 20, y: 0 },
        { x: 20, y: 0 },
      ],
    };
    const t = { x: 28, y: 0 };
    const side = (s: IkSolution): number => {
      // Sign of the local joint angle, i.e. which way the second bone turns from the first.
      const a = (((s.angles[1] ?? 0) % 360) + 360) % 360;
      return a === 0 ? 0 : a < 180 ? 1 : -1;
    };
    const cw = solveTwoBone(chain, t, { bend: 'cw' });
    const ccw = solveTwoBone(chain, t, { bend: 'ccw' });
    expect(side(cw)).toBe(1);
    expect(side(ccw)).toBe(-1);
    // Clockwise bend: the elbow lies counter-clockwise of (above) the root -> target line.
    const pc = pivots(chain, cw.angles, 1);
    const pcc = pivots(chain, ccw.angles, 1);
    expect(pc[1]?.[1]).toBeLessThan(0);
    expect(pcc[1]?.[1]).toBeGreaterThan(0);
    // Mirror images: the two solutions are reflections of each other about the x axis.
    expect(cw.angles).toEqual(ccw.angles.map((a) => -a + 0));
    expect([cw.reached, ccw.reached]).toEqual([true, true]);
    // Default: the current bend side (straight: clockwise).
    expect(solveTwoBone(chain, t).angles).toEqual(cw.angles);
    expect(solveTwoBone({ ...chain, angles: [0, -10] }, t).angles).toEqual(ccw.angles);
    expect(solveTwoBone({ ...chain, angles: [0, 10] }, t).angles).toEqual(cw.angles);
  });

  it('bend sides hold on random reachable targets', () => {
    const rand = prng(13);
    for (let n = 0; n < 100; n++) {
      const chain = randomChain(rand, 2, 8, 40);
      // A joint bent 30° to 150° in the world (the rest directions of the two offsets differ).
      const [s0, s1] = chain.segments as [Point, Point];
      const restTurn = ((Math.atan2(s1.y, s1.x) - Math.atan2(s0.y, s0.x)) * 180) / Math.PI;
      const truth = [randomAngle(rand, 1), Math.round(30 + rand() * 120 - restTurn)];
      const target = last(pivots(chain, truth, 1));
      const t = { x: target[0], y: target[1] };
      for (const bend of ['cw', 'ccw'] as const satisfies readonly IkBend[]) {
        const s = solveTwoBone(chain, t, { bend });
        checkSolution(chain, s, 1);
        expect(s.reached).toBe(true);
        const ps = pivots(chain, s.angles, 1);
        const [p0, p1, p2] = ps as [V, V, V];
        const cross = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
        // A clockwise bend turns the second bone clockwise (positive cross product, y down).
        if (bend === 'cw') expect(cross).toBeGreaterThanOrEqual(0);
        else expect(cross).toBeLessThanOrEqual(0);
      }
    }
  });

  it('honours the base rotation of the chain parent', () => {
    const chain: IkChain = {
      root: { x: 10, y: 10 },
      segments: [
        { x: 0, y: 12 },
        { x: 0, y: 10 },
      ],
      baseRotation: 90,
    };
    const t = { x: -5, y: 20 };
    const s = solveTwoBone(chain, t);
    expect(s.reached).toBe(true);
    // The real FK with the parent turned by 90°: a root bone keyed by the base rotation.
    const { ids, rig, view } = chainRig({
      ...chain,
      segments: [{ x: 0, y: 0 }, ...chain.segments],
    });
    const pose = new Map<BoneId, PoseKey>([
      [at(ids, 0), { angle: 90 }],
      [at(ids, 1), { angle: s.angles[0] ?? 0 }],
      [at(ids, 2), { angle: s.angles[1] ?? 0 }],
    ]);
    const p = snapSkeleton(rig, view, pose).bones.get(at(ids, 3))?.pivot;
    expect(p).toEqual(s.effector);
    expect(cheb([s.effector.x, s.effector.y], t)).toBeLessThanOrEqual(1);
  });

  it('keeps every angle within 180° of the current key', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 10, y: 0 },
        { x: 10, y: 0 },
      ],
      angles: [700, -500],
    };
    const s = solveTwoBone(chain, { x: 0, y: 15 }, { bend: 'cw' });
    checkSolution(chain, s, 1);
    expect(s.reached).toBe(true);
  });
});

describe('solveTwoBone: unreachable and degenerate targets', () => {
  it('stretches straight toward a target out of reach', () => {
    const rand = prng(21);
    for (let n = 0; n < 200; n++) {
      const chain = randomChain(rand, 2, 4, 40);
      const [a, b] = chain.segments.map(lengthOf) as [number, number];
      const ang = rand() * 2 * Math.PI;
      const far = a + b + 2 + rand() * 100;
      const t = {
        x: chain.root.x + Math.round(far * Math.cos(ang)),
        y: chain.root.y + Math.round(far * Math.sin(ang)),
      };
      const d = Math.hypot(t.x - chain.root.x, t.y - chain.root.y);
      if (d <= a + b + 1) continue;
      const s = solveTwoBone(chain, t, { angleQuantum: 1 });
      const ps = checkSolution(chain, s, 1);
      expect(s.reached).toBe(false);
      const tv: V = [t.x, t.y];
      // The effector is as close as a straight chain gets (rounding aside) ...
      expect(dist(last(ps), tv)).toBeLessThanOrEqual(d - (a + b) + 1.5);
      // ... and both bones point at the target (within a degree plus the pixel rounding).
      for (let i = 0; i < 2; i++) {
        const p = at(ps, i);
        const q = at(ps, i + 1);
        const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const want = Math.atan2(t.y - p[1], t.x - p[0]);
        const off = Math.abs(Math.atan2(Math.sin(dir - want), Math.cos(dir - want)));
        expect(off).toBeLessThan((Math.PI / 180) * 1 + 1 / dist(p, q));
      }
    }
  });

  it('folds toward a target too close to the root', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 20, y: 0 },
        { x: 0, y: 8 },
      ],
    };
    // |L1 - L2| = 12: the nearest the effector can come to the root.
    const s = solveTwoBone(chain, { x: 3, y: 0 });
    const ps = checkSolution(chain, s, 1);
    expect(s.reached).toBe(false);
    expect(Math.abs(dist(last(ps), [0, 0]) - 12)).toBeLessThanOrEqual(1);
    expect(dist(last(ps), [3, 0])).toBeLessThanOrEqual(9 + 1);
    // The longer second bone points the other way.
    const flip: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 0, y: 8 },
        { x: 20, y: 0 },
      ],
    };
    const f = solveTwoBone(flip, { x: 3, y: 0 });
    const fp = checkSolution(flip, f, 1);
    expect(dist(last(fp), [3, 0])).toBeLessThanOrEqual(9 + 1);
  });

  it('a target on the root folds the chain and keeps the first bone where it is', () => {
    const chain: IkChain = {
      root: { x: 5, y: 5 },
      segments: [
        { x: 10, y: 0 },
        { x: 10, y: 0 },
      ],
      angles: [40, 0],
    };
    const s = solveTwoBone(chain, { x: 5, y: 5 });
    checkSolution(chain, s, 1);
    expect(s.angles[0]).toBe(40);
    expect(Math.abs(s.angles[1] ?? 0)).toBe(180);
    expect(s.reached).toBe(true);
  });

  it('handles zero-length bones', () => {
    const z: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    const s = solveTwoBone(z, { x: 0, y: 10 });
    checkSolution(z, s, 1);
    expect(s.effector).toEqual({ x: 0, y: 10 });
    const z2: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 10, y: 0 },
        { x: 0, y: 0 },
      ],
    };
    const s2 = solveTwoBone(z2, { x: -10, y: 0 });
    checkSolution(z2, s2, 1);
    expect(s2.effector).toEqual({ x: -10, y: 0 });
    const zz: IkChain = {
      root: { x: 3, y: 4 },
      segments: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    };
    const s3 = solveTwoBone({ ...zz, angles: [7, 8] }, { x: 50, y: 50 });
    expect(s3.angles).toEqual([7, 8]);
    expect(s3.effector).toEqual({ x: 3, y: 4 });
  });
});

describe('solveFabrik', () => {
  it('reaches the FK image of random poses of 1 to 6 bones within 1 px', () => {
    const rand = prng(31);
    let reached = 0;
    let total = 0;
    for (const q of [0.25, 1]) {
      for (let n = 0; n < 120; n++) {
        const bones = 1 + (n % 6);
        const chain = randomChain(rand, bones, 3, 30);
        const truth = Array.from({ length: bones }, () => randomAngle(rand, q));
        const target = last(pivots(chain, truth, q));
        const t = { x: target[0], y: target[1] };
        // Start from a random pose too: FABRIK starts from the current pose.
        const start = Array.from({ length: bones }, () => randomAngle(rand, q));
        const s = solveFabrik({ ...chain, angles: start }, t, { angleQuantum: q });
        checkSolution({ ...chain, angles: start }, s, q);
        total++;
        if (cheb([s.effector.x, s.effector.y], t) <= 1) reached++;
        expect(s.reached).toBe(cheb([s.effector.x, s.effector.y], t) <= 1);
      }
    }
    expect(reached).toBe(total);
  });

  it('stretches straight toward a target out of reach', () => {
    const rand = prng(32);
    for (let n = 0; n < 100; n++) {
      const bones = 2 + (n % 4);
      const chain = randomChain(rand, bones, 4, 25);
      const total = chain.segments.map(lengthOf).reduce((x, y) => x + y, 0);
      const ang = rand() * 2 * Math.PI;
      const far = total + 3 + rand() * 50;
      const t = {
        x: chain.root.x + Math.round(far * Math.cos(ang)),
        y: chain.root.y + Math.round(far * Math.sin(ang)),
      };
      const d = Math.hypot(t.x - chain.root.x, t.y - chain.root.y);
      const s = solveFabrik(chain, t);
      const ps = checkSolution(chain, s, 1);
      expect(s.reached).toBe(false);
      expect(dist(last(ps), [t.x, t.y])).toBeLessThanOrEqual(d - total + 0.5 + bones * 0.5);
      for (let i = 0; i < bones; i++) {
        const p = at(ps, i);
        const q = at(ps, i + 1);
        const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const want = Math.atan2(t.y - chain.root.y, t.x - chain.root.x);
        const off = Math.abs(Math.atan2(Math.sin(dir - want), Math.cos(dir - want)));
        expect(off).toBeLessThan((Math.PI / 180) * 1 + 1.5 / dist(p, q));
      }
    }
  });

  it('keeps every bone length in the fixed-point solve (internal joints)', () => {
    const rand = prng(33);
    for (let n = 0; n < 60; n++) {
      const bones = 2 + (n % 5);
      const chain = randomChain(rand, bones, 3, 30);
      const t = { x: Math.floor(rand() * 120) - 30, y: Math.floor(rand() * 120) - 30 };
      const { joints, lengths } = fabrikJoints(chain, t, IK_ITERATIONS_DEFAULT, 1);
      expect(joints).toHaveLength(bones + 1);
      expect(joints[0]).toEqual([BigInt(chain.root.x) << 16n, BigInt(chain.root.y) << 16n]);
      for (let i = 0; i < bones; i++) {
        const [ax, ay] = joints[i] ?? [0n, 0n];
        const [bx, by] = joints[i + 1] ?? [0n, 0n];
        const l = lengths[i] ?? 0n;
        const d2 = (bx - ax) ** 2n + (by - ay) ** 2n;
        // Within one Q16 unit (1/65536 px) of the fixed-point length: |d - l| <= 1.
        expect(d2 >= (l - 1n) ** 2n && d2 <= (l + 1n) ** 2n).toBe(true);
        // And the fixed-point length is the true length, rounded.
        const seg = chain.segments[i] ?? { x: 0, y: 0 };
        expect(Math.abs(Number(l) / 65536 - lengthOf(seg))).toBeLessThan(1e-4);
      }
    }
  });

  it('uses the two-bone result space too: a 2-bone FABRIK solve reaches as well', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 12, y: 0 },
        { x: 10, y: 0 },
      ],
      angles: [10, 30],
    };
    const s = solveFabrik(chain, { x: 10, y: 12 });
    checkSolution(chain, s, 1);
    expect(s.reached).toBe(true);
  });

  it('copes with zero-length bones and a start pose with every joint on the target', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 10, y: 0 },
        { x: 0, y: 0 },
        { x: 8, y: 0 },
      ],
    };
    const s = solveFabrik(chain, { x: 0, y: 15 });
    checkSolution(chain, s, 1);
    expect(s.reached).toBe(true);
    // Fully folded start on the target itself.
    const folded: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 10, y: 0 },
        { x: 10, y: 0 },
      ],
      angles: [0, 180],
    };
    const f = solveFabrik(folded, { x: 0, y: 0 });
    checkSolution(folded, f, 1);
    expect(f.reached).toBe(true);
  });

  it('respects the iteration budget', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    const t = { x: -8, y: 6 };
    const one = fabrikJoints(chain, t, 1, 1);
    const many = fabrikJoints(chain, t, IK_ITERATIONS_DEFAULT, 1);
    expect(one.iterations).toBe(1);
    expect(many.iterations).toBeGreaterThan(1);
    expect(many.iterations).toBeLessThanOrEqual(IK_ITERATIONS_DEFAULT);
    expect(solveFabrik(chain, t, { iterations: 200 }).reached).toBe(true);
  });
});

describe('solveFabrik: review fixes', () => {
  it('a bone the solve cannot turn keeps its local key angle', () => {
    const chain: IkChain = {
      root: { x: 0, y: 0 },
      segments: [
        { x: 20, y: 0 },
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      angles: [0, 10, 0],
    };
    const s = solveFabrik(chain, { x: 10, y: 25 });
    expect(s.angles[1]).toBe(10);
    checkSolution(chain, s, 1);
    // The refinement turns the parent, and the key still holds, for any target.
    for (let x = -30; x <= 30; x += 3) {
      for (let y = -30; y <= 30; y += 3) {
        expect(solveFabrik(chain, { x, y }).angles[1]).toBe(10);
      }
    }
  });

  it('keeps exact key angles near the largest safe step count', () => {
    const steps = 2 ** 53 - 1; // 2 + (2^53 - 1) = 2^53 + 1 is not a double
    const big = steps / 4;
    const small = Number(BigInt(steps) % 1440n) / 4;
    const segments = [
      { x: 10, y: 0 },
      { x: 12, y: 3 },
      { x: 8, y: -4 },
    ];
    const root = { x: 5, y: 5 };
    const t = { x: 14, y: 16 };
    // The start pose (hence every joint) depends on the exact sum of the keys.
    const a = fabrikJoints({ root, segments, angles: [0.5, big, 0] }, t, 20, 0.25);
    const b = fabrikJoints({ root, segments, angles: [0.5, small, 0] }, t, 20, 0.25);
    expect(a).toEqual(b);
  });

  it('stops early when a target within the bone lengths cannot be reached', () => {
    const cases: [IkChain, Point][] = [
      // Inside the minimum reach |L1 - L2| = 15.
      [
        {
          root: { x: 0, y: 0 },
          segments: [
            { x: 20, y: 0 },
            { x: 5, y: 0 },
          ],
        },
        { x: 3, y: 0 },
      ],
      // One bone: the target is not at distance L.
      [
        { root: { x: 0, y: 0 }, segments: [{ x: 10, y: 0 }] },
        { x: 4, y: 0 },
      ],
      // A zero-length bone after a normal one: the target is not at the end of the first.
      [
        {
          root: { x: 0, y: 0 },
          segments: [
            { x: 10, y: 0 },
            { x: 0, y: 0 },
          ],
        },
        { x: 4, y: 3 },
      ],
    ];
    for (const [chain, t] of cases) {
      const j = fabrikJoints(chain, t, 10000, 1);
      expect(j.reachable).toBe(true);
      expect(j.iterations).toBeLessThan(50);
      const s = solveFabrik(chain, t, { iterations: 10000 });
      expect(s.angles).toHaveLength(chain.segments.length);
    }
  });
});

describe('solveIk (rig level)', () => {
  const tpl = humanoidSide({ origin: { x: 24, y: 47 } });
  const rig = makeRig(
    tpl.bones.map((b) =>
      b.parent === undefined ? [bone(b.name)] : [bone(b.name), bone(b.parent)],
    ),
  );
  const view = makeView(tpl.bones.map((b) => [bone(b.name), b.rest.x, b.rest.y, b.rest.angle]));
  const id = (name: string): BoneId => {
    if (!tpl.bones.some((x) => x.name === name)) throw new Error(name);
    return bone(name);
  };

  it('moves hand_r onto a reachable target with a two-bone chain, as plain FK keys', () => {
    const target = { x: 30, y: 22 };
    const pose = new Map<BoneId, PoseKey>([[id('torso'), { angle: 10 }]]);
    const s = solveIk({ rig, view, pose, effector: id('hand_r'), target });
    expect([...s.angles.keys()]).toEqual([id('upper_arm_r'), id('lower_arm_r')]);
    const merged = new Map(pose);
    for (const [b, a] of s.angles) merged.set(b, { ...merged.get(b), angle: a });
    const hand = snapSkeleton(rig, view, merged).bones.get(id('hand_r'))?.pivot;
    expect(hand).toEqual(s.effector);
    expect(cheb([s.effector.x, s.effector.y], target)).toBeLessThanOrEqual(1);
    expect(s.reached).toBe(true);
    // Other bones are not touched.
    expect(s.angles.has(id('torso'))).toBe(false);
  });

  it('honours offset keys on the chain and solves longer chains with FABRIK', () => {
    const target = { x: 30, y: 20 };
    const pose = new Map<BoneId, PoseKey>([
      [id('lower_arm_r'), { offset: { x: 1, y: -1 } }],
      [id('hand_r'), { offset: { x: 0, y: 1 }, angle: 15 }],
    ]);
    for (const chainLength of [2, 3]) {
      const s = solveIk({
        rig,
        view,
        pose,
        effector: id('hand_r'),
        target,
        chainLength,
        angleQuantum: 0.25,
      });
      const merged = new Map(pose);
      for (const [b, a] of s.angles) merged.set(b, { ...merged.get(b), angle: a });
      const sk = snapSkeleton(rig, view, merged, { angleQuantum: 0.25 });
      expect(sk.bones.get(id('hand_r'))?.pivot).toEqual(s.effector);
      expect(cheb([s.effector.x, s.effector.y], target)).toBeLessThanOrEqual(1);
      expect(s.angles.size).toBe(chainLength);
    }
    const fab = solveIk({
      rig,
      view,
      pose,
      effector: id('foot_r'),
      target: { x: 30, y: 40 },
      solver: 'fabrik',
    });
    expect(fab.reached).toBe(true);
    const two = solveIk({
      rig,
      view,
      pose,
      effector: id('foot_r'),
      target: { x: 30, y: 40 },
      bend: 'ccw',
    });
    expect(two.reached).toBe(true);
  });

  it('a chain of one bone points it at the target', () => {
    const s = solveIk({
      rig,
      view,
      effector: id('head'),
      target: { x: 40, y: 10 },
      chainLength: 1,
    });
    expect([...s.angles.keys()]).toEqual([id('neck')]);
  });

  it('validates bend up front and allows it only for a two-bone chain', () => {
    const base = { rig, view, effector: id('hand_r'), target: { x: 30, y: 22 } };
    const bad = 'up' as IkBend;
    expect(errorCode(() => solveIk({ ...base, bend: bad }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, solver: 'fabrik', bend: bad }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 3, bend: bad }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, solver: 'fabrik', bend: 'cw' }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 3, bend: 'cw' }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 1, bend: 'ccw' }))).toBe('BAD_VALUE');
    expect(solveIk({ ...base, bend: 'cw' }).angles.size).toBe(2);
    expect(solveIk({ ...base, solver: 'two-bone', bend: 'ccw' }).angles.size).toBe(2);
  });

  it('refuses bad input with typed errors', () => {
    const base = { rig, view, effector: id('hand_r'), target: { x: 30, y: 22 } };
    expect(errorCode(() => solveIk({ ...base, effector: 'bon_nope' as BoneId }))).toBe(
      'UNKNOWN_BONE',
    );
    expect(errorCode(() => solveIk({ ...base, chainLength: 20 }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 0 }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 1.5 }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveIk({ ...base, chainLength: 3, solver: 'two-bone' }))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => solveIk({ ...base, angleQuantum: 0.3 }))).toBe('BAD_QUANTUM');
    expect(errorCode(() => solveIk({ ...base, target: { x: 0.5, y: 0 } }))).toBe('BAD_VALUE');
    const c: IkChain = { root: { x: 0, y: 0 }, segments: [{ x: 1, y: 0 }] };
    const t = { x: 1, y: 1 };
    expect(errorCode(() => solveTwoBone(c, t))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik({ root: { x: 0, y: 0 }, segments: [] }, t))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => solveFabrik({ ...c, angles: [1, 2] }, t))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik({ ...c, angles: [Number.NaN] }, t))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik({ ...c, baseRotation: 0.1 }, t))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik({ ...c, segments: [{ x: 0.5, y: 0 }] }, t))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => solveFabrik({ ...c, root: { x: 2 ** 32, y: 0 } }, t))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik(c, t, { iterations: 0 }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik(c, t, { iterations: 2.5 }))).toBe('BAD_VALUE');
    expect(errorCode(() => solveFabrik(c, t, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
    expect(
      errorCode(() =>
        solveTwoBone(
          {
            ...c,
            segments: [
              { x: 1, y: 0 },
              { x: 1, y: 0 },
            ],
          },
          t,
          { bend: 'up' as IkBend },
        ),
      ),
    ).toBe('BAD_VALUE');
    const many = {
      root: { x: 0, y: 0 },
      segments: Array.from({ length: 65 }, () => ({ x: 1, y: 0 })),
    };
    expect(errorCode(() => solveFabrik(many, t))).toBe('BAD_VALUE');
  });
});

describe('IK: determinism (ADR-010)', () => {
  /** The case table: two-bone and FABRIK over seeded chains, targets, quanta and bends. */
  function table(): unknown[] {
    const rand = prng(2026);
    const out: unknown[] = [];
    for (let n = 0; n < 60; n++) {
      const q = [0.25, 1, 5][n % 3] ?? 1;
      const bones = 2 + (n % 4);
      const chain = randomChain(rand, bones, 3, 30);
      const t = { x: Math.floor(rand() * 140) - 40, y: Math.floor(rand() * 140) - 40 };
      const start = Array.from({ length: bones }, () => randomAngle(rand, q));
      const c = { ...chain, angles: start };
      const f = solveFabrik(c, t, { angleQuantum: q });
      out.push(['fabrik', f.angles, f.effector, f.reached]);
      if (bones === 2) {
        for (const bend of ['cw', 'ccw'] as const) {
          const s = solveTwoBone(c, t, { angleQuantum: q, bend });
          out.push(['two', bend, s.angles, s.effector, s.reached]);
        }
      }
    }
    return out;
  }
  const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

  it('gives the same result every time', () => {
    expect(table()).toEqual(table());
  });

  it('matches the committed hash of the case table', () => {
    // Pinned on macOS (2026-11-02); CI must reproduce it on Linux (ADR-010).
    expect(hash(table())).toBe('3e1c9198dda7b827300c4236c1be6f9ceb3c23a928152d6021831d6211f45d67');
  });

  it('uses no Math trig, no Math.sqrt, no Math.random and no clock', () => {
    const banned = [
      'random',
      'sin',
      'cos',
      'tan',
      'atan',
      'atan2',
      'asin',
      'acos',
      'sinh',
      'cosh',
      'tanh',
      'sqrt',
      'hypot',
      'pow',
      'exp',
      'log',
    ] as const;
    const before = hash(table());
    for (const n of banned) {
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called by IK`);
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called by IK');
    });
    // The table itself uses only the seeded PRNG and integer maths outside the solvers.
    expect(hash(table())).toBe(before);
  });
});
