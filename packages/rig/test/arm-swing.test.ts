/**
 * Oracles (e) and (f) on the 12-frame arm-swing fixture: a 3-bone arm (shoulder -> elbow -> wrist)
 * swinging ±30° at the shoulder (ease-in-out both ways, looping). On the forward swing (frames 0-6)
 * the elbow counter-rotates so the forearm keeps a constant 20° rotation; on the way back it lags and
 * catches up. Only the shoulder is a root, so it never moves.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluatePose, type SnappedSkeleton } from '../src/index.js';
import { mod360, newStats, reference, type RefBone } from './float-reference.js';
import { angularDistance, bone, makeAnim, makeRig, makeView, prng, randomCase } from './helpers.js';

const S = bone('shoulder');
const E = bone('elbow');
const W = bone('wrist');
const rig = makeRig([[S], [E, S], [W, E]]);
const REST = { shoulder: [16, 8], elbow: [2, 9], wrist: [-1, 8] } as const;
const view = makeView([
  [S, REST.shoulder[0], REST.shoulder[1], 90],
  [E, REST.elbow[0], REST.elbow[1], 0],
  [W, REST.wrist[0], REST.wrist[1], 0],
]);
const anim = makeAnim(
  12,
  {
    0: { [S]: { angle: -30, interp: 'ease-in-out' }, [E]: { angle: 50, interp: 'ease-in-out' } },
    3: { [W]: { angle: 15 } },
    6: { [S]: { angle: 30, interp: 'ease-in-out' }, [E]: { angle: -10 } },
    8: { [W]: { angle: -15 } },
    9: { [E]: { angle: 25, interp: 'ease-in-out' } },
  },
  'loop',
);
const FRAMES = 12;

const skeletons: SnappedSkeleton[] = anim.frames.map((_, f) => evaluatePose(rig, view, anim, f));
// The independent reference (test/float-reference.ts) of every frame: key angles accumulated down the
// chain from the INPUT keys and the rest pose, never read back from the code under test. It consults
// the skeleton only at float-ambiguous roundings, and the fixture has none (asserted below).
const refStats = newStats();
const refs = skeletons.map((sk, f) => reference({ rig, view, anim }, f, sk, refStats));
const ref = (f: number, id: typeof S): RefBone => {
  const r = refs[f % FRAMES]?.get(id);
  if (!r) throw new Error('missing bone');
  return r;
};
const get = (f: number, id: typeof S) => {
  const b = skeletons[f % FRAMES]?.bones.get(id);
  if (!b) throw new Error('missing bone');
  return b;
};
type V = readonly [number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const cheb = (a: V, b: V): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const pv = (f: number, id: typeof S): V => [get(f, id).pivot.x, get(f, id).pivot.y];
const L_ELBOW = Math.hypot(...REST.elbow);
const L_WRIST = Math.hypot(...REST.wrist);

/**
 * The WRONG method, deliberately: the same quantised rotations, but every pivot is the float64 chain
 * position rounded on its own (half away from zero), independently of its parent's rounding.
 */
function independentlyRounded(f: number): { elbow: V; wrist: V } {
  const round = (v: number): number => (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)) + 0;
  const rot = ([x, y]: V, deg: number): V => {
    const t = (deg * Math.PI) / 180;
    return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
  };
  const e = rot(REST.elbow, ref(f, S).rotation);
  const elbow: V = [REST.shoulder[0] + e[0], REST.shoulder[1] + e[1]];
  const w = rot(REST.wrist, ref(f, E).rotation);
  const wrist: V = [elbow[0] + w[0], elbow[1] + w[1]];
  return { elbow: [round(elbow[0]), round(elbow[1])], wrist: [round(wrist[0]), round(wrist[1])] };
}

/** Consecutive frame pairs, including the loop seam 11 -> 0. */
const PAIRS = Array.from({ length: FRAMES }, (_, f) => [f, (f + 1) % FRAMES] as const);

describe('oracle (e): the arm swing is continuous and the jitter bug is detectable', () => {
  // golden reviewed: derived from independent reference, 2026-10-27
  // Every pivot of the 12 frames below was computed by the float64 reference of test/float-reference.ts
  // (key angles accumulated down the chain from the input keys and the rest pose; exact tie handling),
  // not by running `evaluatePose`; frames 0 and 3 are also recomputed on paper in the README. Both the
  // reference and the implementation are asserted equal to it.
  const EXPECTED_PIVOTS = [
    [
      [16, 8],
      [22, 15],
      [18, 22],
    ],
    [
      [16, 8],
      [22, 15],
      [18, 22],
    ],
    [
      [16, 8],
      [20, 16],
      [16, 23],
    ],
    [
      [16, 8],
      [18, 17],
      [14, 24],
    ],
    [
      [16, 8],
      [16, 17],
      [12, 24],
    ],
    [
      [16, 8],
      [14, 17],
      [10, 24],
    ],
    [
      [16, 8],
      [13, 17],
      [9, 24],
    ],
    [
      [16, 8],
      [14, 17],
      [9, 24],
    ],
    [
      [16, 8],
      [16, 17],
      [11, 24],
    ],
    [
      [16, 8],
      [18, 17],
      [14, 24],
    ],
    [
      [16, 8],
      [20, 16],
      [17, 23],
    ],
    [
      [16, 8],
      [22, 15],
      [19, 22],
    ],
  ];
  // Rotation of the shoulder and of the elbow (the sums of the key angles of the bone and its ancestors).
  const EXPECTED_ROTATIONS = [
    [330, 20],
    [334, 20],
    [346, 20],
    [0, 20],
    [14, 20],
    [26, 20],
    [30, 20],
    [26, 28],
    [14, 27],
    [0, 25],
    [346, 17],
    [334, 18],
  ];

  it('the pivot table equals the independently derived expected table (all 12 frames)', () => {
    const refTable = anim.frames.map((_, f) => [S, E, W].map((id) => ref(f, id).pivot));
    expect(refTable).toEqual(EXPECTED_PIVOTS);
    const table = anim.frames.map((_, f) => [pv(f, S), pv(f, E), pv(f, W)]);
    expect(table).toEqual(EXPECTED_PIVOTS);
    expect(
      anim.frames.map((_, f) => [mod360(ref(f, S).rotation), mod360(ref(f, E).rotation)]),
    ).toEqual(EXPECTED_ROTATIONS);
    // The fixture has no float-ambiguous rounding, so the reference never consulted the code under test.
    expect(refStats.ambiguous).toEqual({ angle: 0, rest: 0, rotation: 0 });
    expect(anim.frames.map((_, f) => [get(f, S).rotation, get(f, E).rotation])).toEqual(
      EXPECTED_ROTATIONS,
    );
  });

  it('every joint moves at most ceil(L·Δθ) + 1 per frame (the card bound), and even ceil(L·Δθ)', () => {
    for (const [a, b] of PAIRS) {
      const dS = angularDistance(ref(a, S).rotation, ref(b, S).rotation);
      const dE = angularDistance(ref(a, E).rotation, ref(b, E).rotation);
      // Elbow relative to the (fixed) shoulder; wrist relative to the snapped elbow.
      const elbowStep = cheb(pv(b, E), pv(a, E));
      const wristRel = cheb(sub(pv(b, W), pv(b, E)), sub(pv(a, W), pv(a, E)));
      expect(elbowStep).toBeLessThanOrEqual(Math.ceil(L_ELBOW * dS) + 1);
      expect(wristRel).toBeLessThanOrEqual(Math.ceil(L_WRIST * dE) + 1);
      expect(elbowStep).toBeLessThanOrEqual(Math.ceil(L_ELBOW * dS));
      expect(wristRel).toBeLessThanOrEqual(Math.ceil(L_WRIST * dE));
      // A continuous path: the wrist's own step is bounded by the elbow's step plus its own swing.
      expect(cheb(pv(b, W), pv(a, W))).toBeLessThanOrEqual(elbowStep + Math.ceil(L_WRIST * dE));
    }
  });

  it('the forearm is rigid while its rotation is constant (frames 0-6)', () => {
    for (let f = 0; f <= 6; f++) {
      expect(mod360(ref(f, E).rotation)).toBe(20);
      expect(get(f, E).rotation).toBe(20);
      expect(sub(pv(f, W), pv(f, E))).toEqual([-4, 7]); // rotatePoint(-1, 8, 20°)
    }
  });

  it('rounding the child independently of the parent (WRONG) breaks the tight bound and rigidity', () => {
    const violations: string[] = [];
    let looseViolations = 0;
    for (const [a, b] of PAIRS) {
      const wa = independentlyRounded(a);
      const wb = independentlyRounded(b);
      // The shoulder is an integer root, so the wrong elbow equals the snapped one: only the wrist differs.
      expect(wa.elbow).toEqual(pv(a, E));
      const dE = angularDistance(ref(a, E).rotation, ref(b, E).rotation);
      const rel = cheb(sub(wb.wrist, wb.elbow), sub(wa.wrist, wa.elbow));
      if (rel > Math.ceil(L_WRIST * dE)) violations.push(`${String(a)}->${String(b)}`);
      if (rel > Math.ceil(L_WRIST * dE) + 1) looseViolations++;
    }
    // The forearm does not rotate between these frames (Δθ = 0), yet the wrong method moves the wrist
    // relative to the elbow by 1 px: the joint jitters. Hierarchical snapping keeps it exactly still.
    expect(violations).toEqual(['0->1', '5->6']);
    expect(independentlyRounded(0).wrist).toEqual([19, 22]);
    expect(pv(0, W)).toEqual([18, 22]);
    // The card's "+1" bound alone cannot catch this bug: per axis, independent rounding moves the
    // relative vector by < |Δv| + 2, i.e. at most ceil(|Δv|) + 1 ≤ ceil(L·Δθ) + 1 (README, ADR-012).
    expect(looseViolations).toBe(0);
  });
});

describe('oracle (f): determinism', () => {
  const canonical = (sks: readonly SnappedSkeleton[]): string =>
    JSON.stringify(
      sks.map((sk) =>
        [...sk.bones.values()].map((b) => [
          b.id,
          b.pivot.x,
          b.pivot.y,
          b.key.angle,
          b.rotation,
          b.restAngle,
          b.worldAngle,
          b.flipX,
        ]),
      ),
    );

  it('the fixture pivot table has a committed hash (a secondary pin: the expected table above is the golden)', () => {
    const hash = createHash('sha256').update(canonical(skeletons)).digest('hex');
    expect(hash).toBe('2d24875d738a65a579e2b07feef498f1f771fc70e625374236edc2238d55ba9d');
  });

  it('is identical across runs, and never calls floating-point trig', () => {
    const names = [
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
    ] as const;
    const spies = names.map((n) =>
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called in the pose path`);
      }),
    );
    try {
      const again = anim.frames.map((_, f) => evaluatePose(rig, view, anim, f));
      expect(canonical(again)).toBe(canonical(skeletons));
      const rand = prng(5);
      for (let n = 0; n < 100; n++) {
        const c = randomCase(rand);
        const a = c.anim.frames.map((_, f) => evaluatePose(c.rig, c.view, c.anim, f));
        const b = c.anim.frames.map((_, f) => evaluatePose(c.rig, c.view, c.anim, f));
        expect(canonical(b)).toBe(canonical(a));
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
