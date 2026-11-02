/**
 * `fitPose` (B0.1): the pose search. The renderer is the real part renderer on a synthetic three-bone
 * arm (test/fit-fixture.ts), so the acceptance test is "recover a known pose exactly".
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIT_POSE_COARSE,
  FIT_POSE_MAX_RENDERS,
  FIT_POSE_RESTARTS,
  fitPose,
  pixelMismatch,
} from '../src/index.js';
import type { FitImage, FitPoseCandidate, FitPoseInput, FitPoseResult } from '../src/index.js';
import { H, W, renderArm } from './fit-fixture.js';
import { errorCode } from './helpers.js';
import { need } from './render-fixture.js';

const BONES = [{ bone: 'shoulder' }, { bone: 'elbow' }, { bone: 'wrist' }] as const;
const HAND = [{ part: 'hand', choices: ['open', 'fist'] }] as const;

interface Case {
  readonly angles: { shoulder: number; elbow: number; wrist: number };
  readonly hand: 'open' | 'fist';
  readonly seed: number;
  readonly quantum?: number;
}

/** Known poses, spread over the range, each with its own seed. */
const CASES: readonly Case[] = [
  { angles: { shoulder: 35, elbow: -50, wrist: 20 }, hand: 'fist', seed: 1 },
  { angles: { shoulder: -120, elbow: 60, wrist: -90 }, hand: 'open', seed: 2 },
  { angles: { shoulder: 90, elbow: -90, wrist: 90 }, hand: 'fist', seed: 3 },
  { angles: { shoulder: 0, elbow: 0, wrist: 0 }, hand: 'open', seed: 4 },
  { angles: { shoulder: -30, elbow: 45, wrist: -60 }, hand: 'fist', seed: 5 },
  { angles: { shoulder: 150, elbow: -120, wrist: 45 }, hand: 'open', seed: 6 },
  { angles: { shoulder: 35, elbow: -50, wrist: 20 }, hand: 'fist', seed: 7, quantum: 5 },
];

/** The case at `i` of the table. */
const caseAt = (i: number): Case => need(CASES[i]);

const truthOf = (c: Case): FitPoseCandidate => ({ angles: c.angles, variants: { hand: c.hand } });

/** Fits `c` and counts how often the renderer is called, and with what. */
function run(
  c: Case,
  extra: Partial<FitPoseInput> = {},
): { result: FitPoseResult; calls: string[] } {
  const calls: string[] = [];
  const quantum = c.quantum ?? 1;
  const result = fitPose({
    target: renderArm(truthOf(c), quantum),
    render: (p) => {
      calls.push(JSON.stringify(p));
      return renderArm(p, quantum);
    },
    bones: BONES,
    variants: HAND,
    seed: c.seed,
    quantum,
    ...extra,
  });
  return { result, calls };
}

/** Whether the result's render equals the render of the case's true pose. */
const sameImage = (r: FitPoseResult, c: Case): boolean => {
  const quantum = c.quantum ?? 1;
  const mine = renderArm({ angles: r.angles, variants: r.variants }, quantum);
  return pixelMismatch(mine, renderArm(truthOf(c), quantum)) === 0;
};

afterEach(() => vi.restoreAllMocks());

describe('pixelMismatch', () => {
  const img = (px: number[][]): FitImage => ({
    width: px.length,
    height: 1,
    data: Uint8Array.from(px.flat()),
  });

  it('counts the pixels that differ in any channel', () => {
    const a = img([
      [1, 2, 3, 255],
      [4, 5, 6, 255],
      [7, 8, 9, 128],
    ]);
    expect(pixelMismatch(a, a)).toBe(0);
    expect(
      pixelMismatch(
        a,
        img([
          [1, 2, 3, 255],
          [4, 5, 7, 255], // blue differs
          [7, 8, 9, 127], // alpha differs
        ]),
      ),
    ).toBe(2);
  });

  it('treats every alpha-0 pixel as equal, whatever its colour', () => {
    expect(pixelMismatch(img([[1, 2, 3, 0]]), img([[9, 9, 9, 0]]))).toBe(0);
    expect(pixelMismatch(img([[1, 2, 3, 0]]), img([[1, 2, 3, 1]]))).toBe(1);
  });

  it('refuses images of another size or a short buffer', () => {
    const one = img([[0, 0, 0, 0]]);
    const two = img([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(errorCode(() => pixelMismatch(one, two))).toBe('BAD_VALUE');
    expect(
      errorCode(() => pixelMismatch({ width: 2, height: 1, data: new Uint8Array(4) }, two)),
    ).toBe('BAD_VALUE');
  });
});

describe('fitPose: acceptance', () => {
  // The bound. fitPose never renders more than `maxRenders` (3000 by default, FIT_POSE_MAX_RENDERS).
  // On this three-bone arm with a hand variant and a ±180° range, every case below is recovered
  // exactly in at most 600 renders (the table needs 1 to 599), which is the bound asserted here.
  const BOUND = 600;

  it('recovers a known pose exactly within a bounded number of renders', () => {
    const c = caseAt(0);
    const { result, calls } = run(c);
    expect(result.exact).toBe(true);
    expect(result.error).toBe(0);
    expect(sameImage(result, c)).toBe(true);
    expect(result.angles.shoulder).toBe(35);
    expect(result.angles.elbow).toBe(-50);
    expect(result.variants).toEqual({ hand: 'fist' });
    expect(result.renders).toBeLessThanOrEqual(BOUND);
    expect(result.renders).toBeLessThanOrEqual(FIT_POSE_MAX_RENDERS);
    expect(result.renders).toBe(calls.length);
  });

  it('recovers every case of the table (all four unknowns, two quanta)', () => {
    let most = 0;
    for (const c of CASES) {
      const { result } = run(c);
      const label = JSON.stringify(c);
      // Exact means the render equals the target. Two poses can draw the same image (a hand turned
      // by a few degrees, or an arm by one degree, can snap to the same pixels), so the render is
      // compared, not the angles.
      expect(result.exact, label).toBe(true);
      expect(sameImage(result, c), label).toBe(true);
      expect(result.variants, label).toEqual({ hand: c.hand });
      expect(result.renders, label).toBeLessThanOrEqual(BOUND);
      most = Math.max(most, result.renders);
    }
    expect(most).toBeLessThanOrEqual(BOUND);
  });

  it('renders the best pose it reports: its render equals the target', () => {
    const c = caseAt(1);
    const { result } = run(c);
    expect(sameImage(result, c)).toBe(true);
  });

  it('needs one render when the start pose is already right', () => {
    const c = caseAt(3);
    const { result } = run(c);
    expect(result.renders).toBe(1);
    expect(result.restarts).toBe(0);
  });

  it('searches variants alone, and one bone alone', () => {
    const c = caseAt(0);
    const only = fitPose({
      target: renderArm({ angles: {}, variants: { hand: 'fist' } }),
      render: renderArm,
      bones: [],
      variants: HAND,
      seed: 1,
    });
    expect(only).toMatchObject({ exact: true, variants: { hand: 'fist' }, renders: 2 });
    const bone = fitPose({
      target: renderArm({ angles: { shoulder: c.angles.shoulder }, variants: {} }),
      render: renderArm,
      bones: [{ bone: 'shoulder' }],
      seed: 1,
    });
    expect(bone).toMatchObject({ exact: true, angles: { shoulder: 35 }, variants: {} });
    expect(bone.renders).toBeLessThanOrEqual(100);
  });
});

describe('fitPose: limits and options', () => {
  it('never renders more than maxRenders, and says it did not match', () => {
    const c = caseAt(0);
    for (const maxRenders of [1, 5, 40]) {
      const { result, calls } = run(c, { maxRenders });
      expect(calls.length, String(maxRenders)).toBeLessThanOrEqual(maxRenders);
      expect(result.renders).toBe(calls.length);
      expect(result.exact).toBe(false);
      expect(result.error).toBeGreaterThan(0);
    }
  });

  it('renders each pose at most once', () => {
    const { calls } = run(caseAt(1));
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('keeps angles inside the range and on the quantum grid', () => {
    const c = caseAt(0);
    const { result, calls } = run(c, {
      bones: [
        { bone: 'shoulder', min: 10, max: 40, start: 100 },
        { bone: 'elbow', min: -60, max: -40 },
        { bone: 'wrist', min: 0, max: 30 },
      ],
      quantum: 5,
    });
    expect(result.exact).toBe(true); // 35, -50 and 20 are on the grid of 5 and inside the ranges
    for (const call of calls) {
      const { angles } = JSON.parse(call) as FitPoseCandidate;
      expect(angles.shoulder).toBeGreaterThanOrEqual(10);
      expect(angles.shoulder).toBeLessThanOrEqual(40);
      expect(angles.elbow).toBeGreaterThanOrEqual(-60);
      expect(angles.elbow).toBeLessThanOrEqual(-40);
      expect(angles.wrist).toBeGreaterThanOrEqual(0);
      expect(angles.wrist).toBeLessThanOrEqual(30);
      for (const v of Object.values(angles)) expect(Math.abs(v % 5)).toBe(0);
    }
    // The first render is the start pose: 100 clamped to 40, 0 clamped into [-60, -40], 0 in range.
    expect((JSON.parse(calls[0] ?? '{}') as FitPoseCandidate).angles).toEqual({
      shoulder: 40,
      elbow: -40,
      wrist: 0,
    });
  });

  it('reports the best pose and its error for a target no pose draws', () => {
    // The true render plus one stray pixel in a corner: the best a search can do is error 1.
    const c = caseAt(0);
    const truth = renderArm(truthOf(c));
    const data = Uint8Array.from(truth.data);
    data.set([9, 9, 9, 255], 4 * (W * H - 1));
    const result = fitPose({
      target: { width: W, height: H, data },
      render: renderArm,
      bones: BONES,
      variants: HAND,
      seed: 3,
      restarts: 1,
      maxRenders: 400,
    });
    expect(result.exact).toBe(false);
    expect(result.error).toBe(1);
    expect(result.angles.shoulder).toBe(35);
    expect(result.restarts).toBe(1);
  });

  it('has documented defaults', () => {
    expect(FIT_POSE_MAX_RENDERS).toBe(3000);
    expect(FIT_POSE_RESTARTS).toBe(8);
    expect(FIT_POSE_COARSE).toBe(16);
  });

  it('refuses invalid input before it renders', () => {
    const render = vi.fn(renderArm);
    const base = { target: renderArm({ angles: {}, variants: {} }), render, seed: 1 };
    const code = (input: Partial<FitPoseInput>): string | undefined =>
      errorCode(() => fitPose({ ...base, bones: BONES, ...input }));
    expect(code({ bones: [] })).toBe('BAD_VALUE'); // nothing to search
    expect(code({ bones: [{ bone: 'a' }, { bone: 'a' }] })).toBe('BAD_VALUE');
    expect(code({ bones: [{ bone: '' }] })).toBe('BAD_VALUE');
    expect(code({ bones: [{ bone: 'a', min: 5, max: 4 }] })).toBe('BAD_VALUE');
    expect(code({ bones: [{ bone: 'a', min: 6, max: 9 }], quantum: 5 })).toBe('BAD_VALUE');
    expect(code({ bones: [{ bone: 'a', min: Number.NaN }] })).toBe('BAD_VALUE');
    expect(code({ quantum: 0.3 })).toBe('BAD_QUANTUM');
    expect(code({ maxRenders: 0 })).toBe('BAD_VALUE');
    expect(code({ restarts: -1 })).toBe('BAD_VALUE');
    expect(code({ restarts: 1.5 })).toBe('BAD_VALUE');
    expect(code({ seed: 0.5 })).toBe('BAD_VALUE');
    expect(code({ variants: [{ part: 'p', choices: [] }] })).toBe('BAD_VALUE');
    expect(code({ variants: [{ part: 'p', choices: ['a'], start: 'b' }] })).toBe('BAD_VALUE');
    expect(
      code({
        variants: [
          { part: 'p', choices: ['a'] },
          { part: 'p', choices: ['a'] },
        ],
      }),
    ).toBe('BAD_VALUE');
    expect(render).not.toHaveBeenCalled();
  });

  it('refuses a renderer that returns another size than the target', () => {
    const small: FitImage = { width: 1, height: 1, data: new Uint8Array(4) };
    expect(
      errorCode(() =>
        fitPose({
          target: renderArm({ angles: {}, variants: {} }),
          render: () => small,
          bones: BONES,
          seed: 1,
        }),
      ),
    ).toBe('BAD_VALUE');
  });

  it('passes a renderer error on', () => {
    expect(() =>
      fitPose({
        target: renderArm({ angles: {}, variants: {} }),
        render: () => {
          throw new Error('boom');
        },
        bones: BONES,
        seed: 1,
      }),
    ).toThrow('boom');
  });
});

describe('fitPose: determinism (ADR-010)', () => {
  const canonical = (results: readonly FitPoseResult[]): string => JSON.stringify(results);

  it('gives the same result for the same seed, and the seed steers the restarts', () => {
    const c = caseAt(0);
    const a = run({ ...c, seed: 1 }).result;
    expect(run({ ...c, seed: 1 }).result).toEqual(a);
    const b = run({ ...c, seed: 99 }).result;
    expect(run({ ...c, seed: 99 }).result).toEqual(b);
    expect([a.exact, b.exact]).toEqual([true, true]);
    expect(b.renders).not.toBe(a.renders);
    // The start pose and the first descent do not use the seed: a problem the first descent solves
    // gives the same result for every seed.
    const first = (seed: number): FitPoseResult => run({ ...c, seed }, { restarts: 0 }).result;
    expect(first(1)).toEqual(first(99));
  });

  it('matches the committed hash of the results of the case table', () => {
    const results = CASES.map((c) => run(c).result);
    const hash = createHash('sha256').update(canonical(results)).digest('hex');
    expect(hash).toBe('ffcab6ee3d487139c6f6e64abaa6d23410b020967b1d5768ed46a2c883cd1956');
  });

  it('uses no Math.random, no clock and no trig', () => {
    const banned = ['random', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos'] as const;
    for (const n of banned) {
      vi.spyOn(Math, n).mockImplementation(() => {
        throw new Error(`Math.${n} called in the search`);
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called in the search');
    });
    // The renderer is a function the caller passes in: here a trig-free stub that draws a dot whose
    // position is the angle, so only the search itself is exercised.
    const dot = (p: FitPoseCandidate): FitImage => {
      const data = new Uint8Array(W * H * 4);
      const x = Math.trunc(((p.angles.a ?? 0) + 180) / 8);
      const o = (5 * W + x) * 4;
      data.set([255, 0, 0, 255], o);
      return { width: W, height: H, data };
    };
    const result = fitPose({
      target: dot({ angles: { a: 64 }, variants: {} }),
      render: dot,
      bones: [{ bone: 'a' }],
      seed: 12345,
      restarts: 4,
    });
    expect(result.error).toBe(0);
    expect(Math.trunc(((result.angles.a ?? 0) + 180) / 8)).toBe(30);
  });
});
