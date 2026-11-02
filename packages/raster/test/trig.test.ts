import { describe, expect, it } from 'vitest';
import {
  ANGLE_STEPS,
  ANGLE_STEP_DEG,
  MAX_ROTATE_COORD,
  MAX_ROUND_Q16,
  Q16,
  RasterError,
  angleToStep,
  cosQ16,
  rotatePoint,
  rotatePointQ16,
  roundQ16,
  sinQ16,
} from '../src/index.js';
import { QUARTER_SIN_Q16 } from '../src/trig-table.js';

/** The committed generator (exact BigInt maths), loaded by URL so TypeScript does not resolve it. */
interface TrigGenerator {
  exactSinQ16(k: number): { value: number; tieDistance: number };
  quarterSinQ16(): { values: number[]; minTieDistance: number };
}
const GENERATOR = new URL('../scripts/gen-trig-table.mjs', import.meta.url).href;
const gen = (await import(GENERATOR)) as TrigGenerator;

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof RasterError ? e.code : 'other';
  }
  return undefined;
};

/** Every table angle, as degrees. */
const ALL_STEPS = Array.from({ length: ANGLE_STEPS }, (_, k) => k);
const deg = (k: number): number => k * ANGLE_STEP_DEG;

describe('trig table', () => {
  it('the committed quarter wave is exactly what the generator computes', () => {
    const { values, minTieDistance } = gen.quarterSinQ16();
    expect(QUARTER_SIN_Q16).toEqual(values);
    expect(QUARTER_SIN_Q16).toHaveLength(361);
    // No entry is anywhere near a rounding tie, so the rounding mode never decides a table value.
    expect(minTieDistance).toBeGreaterThan(0.001);
  });

  it('all 1440 runtime entries equal a direct exact evaluation (no symmetry used by the oracle)', () => {
    for (const k of ALL_STEPS) {
      expect(sinQ16(deg(k))).toBe(gen.exactSinQ16(k).value);
      expect(cosQ16(deg(k))).toBe(gen.exactSinQ16(k + 360).value);
    }
  });

  it('agrees with an independent float64 Math.sin/Math.cos path at every entry', () => {
    // Float64 error is ~1e-11 after scaling, far below the 0.0018 minimum distance to a tie.
    for (const k of ALL_STEPS) {
      const r = (k * Math.PI) / 720;
      expect(sinQ16(deg(k))).toBe(Math.round(Math.sin(r) * Q16) + 0);
      expect(cosQ16(deg(k))).toBe(Math.round(Math.cos(r) * Q16) + 0);
    }
  });

  it('spot values (hand-checked)', () => {
    expect(sinQ16(0)).toBe(0);
    expect(sinQ16(30)).toBe(32768);
    expect(sinQ16(90)).toBe(65536);
    expect(sinQ16(180)).toBe(0);
    expect(sinQ16(270)).toBe(-65536);
    expect(sinQ16(-30)).toBe(-32768);
    expect(sinQ16(150)).toBe(32768);
    expect(cosQ16(0)).toBe(65536);
    expect(cosQ16(60)).toBe(32768);
    expect(cosQ16(90)).toBe(0);
    expect(cosQ16(180)).toBe(-65536);
    expect(sinQ16(45)).toBe(46341); // 46340.95
    expect(cosQ16(45)).toBe(46341);
    expect(sinQ16(0.25)).toBe(286); // 285.95
    expect(sinQ16(1)).toBe(1144); // 1143.73
    expect(Object.is(sinQ16(-0), 0)).toBe(true);
    expect(Object.is(sinQ16(-180), 0)).toBe(true);
  });

  it('symmetry identities hold exactly at every entry', () => {
    for (const k of ALL_STEPS) {
      const x = deg(k);
      expect(sinQ16(-x)).toBe(-sinQ16(x) + 0);
      expect(sinQ16(180 - x)).toBe(sinQ16(x));
      expect(sinQ16(x + 180)).toBe(-sinQ16(x) + 0);
      expect(sinQ16(x + 360)).toBe(sinQ16(x));
      expect(sinQ16(x - 720)).toBe(sinQ16(x));
      expect(cosQ16(x)).toBe(sinQ16(x + 90));
      expect(cosQ16(-x)).toBe(cosQ16(x));
      expect(cosQ16(x)).toBe(sinQ16(90 - x));
    }
  });

  it('sin² + cos² is 65536² within |sin| + |cos| + ½ (each entry is off by at most ½)', () => {
    let worst = 0;
    for (const k of ALL_STEPS) {
      const s = sinQ16(deg(k));
      const c = cosQ16(deg(k));
      const err = Math.abs(s * s + c * c - Q16 * Q16);
      expect(err).toBeLessThanOrEqual(Math.abs(s) + Math.abs(c) + 0.5);
      worst = Math.max(worst, err);
    }
    // Documented tolerance: ≤ 92683 = 2.16e-5 relative (measured worst: 89466).
    expect(worst).toBeLessThanOrEqual(92683);
    expect(worst).toBeGreaterThan(0);
  });

  it('is monotonic on the first quadrant', () => {
    for (let k = 1; k <= 360; k++) expect(sinQ16(deg(k))).toBeGreaterThan(sinQ16(deg(k - 1)));
  });
});

describe('angle validation', () => {
  it('angleToStep reduces any multiple of 0.25° to 0..1439', () => {
    expect(angleToStep(0)).toBe(0);
    expect(angleToStep(0.25)).toBe(1);
    expect(angleToStep(-0.25)).toBe(1439);
    expect(angleToStep(360)).toBe(0);
    expect(angleToStep(720.5)).toBe(2);
    expect(angleToStep(-90)).toBe(1080);
    expect(Object.is(angleToStep(-0), 0)).toBe(true);
    expect(Object.is(angleToStep(-360), 0)).toBe(true);
    expect(sinQ16(3600.25)).toBe(sinQ16(0.25));
  });

  it('rejects angles that are not finite multiples of 0.25° with a typed error', () => {
    for (const bad of [0.1, 1 / 3, 0.125, Number.NaN, Infinity, -Infinity, 1e300]) {
      expect(code(() => sinQ16(bad))).toBe('BAD_VALUE');
      expect(code(() => cosQ16(bad))).toBe('BAD_VALUE');
      expect(code(() => rotatePoint(1, 0, bad))).toBe('BAD_VALUE');
    }
  });
});

describe('roundQ16 (half away from zero)', () => {
  it('hand-written values', () => {
    expect(roundQ16(0)).toBe(0);
    expect(roundQ16(32767)).toBe(0);
    expect(roundQ16(32768)).toBe(1);
    expect(roundQ16(-32768)).toBe(-1);
    expect(roundQ16(98304)).toBe(2); // 1.5
    expect(roundQ16(-98304)).toBe(-2);
    expect(roundQ16(98303)).toBe(1);
    expect(roundQ16(65536 * 7)).toBe(7);
    expect(Object.is(roundQ16(-32767), 0)).toBe(true);
  });

  it('matches an exact BigInt rounding on a sweep around the ties', () => {
    const ref = (v: number): number => {
      const b = BigInt(v);
      const a = b < 0n ? -b : b;
      const r = (2n * a + 65536n) / 131072n;
      return Number(b < 0n ? -r : r);
    };
    for (let n = -5; n <= 5; n++) {
      for (let off = -3; off <= 3; off++) {
        const v = n * 65536 + 32768 + off;
        expect(roundQ16(v)).toBe(ref(v) + 0);
      }
    }
    expect(roundQ16(2 ** 52 + 32768)).toBe(ref(2 ** 52 + 32768));
  });

  it('rejects non-integers', () => {
    expect(code(() => roundQ16(0.5))).toBe('NON_INTEGER');
    expect(code(() => roundQ16(Number.NaN))).toBe('NON_INTEGER');
    expect(code(() => roundQ16(Number.POSITIVE_INFINITY))).toBe('NON_INTEGER');
  });

  it('is exact up to MAX_ROUND_Q16 = 2^53 - 32768 and throws BAD_VALUE beyond', () => {
    const exact = (v: number): number => {
      const b = BigInt(v);
      const a = b < 0n ? -b : b;
      const r = (2n * a + 65536n) / 131072n;
      return Number(b < 0n ? -r : r);
    };
    expect(MAX_ROUND_Q16).toBe(2 ** 53 - 32768);
    // At the limit v + 32768 = 2^53 is still exact: v / 65536 = 2^37 - 1/2 rounds away to 2^37.
    expect(roundQ16(MAX_ROUND_Q16)).toBe(2 ** 37);
    expect(roundQ16(-MAX_ROUND_Q16)).toBe(-(2 ** 37));
    for (let off = 0; off < 40; off++) {
      for (const v of [MAX_ROUND_Q16 - off, -(MAX_ROUND_Q16 - off)]) {
        expect(roundQ16(v), String(v)).toBe(exact(v) + 0);
      }
    }
    // One more would make v + 32768 = 2^53 + 1, which doubles cannot represent (it rounds to 2^53).
    expect(2 ** 53 + 1).toBe(2 ** 53);
    expect(code(() => roundQ16(MAX_ROUND_Q16 + 1))).toBe('BAD_VALUE');
    expect(code(() => roundQ16(-MAX_ROUND_Q16 - 1))).toBe('BAD_VALUE');
    expect(code(() => roundQ16(Number.MAX_SAFE_INTEGER))).toBe('BAD_VALUE');
    expect(code(() => roundQ16(2 ** 60))).toBe('BAD_VALUE');
    expect(code(() => roundQ16(-(2 ** 60)))).toBe('BAD_VALUE');
  });
});

describe('rotatePoint / rotatePointQ16', () => {
  it('follows the screen convention: 0° = +x, clockwise with y down', () => {
    expect(rotatePoint(1, 0, 90)).toEqual([0, 1]); // right turns to down
    expect(rotatePoint(0, 1, 90)).toEqual([-1, 0]); // down turns to left
    expect(rotatePoint(1, 0, 180)).toEqual([-1, 0]);
    expect(rotatePoint(1, 0, -90)).toEqual([0, -1]);
    expect(rotatePoint(3, 4, 0)).toEqual([3, 4]);
    expect(rotatePoint(3, 4, 360)).toEqual([3, 4]);
    expect(rotatePoint(3, 4, 270)).toEqual([4, -3]);
  });

  it('hand-computed roundings', () => {
    expect(rotatePoint(10, 0, 30)).toEqual([9, 5]); // (8.660, 5.000)
    expect(rotatePoint(2, 0, 45)).toEqual([1, 1]); // (1.414, 1.414)
    expect(rotatePoint(5, 5, 45)).toEqual([0, 7]); // (0, 7.071)
    expect(rotatePoint(0, -7, 60)).toEqual([6, -4]); // (6.062, -3.5): -3.5 rounds away from zero
    expect(rotatePoint(1, 0, 30)).toEqual([1, 1]); // (0.866, exactly 0.5 in Q16) -> tie away from zero
    expect(rotatePoint(-1, 0, 30)).toEqual([-1, -1]);
  });

  it('the Q16 variant is the exact integer product with the table', () => {
    expect(rotatePointQ16(1, 0, 30)).toEqual([56756, 32768]);
    expect(rotatePointQ16(1, 0, 90)).toEqual([0, 65536]);
    for (const [dx, dy, a] of [
      [7, -3, 12.25],
      [-20, 11, 271.5],
      [0, 0, 33],
    ] as const) {
      const c = cosQ16(a);
      const s = sinQ16(a);
      expect(rotatePointQ16(dx, dy, a)).toEqual([c * dx - s * dy + 0, s * dx + c * dy + 0]);
      const [qx, qy] = rotatePointQ16(dx, dy, a);
      expect(rotatePoint(dx, dy, a)).toEqual([roundQ16(qx), roundQ16(qy)]);
    }
  });

  it('agrees with an independent float64 reference except near .5 boundaries (documented)', () => {
    // Oracle: round half away from zero of dx·cos θ − dy·sin θ in float64. The fixed-point result may
    // differ only where the true value is within the table's quantisation error of a .5 boundary:
    // |C/65536 − cos θ| ≤ 1/131072, so the error is ≤ (|dx| + |dy|) / 131072. Exact ties (Q16 value
    // ≡ 32768 mod 65536) are a subset: there float64 lands on either side of .5 by its own rounding.
    const rha = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(0.5 - v)) + 0;
    const N = 24;
    let disagreements = 0;
    let exactTies = 0;
    let cases = 0;
    for (const k of ALL_STEPS) {
      const t = (k * Math.PI) / 720;
      const co = Math.cos(t);
      const si = Math.sin(t);
      for (let dx = -N; dx <= N; dx++) {
        for (let dy = -N; dy <= N; dy++) {
          const got = rotatePoint(dx, dy, deg(k));
          const q = rotatePointQ16(dx, dy, deg(k));
          const f = [dx * co - dy * si, dx * si + dy * co];
          for (let i = 0; i < 2; i++) {
            cases++;
            const fi = f[i] ?? 0;
            if (got[i] === rha(fi)) continue;
            disagreements++;
            if (Math.abs(q[i] ?? 0) % Q16 === 32768) exactTies++;
            const distToHalf = Math.abs(Math.abs(fi - Math.trunc(fi)) - 0.5);
            expect(distToHalf).toBeLessThanOrEqual((Math.abs(dx) + Math.abs(dy)) / 131072);
          }
        }
      }
    }
    // 1440 angles × 49² offsets × 2 coordinates: about 1 in 10 000 coordinates is a near-tie.
    expect(cases).toBe(1440 * 49 * 49 * 2);
    expect(disagreements).toBeLessThan(cases / 5000);
    expect(exactTies).toBeGreaterThan(0);
  });

  it('validates offsets', () => {
    expect(code(() => rotatePoint(0.5, 0, 0))).toBe('NON_INTEGER');
    expect(code(() => rotatePointQ16(0, Number.NaN, 0))).toBe('NON_INTEGER');
    expect(code(() => rotatePoint(MAX_ROTATE_COORD + 1, 0, 0))).toBe('BAD_VALUE');
    expect(rotatePoint(MAX_ROTATE_COORD, -MAX_ROTATE_COORD, 90)).toEqual([
      MAX_ROTATE_COORD,
      MAX_ROTATE_COORD,
    ]);
  });
});
