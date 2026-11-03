import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_WORK_COLORS,
  generatePalette,
  srgb8ToOklab,
  type GeneratePaletteOptions,
  type PaletteMethod,
} from '../src/index.js';

type Rgba = readonly [number, number, number, number];

/** RGBA bytes of a list of (colour, count) runs. */
function runs(...spec: readonly (readonly [Rgba, number])[]): Uint8Array {
  const out: number[] = [];
  for (const [c, n] of spec) for (let i = 0; i < n; i++) out.push(c[0], c[1], c[2], c[3]);
  return Uint8Array.from(out);
}

/** A 64x64 test image from an integer generator: smooth gradients plus noise, one alpha 0 column. */
function testImage(): Uint8Array {
  const out = new Uint8Array(64 * 64 * 4);
  let s = 12345;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 16;
  };
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      out[o] = (x * 4 + (rnd() & 15)) & 255;
      out[o + 1] = (y * 4 + (rnd() & 15)) & 255;
      out[o + 2] = ((x + y) * 2 + (rnd() & 31)) & 255;
      out[o + 3] = x === 63 ? 0 : 255;
    }
  }
  return out;
}

const hashOf = (colors: readonly (readonly number[])[]): string =>
  createHash('sha256').update(JSON.stringify(colors)).digest('hex');
const keyOf = (c: readonly number[]): string => c.join(',');

const METHODS: readonly PaletteMethod[] = ['kmeans', 'mediancut'];

describe('generatePalette: known answers', () => {
  const RED: Rgba = [200, 30, 30, 255];
  const GREEN: Rgba = [30, 160, 40, 255];
  const BLUE: Rgba = [30, 40, 210, 255];

  it.each(METHODS)('%s: three flat blocks with n = 3 give exactly those colours', (method) => {
    const r = generatePalette(runs([RED, 50], [GREEN, 30], [BLUE, 20]), { n: 3, method });
    expect(r.exact).toBe(true);
    expect(r.unique).toBe(3);
    expect(r.pixels).toBe(100);
    // darkest first (OKLab lightness): blue, red, green
    expect(r.colors).toEqual([
      [30, 40, 210, 255],
      [200, 30, 30, 255],
      [30, 160, 40, 255],
    ]);
  });

  it.each(METHODS)('%s: three blocks with n = 2 give two distinct image colours', (method) => {
    const r = generatePalette(runs([RED, 50], [GREEN, 30], [BLUE, 20]), { n: 2, method });
    expect(r.exact).toBe(false);
    expect(r.colors).toHaveLength(2);
    expect(new Set(r.colors.map(keyOf)).size).toBe(2);
    const inImage = new Set([RED, GREEN, BLUE].map(keyOf));
    for (const c of r.colors) expect(inImage.has(keyOf(c))).toBe(true);
  });

  it.each(METHODS)('%s: two clusters give the heavier colour of each', (method) => {
    // reds: 60 px of A, 10 px of B; blues: 70 px of C, 5 px of D (equal halves for the median cut)
    const A: Rgba = [200, 30, 30, 255];
    const B: Rgba = [210, 40, 38, 255];
    const C: Rgba = [20, 30, 200, 255];
    const D: Rgba = [30, 40, 210, 255];
    const r = generatePalette(runs([A, 60], [B, 10], [C, 70], [D, 5]), { n: 2, method });
    expect(r.exact).toBe(false);
    expect(r.unique).toBe(4);
    expect(r.colors).toEqual([
      [20, 30, 200, 255],
      [200, 30, 30, 255],
    ]);
  });

  it.each(METHODS)('%s: the result does not depend on pixel order', (method) => {
    const a = runs(
      [[10, 20, 30, 255], 7],
      [[200, 10, 10, 255], 5],
      [[210, 20, 12, 255], 9],
      [[10, 220, 90, 255], 4],
    );
    const b = runs(
      [[10, 220, 90, 255], 4],
      [[210, 20, 12, 255], 9],
      [[10, 20, 30, 255], 7],
      [[200, 10, 10, 255], 5],
    );
    expect(generatePalette(a, { n: 2, method }).colors).toEqual(
      generatePalette(b, { n: 2, method }).colors,
    );
  });
});

describe('generatePalette: seed stability', () => {
  // These hashes pin the output on a fixed image. A change means the result is no longer the same
  // after a refactor; CI on Linux must give the same values (no platform maths is involved).
  const PINNED: Record<PaletteMethod, string> = {
    kmeans: '28e5f4f64439f4275ea50ba3211318f110bf7c25740c0f60124a2a73875afd78',
    mediancut: 'c695b5b76ff7481c144cbea7d9f05d873c3e5ba539d12d2c7f611f38b9bc5940',
  };
  it.each(METHODS)('%s: n = 16 on the fixed image has a pinned hash', (method) => {
    const r = generatePalette(testImage(), { n: 16, method });
    expect(r.colors).toHaveLength(16);
    expect(hashOf(r.colors)).toBe(PINNED[method]);
  });

  it('the same seed gives the same palette, other seeds may differ', () => {
    const img = testImage();
    const a = generatePalette(img, { n: 12, seed: 7 });
    const b = generatePalette(img, { n: 12, seed: 7 });
    expect(a).toEqual(b);
    const seen = new Set<string>();
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      seen.add(hashOf(generatePalette(img, { n: 12, seed }).colors));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('the default seed is 1 and median cut ignores the seed', () => {
    const img = testImage();
    expect(generatePalette(img, { n: 8 })).toEqual(generatePalette(img, { n: 8, seed: 1 }));
    expect(generatePalette(img, { n: 8, method: 'mediancut', seed: 1 }).colors).toEqual(
      generatePalette(img, { n: 8, method: 'mediancut', seed: 99 }).colors,
    );
  });
});

describe('generatePalette: n', () => {
  it.each(METHODS)(
    '%s: n = 2 and n = 256 give n distinct opaque colours, darkest first',
    (method) => {
      const img = testImage();
      for (const n of [2, 256]) {
        const r = generatePalette(img, { n, method });
        expect(r.colors).toHaveLength(n);
        expect(new Set(r.colors.map(keyOf)).size).toBe(n);
        expect(r.colors.every((c) => c[3] === 255)).toBe(true);
        const lights = r.colors.map((c) => srgb8ToOklab(c[0], c[1], c[2]).L);
        expect(lights).toEqual([...lights].sort((a, b) => a - b));
      }
    },
  );

  it.each(METHODS)('%s: n above the unique colours returns the unique colours', (method) => {
    const r = generatePalette(runs([[1, 2, 3, 255], 3], [[200, 200, 200, 255], 1]), {
      n: 50,
      method,
    });
    expect(r).toMatchObject({ exact: true, unique: 2, requested: 50 });
    expect(r.colors).toEqual([
      [1, 2, 3, 255],
      [200, 200, 200, 255],
    ]);
  });

  it('refuses a bad n, seed, minAlpha, method and data', () => {
    const img = runs([[1, 2, 3, 255], 4]);
    expect(() => generatePalette(img, { n: 1 })).toThrow(RangeError);
    expect(() => generatePalette(img, { n: 257 })).toThrow(RangeError);
    expect(() => generatePalette(img, { n: 2.5 })).toThrow(RangeError);
    expect(() => generatePalette(img, { n: 4, seed: -1 })).toThrow(RangeError);
    expect(() => generatePalette(img, { n: 4, seed: 2 ** 32 })).toThrow(RangeError);
    expect(() => generatePalette(img, { n: 4, minAlpha: 0 })).toThrow(RangeError);
    expect(() =>
      generatePalette(img, { n: 4, method: 'x' } as unknown as GeneratePaletteOptions),
    ).toThrow(RangeError);
    expect(() => generatePalette(new Uint8Array(5), { n: 4 })).toThrow(RangeError);
  });
});

describe('generatePalette: alpha', () => {
  it('ignores alpha 0 pixels and reports them', () => {
    const r = generatePalette(runs([[9, 9, 9, 0], 10], [[50, 60, 70, 255], 2]), { n: 4 });
    expect(r).toMatchObject({ pixels: 2, ignored: 10, unique: 1, exact: true });
    expect(r.colors).toEqual([[50, 60, 70, 255]]);
  });

  it('an image with no visible pixel gives no colours', () => {
    const r = generatePalette(runs([[9, 9, 9, 0], 4]), { n: 4 });
    expect(r).toMatchObject({ pixels: 0, ignored: 4, unique: 0, exact: true, colors: [] });
  });

  it('counts a translucent pixel by its straight RGB and returns it opaque', () => {
    const r = generatePalette(runs([[50, 60, 70, 128], 3], [[50, 60, 70, 255], 1]), { n: 4 });
    expect(r).toMatchObject({ pixels: 4, unique: 1 });
    expect(r.colors).toEqual([[50, 60, 70, 255]]);
  });

  it('minAlpha drops pixels below it', () => {
    const img = runs([[50, 60, 70, 128], 3], [[1, 2, 3, 255], 1]);
    expect(generatePalette(img, { n: 4, minAlpha: 129 })).toMatchObject({
      pixels: 1,
      ignored: 3,
      colors: [[1, 2, 3, 255]],
    });
    expect(generatePalette(img, { n: 4, minAlpha: 128 }).pixels).toBe(4);
  });
});

describe('generatePalette: many colours', () => {
  it('merges more than MAX_WORK_COLORS distinct colours and still gives n colours', () => {
    // 128 x 128 = 16384 pixels, all distinct
    const out = new Uint8Array(128 * 128 * 4);
    for (let i = 0; i < 128 * 128; i++) {
      out[4 * i] = (i & 127) * 2;
      out[4 * i + 1] = (i >> 7) * 2;
      out[4 * i + 2] = (i * 7) & 255;
      out[4 * i + 3] = 255;
    }
    for (const method of METHODS) {
      const r = generatePalette(out, { n: 32, method });
      expect(r.unique).toBeGreaterThan(MAX_WORK_COLORS);
      expect(r.binned).toBe(true);
      expect(r.colors).toHaveLength(32);
      expect(new Set(r.colors.map(keyOf)).size).toBe(32);
    }
  });
});
