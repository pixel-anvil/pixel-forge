/**
 * Oracle (d): interpolation tables written by hand. Every expected value below was computed on paper
 * from the rules in the README (index-based t = i/n, previous key's interp, smoothstep 3t² − 2t³,
 * hold or loop wrap, one rounding half away from zero), not by running the code.
 */
import type { BoneKey, LoopMode } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  evaluatePose,
  interpWeight,
  keySpan,
  prepareAnimation,
  resolvePose,
  type PoseAnimation,
} from '../src/index.js';
import { bone, errorCode, frameId, makeAnim, makeRig, prng, randomCase } from './helpers.js';

const A = bone('a');
const B = bone('b');
const rig = makeRig([[A], [B, A]]);

/** One animation keyed only on bone A: `{frame: key}`. */
function animA(
  count: number,
  keys: Readonly<Record<number, BoneKey>>,
  loop: LoopMode = 'once',
  angleQuantum?: number,
): PoseAnimation {
  const byFrame: Record<number, Partial<Record<typeof A, BoneKey>>> = {};
  for (const [f, k] of Object.entries(keys)) byFrame[Number(f)] = { [A]: k };
  return makeAnim(count, byFrame, loop, angleQuantum);
}

const angles = (anim: PoseAnimation, opts = {}): number[] =>
  anim.frames.map((_, f) => resolvePose(rig, anim, f, opts).get(A)?.angle ?? Number.NaN);

describe('angle interpolation tables (hand-written)', () => {
  it('linear, step and ease-in-out between two keys (q = 1)', () => {
    expect(angles(animA(5, { 0: { angle: 0 }, 4: { angle: 10 } }))).toEqual([0, 3, 5, 8, 10]);
    expect(angles(animA(5, { 0: { angle: 0 }, 4: { angle: -10 } }))).toEqual([0, -3, -5, -8, -10]);
    expect(angles(animA(5, { 0: { angle: 0, interp: 'step' }, 4: { angle: 10 } }))).toEqual([
      0, 0, 0, 0, 10,
    ]);
    // smoothstep at t = 1/4, 1/2, 3/4: 10/64, 1/2, 54/64
    expect(angles(animA(5, { 0: { angle: 0, interp: 'ease-in-out' }, 4: { angle: 64 } }))).toEqual([
      0, 10, 32, 54, 64,
    ]);
    // 1.5625 -> 2, 5, 8.4375 -> 8
    expect(angles(animA(5, { 0: { angle: 0, interp: 'ease-in-out' }, 4: { angle: 10 } }))).toEqual([
      0, 2, 5, 8, 10,
    ]);
  });

  it('the previous key decides the interpolation of each segment', () => {
    const anim = animA(5, {
      0: { angle: 0, interp: 'ease-in-out' },
      2: { angle: 10, interp: 'step' },
      4: { angle: 30, interp: 'linear' },
    });
    expect(angles(anim)).toEqual([0, 5, 10, 10, 30]);
  });

  it('holds the nearest key before the first and after the last key (once, pingpong)', () => {
    const keys = { 2: { angle: 20 }, 5: { angle: 50 } };
    expect(angles(animA(8, keys, 'once'))).toEqual([20, 20, 20, 30, 40, 50, 50, 50]);
    expect(angles(animA(8, keys, 'pingpong'))).toEqual([20, 20, 20, 30, 40, 50, 50, 50]);
  });

  it('wraps from the last key to the first across the loop boundary (loop)', () => {
    // After f5 the span runs to f2 + 8 = f10 (n = 5): f6 = 50 - 30/5, f7 = 50 - 60/5, f0 = 50 - 90/5 ...
    expect(angles(animA(8, { 2: { angle: 20 }, 5: { angle: 50 } }, 'loop'))).toEqual([
      32, 26, 20, 30, 40, 50, 44, 38,
    ]);
    // Same with an eased wrap segment: smoothstep(0.2, 0.4, 0.6, 0.8) = 0.104, 0.352, 0.648, 0.896
    // 50 - 30w = 46.88, 39.44, 30.56, 23.12
    const eased = { 2: { angle: 20 }, 5: { angle: 50, interp: 'ease-in-out' as const } };
    expect(angles(animA(8, eased, 'loop'))).toEqual([31, 23, 20, 30, 40, 50, 47, 39]);
  });

  it('a single key holds everywhere, looping or not; no key is the rest value', () => {
    expect(angles(animA(6, { 3: { angle: 12.4 } }, 'loop'))).toEqual([12, 12, 12, 12, 12, 12]);
    expect(angles(animA(6, { 3: { angle: 12.4 } }, 'once'))).toEqual([12, 12, 12, 12, 12, 12]);
    expect(angles(animA(3, {}, 'loop'))).toEqual([0, 0, 0]);
    const onlyB = makeAnim(2, { 0: { [B]: { angle: 40 } } });
    expect(resolvePose(rig, onlyB, 0).get(A)).toEqual({
      angle: 0,
      offset: { x: 0, y: 0 },
      flipX: false,
    });
  });

  it('quantises the interpolated value once, to the animation quantum', () => {
    // 0, 3, 6, 9, 12 over q = 5: 0, 0.6, 1.2, 1.8, 2.4 quanta
    expect(angles(animA(5, { 0: { angle: 0 }, 4: { angle: 12 } }, 'once', 5))).toEqual([
      0, 5, 5, 10, 10,
    ]);
    // 0, 1/3, 2/3, 1 over q = 0.25: 0, 1.33, 2.67, 4 quanta
    expect(angles(animA(4, { 0: { angle: 0 }, 3: { angle: 1 } }, 'once', 0.25))).toEqual([
      0, 0.25, 0.75, 1,
    ]);
    // 7.5 -> 10 and -7.5 -> -10 (half away from zero) at q = 5; opts override the animation.
    const tie = animA(3, { 0: { angle: 0 }, 2: { angle: 15 } }, 'once', 5);
    expect(angles(tie)).toEqual([0, 10, 15]);
    expect(angles(tie, { angleQuantum: 1 })).toEqual([0, 8, 15]);
    expect(angles(animA(3, { 0: { angle: 0 }, 2: { angle: -15 } }, 'once', 5))).toEqual([
      0, -10, -15,
    ]);
    // Missing angleQuantum is 1 degree.
    expect(angles(animA(3, { 0: { angle: 0.4 }, 2: { angle: 0.6 } }))).toEqual([0, 1, 1]);
  });

  it('interpolates exactly, not in floating point', () => {
    // Float64 gives 0.3 + (0.7 - 0.3) / 2 = 0.5, a tie that rounds to 1. The doubles 0.3 and 0.7 are
    // 0.29999999999999998890 and 0.69999999999999995559, so the exact midpoint is
    // 0.49999999999999997224, which rounds to 0.
    expect(angles(animA(3, { 0: { angle: 0.3 }, 2: { angle: 0.7 } }))).toEqual([0, 0, 1]);
    expect(0.3 + (0.7 - 0.3) / 2).toBe(0.5);
  });

  it('keeps multi-turn angles: no wrap, no shortest path', () => {
    expect(angles(animA(5, { 0: { angle: 0 }, 4: { angle: 720 } }))).toEqual([
      0, 180, 360, 540, 720,
    ]);
    expect(angles(animA(3, { 0: { angle: 350 }, 2: { angle: 10 } }))).toEqual([350, 180, 10]);
  });

  it('negating every key angle negates every resolved angle exactly', () => {
    const rand = prng(11);
    for (let n = 0; n < 150; n++) {
      const c = randomCase(rand);
      const neg: PoseAnimation = {
        ...c.anim,
        frames: c.anim.frames.map((fr) => ({
          id: fr.id,
          boneKeys: Object.fromEntries(
            Object.entries(fr.boneKeys).map(([id, k]) => [
              id,
              k?.angle === undefined ? k : { ...k, angle: -k.angle },
            ]),
          ),
        })),
      };
      for (let f = 0; f < c.anim.frames.length; f++) {
        const a = resolvePose(c.rig, c.anim, f);
        const b = resolvePose(c.rig, neg, f);
        for (const [id, k] of a) expect(b.get(id)?.angle).toBe(-k.angle + 0);
      }
    }
  });
});

describe('offset and flipX channels (hand-written)', () => {
  it('interpolates offsets per axis and rounds half away from zero', () => {
    const anim = animA(5, { 0: { offset: { x: 0, y: 0 } }, 4: { offset: { x: 3, y: -3 } } });
    // x: 0, .75, 1.5, 2.25, 3   y: the negatives
    const xs = anim.frames.map((_, f) => resolvePose(rig, anim, f).get(A)?.offset);
    expect(xs).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 2, y: -2 },
      { x: 2, y: -2 },
      { x: 3, y: -3 },
    ]);
    const ease = animA(3, {
      0: { offset: { x: 0, y: 1 }, interp: 'ease-in-out' },
      2: { offset: { x: 4, y: 2 } },
    });
    expect(resolvePose(rig, ease, 1).get(A)?.offset).toEqual({ x: 2, y: 2 }); // 1.5 -> 2
  });

  it('flipX always steps: hold, then wrap in a loop', () => {
    const keys = { 1: { flipX: true, interp: 'linear' as const }, 3: { flipX: false } };
    const flips = (loop: LoopMode): boolean[] => {
      const anim = animA(6, keys, loop);
      return anim.frames.map((_, f) => resolvePose(rig, anim, f).get(A)?.flipX ?? false);
    };
    expect(flips('once')).toEqual([true, true, true, false, false, false]);
    expect(flips('loop')).toEqual([false, true, true, false, false, false]);
  });

  it('resolves each channel over the frames that key it', () => {
    const anim = animA(5, {
      0: { angle: 0 },
      2: { offset: { x: 5, y: 0 }, interp: 'step' }, // does not interrupt the angle channel
      4: { angle: 40, flipX: true },
    });
    const at = (f: number) => resolvePose(rig, anim, f).get(A);
    expect(at(1)).toEqual({ angle: 10, offset: { x: 5, y: 0 }, flipX: true });
    expect(at(2)).toEqual({ angle: 20, offset: { x: 5, y: 0 }, flipX: true });
    expect(at(3)).toEqual({ angle: 30, offset: { x: 5, y: 0 }, flipX: true });
  });

  it('accepts a frame id or a frame index and returns every bone in bone order', () => {
    const anim = animA(3, { 0: { angle: 0 }, 2: { angle: 20 } });
    expect(resolvePose(rig, anim, frameId(1)).get(A)?.angle).toBe(10);
    expect([...resolvePose(rig, anim, 1).keys()]).toEqual([A, B]);
  });
});

describe('keySpan and interpWeight', () => {
  it('spans', () => {
    expect(keySpan([], 0, 4, true)).toBeUndefined();
    expect(keySpan([1, 3], 1, 4, false)).toEqual({ from: 1, to: 1, i: 0, n: 0 });
    expect(keySpan([1, 3], 2, 4, false)).toEqual({ from: 1, to: 3, i: 1, n: 2 });
    expect(keySpan([1, 3], 0, 4, false)).toEqual({ from: 1, to: 1, i: 0, n: 0 });
    expect(keySpan([1, 3], 0, 4, true)).toEqual({ from: 3, to: 1, i: 1, n: 2 });
    expect(keySpan([1], 3, 4, true)).toEqual({ from: 1, to: 1, i: 2, n: 4 });
    expect(keySpan([1], 0, 4, true)).toEqual({ from: 1, to: 1, i: 3, n: 4 });
  });

  it('rejects bad input', () => {
    expect(errorCode(() => keySpan([0], 0, 0, false))).toBe('BAD_VALUE');
    expect(errorCode(() => keySpan([0], 4, 4, false))).toBe('BAD_VALUE');
    expect(errorCode(() => keySpan([0], 0.5, 4, false))).toBe('BAD_VALUE');
    expect(errorCode(() => keySpan([2, 1], 0, 4, false))).toBe('BAD_VALUE');
    expect(errorCode(() => keySpan([1, 1], 0, 4, false))).toBe('BAD_VALUE');
    expect(errorCode(() => keySpan([4], 0, 4, false))).toBe('BAD_VALUE');
  });

  it('weights', () => {
    expect(interpWeight('step', 1, 2)).toEqual([0n, 1n]);
    expect(interpWeight('linear', 1, 3)).toEqual([1n, 3n]);
    expect(interpWeight('linear', 0, 3)).toEqual([0n, 1n]);
    expect(interpWeight('ease-in-out', 1, 4)).toEqual([10n, 64n]);
    expect(interpWeight('ease-in-out', 2, 4)).toEqual([32n, 64n]);
    expect(interpWeight('linear', 3, 3)).toEqual([3n, 3n]);
    expect(interpWeight('ease-in-out', 4, 4)).toEqual([64n * 1n, 64n]); // 16 * (12 - 8) = 64
    expect(interpWeight('step', 2, 4)).toEqual([0n, 1n]);
  });

  it('rejects an unknown interp and an impossible position (BAD_VALUE)', () => {
    expect(errorCode(() => interpWeight('cubic' as BoneKey['interp'] & string, 1, 2))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => interpWeight('linear', 0, 0))).toBe('BAD_VALUE'); // n <= 0
    expect(errorCode(() => interpWeight('linear', 0, -2))).toBe('BAD_VALUE');
    expect(errorCode(() => interpWeight('linear', -1, 4))).toBe('BAD_VALUE'); // i < 0
    expect(errorCode(() => interpWeight('ease-in-out', 5, 4))).toBe('BAD_VALUE'); // i > n
    expect(errorCode(() => interpWeight('step', 5, 4))).toBe('BAD_VALUE'); // even for step
    expect(errorCode(() => interpWeight('linear', 0.5, 4))).toBe('BAD_VALUE');
    expect(errorCode(() => interpWeight('linear', 1, Number.NaN))).toBe('BAD_VALUE');
  });
});

describe('resolvePose validation', () => {
  const ok = animA(2, { 0: { angle: 1 } });
  it('rejects unknown frames and bones', () => {
    expect(errorCode(() => resolvePose(rig, ok, frameId(9)))).toBe('UNKNOWN_FRAME');
    expect(errorCode(() => resolvePose(rig, ok, 2))).toBe('UNKNOWN_FRAME');
    expect(errorCode(() => resolvePose(rig, ok, -1))).toBe('UNKNOWN_FRAME');
    const stray = makeAnim(2, { 1: { [bone('zz')]: { angle: 1 } } });
    expect(errorCode(() => resolvePose(rig, stray, 0))).toBe('UNKNOWN_BONE');
    expect(errorCode(() => resolvePose(makeRig([[A, A]]), ok, 0))).toBe('CYCLE');
  });

  it('checks every key, not only the ones used by the frame', () => {
    const bad = (k: object) => animA(3, { 0: { angle: 1 }, 2: k });
    expect(errorCode(() => resolvePose(rig, bad({ angle: Number.NaN }), 0))).toBe('BAD_VALUE');
    expect(errorCode(() => resolvePose(rig, bad({ offset: { x: 0.5, y: 0 } }), 0))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => resolvePose(rig, bad({ offset: { x: 0, y: 2 ** 32 } }), 0))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => resolvePose(rig, bad({ angle: 1, interp: 'cubic' }), 0))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => resolvePose(rig, bad({ angle: 1e300 }), 2))).toBe('BAD_VALUE');
    expect(errorCode(() => resolvePose(rig, ok, 0, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
    expect(errorCode(() => resolvePose(rig, { ...ok, angleQuantum: 0.1 }, 0))).toBe('BAD_QUANTUM');
  });

  it('an invalid key at frame 2 makes every frame throw, not only the frames that use it', () => {
    // 2^52 degrees quantises to a step count above 2^53: the 2^51 check runs on every key up front.
    const huge = animA(4, { 0: { angle: 1 }, 1: { angle: 2 }, 2: { angle: 2 ** 52 } });
    const huge1 = animA(4, { 0: { angle: 1 }, 3: { angle: 5 }, 2: { angle: 1e300 } });
    for (const a of [huge, huge1]) {
      for (let f = 0; f < 4; f++) {
        expect(errorCode(() => resolvePose(rig, a, f))).toBe('BAD_VALUE');
        expect(errorCode(() => evaluatePose(rig, { rest: {} }, a, f))).toBe('BAD_VALUE');
      }
    }
    // Just below the limit is fine, and so is a big angle that a coarser quantum still represents.
    const ok2 = animA(3, { 0: { angle: 1 }, 2: { angle: 2 ** 50 } });
    for (let f = 0; f < 3; f++) expect(errorCode(() => resolvePose(rig, ok2, f))).toBeUndefined();
    // The check is on the quantised key: 2^51 - 0.25 rounds up to 2^51 at q = 1 but is exact at q = 0.25.
    const edge = animA(3, { 2: { angle: 2 ** 51 - 0.25 } });
    expect(errorCode(() => resolvePose(rig, edge, 0))).toBe('BAD_VALUE');
    expect(errorCode(() => resolvePose(rig, edge, 0, { angleQuantum: 0.25 }))).toBeUndefined();
  });

  it('an undefined-valued key is skipped, an unknown bone is still rejected', () => {
    const anim: PoseAnimation = {
      loop: 'once',
      frames: [{ id: frameId(0), boneKeys: { [bone('zz')]: undefined, [A]: { angle: 3 } } }],
    };
    expect(resolvePose(rig, anim, 0).get(A)?.angle).toBe(3);
  });

  it('ignores prototype keys of a boneKeys record', () => {
    const proto = Object.create({ [A]: { angle: 99 } }) as Record<string, BoneKey>;
    const anim: PoseAnimation = { loop: 'once', frames: [{ id: frameId(0), boneKeys: proto }] };
    expect(resolvePose(rig, anim, 0).get(A)?.angle).toBe(0);
  });
});

describe('prepareAnimation: validate and index once per animation', () => {
  const lerpRig = makeRig([[A], [B, A]]);
  const view = { rest: { [A]: { x: 5, y: 5, angle: 0 }, [B]: { x: 3, y: 0, angle: 0 } } };

  /** Frames whose `boneKeys` count how often the validation pass enumerates them. */
  function counted(count: number): { anim: PoseAnimation; reads: () => number } {
    let n = 0;
    const frames = Array.from({ length: count }, (_, i) => ({
      id: frameId(i),
      boneKeys: new Proxy(i % 3 === 0 ? { [A]: { angle: i * 7 } } : {}, {
        ownKeys(target) {
          n++;
          return Reflect.ownKeys(target);
        },
      }) as Partial<Record<typeof A, BoneKey>>,
    }));
    return { anim: { frames, loop: 'loop' }, reads: () => n };
  }

  it('evaluating all 12 frames of a prepared animation validates the keys once', () => {
    const { anim, reads } = counted(12);
    const prepared = prepareAnimation(lerpRig, anim);
    expect(reads()).toBe(12); // one pass over the 12 frames
    const first = anim.frames.map((_, f) => evaluatePose(lerpRig, view, prepared, f));
    const also = anim.frames.map((_, f) => resolvePose(lerpRig, prepared, f));
    expect(reads()).toBe(12); // still one pass
    expect(also.length).toBe(12);
    // Same results as the unprepared path, which validates on every call (12 more passes per call).
    const plain = anim.frames.map((_, f) => evaluatePose(lerpRig, view, anim, f));
    expect(reads()).toBe(12 + 12 * 12);
    expect(plain).toEqual(first);
  });

  it('a prepared animation is re-prepared for another rig or quantum, never mis-applied', () => {
    const anim = animA(3, { 0: { angle: 0 }, 2: { angle: 12 } });
    const prepared = prepareAnimation(rig, anim);
    expect(resolvePose(rig, prepared, 1).get(A)?.angle).toBe(6);
    expect(resolvePose(rig, prepared, 1, { angleQuantum: 5 }).get(A)?.angle).toBe(5);
    expect(resolvePose(rig, prepared, 1, { angleQuantum: 1 }).get(A)?.angle).toBe(6);
    const other = makeRig([[A]]);
    expect(resolvePose(other, prepared, 1).size).toBe(1);
    expect(errorCode(() => resolvePose(rig, prepared, 1, { angleQuantum: 7 }))).toBe('BAD_QUANTUM');
  });

  it('prepareAnimation itself validates', () => {
    expect(errorCode(() => prepareAnimation(rig, animA(3, { 2: { angle: Number.NaN } })))).toBe(
      'BAD_VALUE',
    );
    expect(errorCode(() => prepareAnimation(rig, animA(3, {}), { angleQuantum: 0.3 }))).toBe(
      'BAD_QUANTUM',
    );
  });
});
