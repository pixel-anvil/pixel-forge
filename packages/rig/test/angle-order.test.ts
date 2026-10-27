import { describe, expect, it } from 'vitest';
import { boneOrder, normalizeAngle, quantizeAngle } from '../src/index.js';
import { bone, errorCode, makeRig, prng } from './helpers.js';

describe('quantizeAngle', () => {
  it('rounds to the nearest multiple of the quantum, half away from zero', () => {
    expect(quantizeAngle(0.5)).toBe(1);
    expect(quantizeAngle(-0.5)).toBe(-1);
    expect(quantizeAngle(0.49999999999999994)).toBe(0); // the double just below 0.5
    expect(quantizeAngle(1.5)).toBe(2);
    expect(quantizeAngle(2.5)).toBe(3); // not to even
    expect(quantizeAngle(-30.4)).toBe(-30); // not normalised
    expect(quantizeAngle(7.5, 5)).toBe(10);
    expect(quantizeAngle(-7.5, 5)).toBe(-10);
    expect(quantizeAngle(7.4, 5)).toBe(5);
    expect(quantizeAngle(0.125, 0.25)).toBe(0.25);
    expect(quantizeAngle(33.75, 22.5)).toBe(45);
    expect(quantizeAngle(370, 90)).toBe(360);
    expect(Object.is(quantizeAngle(-0.2), 0)).toBe(true); // never -0
  });

  it('uses the exact binary value of the double', () => {
    // With quantum 0.25 the tie between 0.25 and 0.5 is 0.375 (exact in binary); the double just
    // below it rounds down. No float division is involved, so no ulp can tip the result.
    expect(quantizeAngle(0.375, 0.25)).toBe(0.5);
    expect(quantizeAngle(0.37499999999999994, 0.25)).toBe(0.25);
    expect(quantizeAngle(1e15 + 0.5)).toBe(1e15 + 1);
  });

  it('is odd: quantizeAngle(-x) = -quantizeAngle(x)', () => {
    const rand = prng(7);
    for (let i = 0; i < 2000; i++) {
      const x = (rand() - 0.5) * 2000;
      for (const q of [0.25, 1, 22.5]) expect(quantizeAngle(-x, q)).toBe(-quantizeAngle(x, q) + 0);
    }
  });

  it('rejects bad quanta and bad angles', () => {
    for (const q of [0, -1, 0.1, 0.3, 7, 91, 180, Number.NaN]) {
      expect(errorCode(() => quantizeAngle(1, q))).toBe('BAD_QUANTUM');
    }
    expect(errorCode(() => quantizeAngle(Number.POSITIVE_INFINITY))).toBe('BAD_VALUE');
    expect(errorCode(() => quantizeAngle(Number.NaN))).toBe('BAD_VALUE');
    expect(errorCode(() => quantizeAngle(2 ** 52))).toBe('BAD_VALUE');
    expect(quantizeAngle(2 ** 50)).toBe(2 ** 50);
  });
});

describe('normalizeAngle', () => {
  it('reduces into [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(-30)).toBe(330);
    expect(normalizeAngle(-720.25)).toBe(359.75);
    expect(normalizeAngle(1080.5)).toBe(0.5);
    expect(normalizeAngle(-1e-20)).toBe(0); // 360 - 1e-20 rounds to 360
    expect(errorCode(() => normalizeAngle(Number.NaN))).toBe('BAD_VALUE');
  });
});

describe('boneOrder', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(bone) as [
    ReturnType<typeof bone>,
    ReturnType<typeof bone>,
    ReturnType<typeof bone>,
    ReturnType<typeof bone>,
    ReturnType<typeof bone>,
  ];

  it('is depth-first pre-order with roots and siblings sorted by id', () => {
    const rig = makeRig([[e, b], [d], [c, b], [b, d], [a, d]]);
    // roots: d. d's children: a, b (sorted). b's children: c, e.
    expect(boneOrder(rig)).toEqual([d, a, b, c, e]);
    expect(boneOrder(makeRig([[c], [a], [b, c]]))).toEqual([a, c, b]);
    expect(boneOrder(makeRig([]))).toEqual([]);
  });

  it('puts every parent before its children and does not depend on input order', () => {
    const rand = prng(3);
    for (let n = 0; n < 200; n++) {
      const ids = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) =>
        bone(`n${String(i)}`),
      );
      const pairs = ids.map((id, i): [typeof id, (typeof id | undefined)?] =>
        i === 0 || rand() < 0.2 ? [id] : [id, ids[Math.floor(rand() * i)]],
      );
      const order = boneOrder(makeRig(pairs));
      const pos = new Map(order.map((id, i) => [id, i]));
      expect(order).toHaveLength(ids.length);
      for (const [id, parent] of pairs) {
        if (parent !== undefined) expect(pos.get(parent)).toBeLessThan(pos.get(id) ?? -1);
      }
      expect(boneOrder(makeRig([...pairs].reverse()))).toEqual(order);
    }
  });

  it('compares ids by code unit, not locale', () => {
    const upper = 'bon_B' as ReturnType<typeof bone>; // 'B' (0x42) sorts before 'a' (0x61)
    expect(boneOrder(makeRig([[a], [upper]]))).toEqual([upper, a]);
  });

  it('rejects duplicate ids, unknown parents and cycles (I1)', () => {
    expect(errorCode(() => boneOrder(makeRig([[a], [a]])))).toBe('DUPLICATE_BONE');
    expect(errorCode(() => boneOrder(makeRig([[a, b]])))).toBe('UNKNOWN_BONE');
    expect(errorCode(() => boneOrder(makeRig([[a, a]])))).toBe('CYCLE');
    expect(errorCode(() => boneOrder(makeRig([[a, b], [b, c], [c, a], [d]])))).toBe('CYCLE');
    // A tree hanging off a cycle is unreachable too.
    expect(errorCode(() => boneOrder(makeRig([[a, b], [b, a], [c, a], [d]])))).toBe('CYCLE');
  });

  it('handles a deep chain without recursion', () => {
    const ids = Array.from({ length: 20000 }, (_, i) => bone(`c${String(i)}`));
    const rig = makeRig(ids.map((id, i) => (i === 0 ? [id] : [id, ids[i - 1]])));
    expect(boneOrder(rig)).toEqual(ids);
  });
});
