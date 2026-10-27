import { Palette, PaletteId, type RGBA8 } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  addColor,
  cbrt,
  createNearestCache,
  dedupe,
  linearToSrgb,
  moveColor,
  nearestIndex,
  oklabDistanceSq,
  oklabToOklch,
  oklabToSrgb8,
  oklchToOklab,
  remapIndex,
  removeColor,
  reorder,
  sortBy,
  srgb8ToLinear,
  srgb8ToOklab,
  srgbToLinear,
} from '../src/index.js';

const pal = (colors: RGBA8[], ramps: Palette['ramps'] = []): Palette =>
  Palette.parse({ id: PaletteId.parse('pal_test'), name: 'T', colors, ramps });

describe('transfer function', () => {
  it('matches known values', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 14);
    // 0.5 sRGB = 0.21404114048... linear (standard value).
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041140482, 11);
    expect(srgb8ToLinear(128)).toBeCloseTo(0.2158605, 6);
  });
  it('encode inverts decode', () => {
    for (let i = 0; i <= 1000; i++) {
      const c = i / 1000;
      expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 12);
    }
  });
  it('agrees with Math.pow to high precision (sanity, not used at runtime)', () => {
    for (let i = 1; i <= 255; i++) {
      const c = i / 255;
      const ref = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      expect(Math.abs(srgbToLinear(c) - ref)).toBeLessThan(1e-14);
    }
  });
  it('cbrt', () => {
    expect(cbrt(27)).toBeCloseTo(3, 14);
    expect(cbrt(-8)).toBeCloseTo(-2, 14);
    expect(cbrt(0)).toBe(0);
    expect(cbrt(1e-300)).toBeCloseTo(1e-100, 110);
    expect(cbrt(1e300) / 1e100).toBeCloseTo(1, 12);
    expect(cbrt(Infinity)).toBe(Infinity);
  });
});

describe('OKLab reference values', () => {
  // CSS Color Module Level 4 (oklab() examples), derived from Ottosson's reference implementation:
  // red = oklab(0.62796 0.22486 0.12585), green = oklab(0.86644 -0.23389 0.17950),
  // blue = oklab(0.45201 -0.03246 -0.31153).
  const cases: [string, [number, number, number], [number, number, number]][] = [
    ['red', [255, 0, 0], [0.62796, 0.22486, 0.12585]],
    ['green', [0, 255, 0], [0.86644, -0.23389, 0.1795]],
    ['blue', [0, 0, 255], [0.45201, -0.03246, -0.31153]],
    ['white', [255, 255, 255], [1, 0, 0]],
    ['black', [0, 0, 0], [0, 0, 0]],
  ];
  for (const [name, rgb, lab] of cases) {
    it(name, () => {
      const got = srgb8ToOklab(...rgb);
      expect(Math.abs(got.L - lab[0])).toBeLessThan(1e-4);
      expect(Math.abs(got.a - lab[1])).toBeLessThan(1e-4);
      expect(Math.abs(got.b - lab[2])).toBeLessThan(1e-4);
    });
  }
  it('red OKLCH matches CSS oklch(0.62796 0.25768 29.23)', () => {
    const lch = oklabToOklch(srgb8ToOklab(255, 0, 0));
    expect(Math.abs(lch.C - 0.25768)).toBeLessThan(1e-4);
    expect(Math.abs(lch.h - 29.234)).toBeLessThan(1e-2);
  });
});

describe('round trips', () => {
  it('sRGB8 -> OKLab -> sRGB8 is exact on the 16-level grid (4096 colours)', () => {
    let n = 0;
    for (let r = 0; r < 16; r++)
      for (let g = 0; g < 16; g++)
        for (let b = 0; b < 16; b++) {
          const rgb = [r * 17, g * 17, b * 17] as const;
          expect(oklabToSrgb8(srgb8ToOklab(...rgb))).toEqual(rgb);
          n++;
        }
    expect(n).toBe(4096);
  });
  it('is exact for every grey and a strided sweep of 8-bit space', () => {
    for (let v = 0; v < 256; v++) expect(oklabToSrgb8(srgb8ToOklab(v, v, v))).toEqual([v, v, v]);
    for (let r = 0; r < 256; r += 7)
      for (let g = 0; g < 256; g += 11)
        for (let b = 0; b < 256; b += 13)
          expect(oklabToSrgb8(srgb8ToOklab(r, g, b))).toEqual([r, g, b]);
  });
  it('OKLab <-> OKLCH', () => {
    const lab = srgb8ToOklab(200, 30, 90);
    const lch = oklabToOklch(lab);
    expect(lch.h).toBeGreaterThanOrEqual(0);
    expect(lch.h).toBeLessThan(360);
    expect(lch.C).toBeGreaterThanOrEqual(0);
    const back = oklchToOklab(lch);
    expect(back.a).toBeCloseTo(lab.a, 12);
    expect(back.b).toBeCloseTo(lab.b, 12);
    expect(oklabToOklch({ L: 0.5, a: 0, b: 0 })).toEqual({ L: 0.5, C: 0, h: 0 });
    expect(oklabToOklch({ L: 0.5, a: 0.1, b: -0.1 }).h).toBeCloseTo(315, 9);
  });
  it('clamps out-of-gamut', () => {
    expect(oklabToSrgb8({ L: 0.7, a: 0.4, b: 0.3 }).every((v) => v >= 0 && v <= 255)).toBe(true);
    expect(oklabToSrgb8({ L: 2, a: 0, b: 0 })).toEqual([255, 255, 255]);
    expect(oklabToSrgb8({ L: -1, a: 0, b: 0 })).toEqual([0, 0, 0]);
  });
});

describe('oklabDistanceSq', () => {
  it('is zero for equal and symmetric', () => {
    const a = srgb8ToOklab(10, 20, 30);
    const b = srgb8ToOklab(200, 100, 50);
    expect(oklabDistanceSq(a, a)).toBe(0);
    expect(oklabDistanceSq(a, b)).toBe(oklabDistanceSq(b, a));
    expect(oklabDistanceSq({ L: 0, a: 0, b: 0 }, { L: 1, a: 2, b: 2 })).toBe(9);
  });
});

describe('nearestIndex', () => {
  const p = pal([
    [0, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [255, 255, 255, 255],
  ]);
  it('finds exact and near colours', () => {
    expect(nearestIndex(p, [255, 0, 0, 255])).toBe(1);
    expect(nearestIndex(p, [250, 10, 5, 255])).toBe(1);
    expect(nearestIndex(p, [20, 20, 20, 255])).toBe(0);
    expect(nearestIndex(p, [240, 240, 250, 255])).toBe(3);
  });
  it('ties go to the lower index', () => {
    const dup = pal([
      [10, 10, 10, 255],
      [200, 0, 0, 255],
      [200, 0, 0, 255],
    ]);
    expect(nearestIndex(dup, [200, 0, 0, 255])).toBe(1);
    // Equidistant by symmetry in a/b: both candidates get the same distance bitwise only for
    // duplicates, so duplicates are the tie we assert.
  });
  it('is deterministic and cache does not change results', () => {
    const cache = createNearestCache(8);
    for (let i = 0; i < 300; i++) {
      const c: RGBA8 = [(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255];
      const expected = nearestIndex(p, c);
      expect(nearestIndex(p, c, { cache })).toBe(expected);
      expect(nearestIndex(p, c, { cache })).toBe(expected);
      expect(cache.size).toBeLessThanOrEqual(8);
    }
  });
  it('evicts oldest first (FIFO)', () => {
    const cache = createNearestCache(2);
    nearestIndex(p, [1, 0, 0, 255], { cache });
    nearestIndex(p, [2, 0, 0, 255], { cache });
    nearestIndex(p, [3, 0, 0, 255], { cache });
    expect(cache.get(((1 << 24) | 255) >>> 0)).toBeUndefined();
    expect(cache.get(((2 << 24) | 255) >>> 0)).toBeDefined();
    expect(cache.get(((3 << 24) | 255) >>> 0)).toBeDefined();
    expect(createNearestCache(0).capacity).toBe(1);
  });
  it('cache resets when palette changes', () => {
    const cache = createNearestCache();
    expect(nearestIndex(p, [255, 0, 0, 255], { cache })).toBe(1);
    const q = pal([[255, 0, 0, 255]]);
    expect(nearestIndex(q, [255, 0, 0, 255], { cache })).toBe(0);
  });
  it('alpha: transparent maps to first alpha-0 entry', () => {
    const t = pal([
      [255, 0, 0, 255],
      [9, 9, 9, 0],
      [0, 0, 0, 0],
    ]);
    expect(nearestIndex(t, [255, 0, 0, 0])).toBe(1);
    expect(nearestIndex(t, [0, 0, 0, 0])).toBe(1);
  });
  it('alpha: transparent without alpha-0 entry falls back to colour', () => {
    expect(nearestIndex(p, [250, 0, 0, 0])).toBe(1);
  });
  it('alpha: visible input never maps to a transparent entry', () => {
    const t = pal([
      [255, 0, 0, 0],
      [0, 0, 255, 255],
    ]);
    expect(nearestIndex(t, [255, 0, 0, 255])).toBe(1);
    const allT = pal([
      [255, 0, 0, 0],
      [0, 0, 255, 0],
    ]);
    expect(nearestIndex(allT, [250, 0, 0, 255])).toBe(0);
  });
  it('alphaWeight prefers closer alpha', () => {
    const a = pal([
      [100, 100, 100, 255],
      [100, 100, 100, 128],
    ]);
    expect(nearestIndex(a, [100, 100, 100, 130])).toBe(0);
    expect(nearestIndex(a, [100, 100, 100, 130], { alphaWeight: 1 })).toBe(1);
  });
  it('throws on empty palette', () => {
    expect(() => nearestIndex(pal([]), [0, 0, 0, 255])).toThrow(RangeError);
  });
});

describe('palette ops', () => {
  const base = pal(
    [
      [10, 0, 0, 255],
      [20, 0, 0, 255],
      [30, 0, 0, 255],
      [40, 0, 0, 255],
    ],
    [
      { name: 'a', indices: [0, 1, 2] },
      { name: 'b', indices: [3] },
    ],
  );
  const frozen = JSON.stringify(base);

  it('addColor appends and inserts, remapping ramps', () => {
    const e = addColor(base, [1, 2, 3, 255]);
    expect(e.palette.colors).toHaveLength(5);
    expect(e.remap).toEqual([0, 1, 2, 3]);
    const m = addColor(base, [1, 2, 3, 255], 1);
    expect(m.palette.colors[1]).toEqual([1, 2, 3, 255]);
    expect(m.remap).toEqual([0, 2, 3, 4]);
    expect(m.palette.ramps[0]?.indices).toEqual([0, 2, 3]);
    expect(m.palette.ramps[1]?.indices).toEqual([4]);
    expect(() => addColor(base, [0, 0, 0, 255], 9)).toThrow(RangeError);
    const full = pal(Array.from({ length: 256 }, () => [0, 0, 0, 255] as RGBA8));
    expect(() => addColor(full, [0, 0, 0, 255])).toThrow(RangeError);
  });

  it('removeColor remaps pixels and ramps', () => {
    const e = removeColor(base, 1);
    expect(e.remap).toEqual([0, null, 1, 2]);
    expect(e.palette.colors.map((c) => c[0])).toEqual([10, 30, 40]);
    expect(e.palette.ramps[0]?.indices).toEqual([0, 1]);
    expect(e.palette.ramps[1]?.indices).toEqual([2]);
    expect(remapIndex(e.remap, 1)).toBeNull();
    expect(remapIndex(e.remap, 3)).toBe(2);
    expect(remapIndex(e.remap, 99)).toBeNull();
    // ramp emptied -> removed
    const r = removeColor(base, 3);
    expect(r.palette.ramps.map((x) => x.name)).toEqual(['a']);
    expect(() => removeColor(base, 4)).toThrow(RangeError);
  });

  it('reorder / moveColor: colour at remap[i] equals the original colour i', () => {
    const e = moveColor(base, 0, 2);
    expect(e.palette.colors.map((c) => c[0])).toEqual([20, 30, 10, 40]);
    for (let i = 0; i < 4; i++) {
      expect(e.palette.colors[e.remap[i] ?? -1]).toEqual(base.colors[i]);
    }
    expect(e.palette.ramps[0]?.indices).toEqual([2, 0, 1]);
    const back = moveColor(base, 3, 0);
    expect(back.palette.colors.map((c) => c[0])).toEqual([40, 10, 20, 30]);
    expect(() => reorder(base, [0, 0, 1, 2])).toThrow(RangeError);
    expect(() => reorder(base, [0, 1, 2])).toThrow(RangeError);
    expect(() => moveColor(base, -1, 0)).toThrow(RangeError);
  });

  it('sortBy luminance / chroma / hue return valid permutations', () => {
    const colors: RGBA8[] = [
      [255, 255, 255, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 255, 0, 255],
      [128, 128, 128, 255],
    ];
    const p = pal(colors);
    const lum = sortBy(p, 'luminance');
    expect(lum.order).toEqual([3, 1, 5, 2, 4, 0]);
    expect(sortBy(p, 'luminance', true).order).toEqual([0, 4, 2, 5, 1, 3]);
    const chroma = sortBy(p, 'chroma');
    expect(chroma.order.slice(3).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    const hue = sortBy(p, 'hue');
    // greys first by L (black, grey, white), then red (29deg), green (142deg), blue (264deg)
    expect(hue.order).toEqual([3, 5, 0, 2, 4, 1]);
    for (const s of [lum, chroma, hue]) {
      expect([...s.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
      colors.forEach((c, i) => {
        expect(s.palette.colors[s.remap[i] ?? -1]).toEqual(c);
        expect(s.palette.colors[s.order.indexOf(i)]).toEqual(c);
      });
    }
  });

  it('sortBy is stable for equal keys', () => {
    const p = pal([
      [5, 5, 5, 255],
      [5, 5, 5, 255],
      [0, 0, 0, 255],
    ]);
    expect(sortBy(p, 'luminance').order).toEqual([2, 0, 1]);
  });

  it('dedupe merges identical RGBA, keeping first', () => {
    const p = pal(
      [
        [1, 1, 1, 255],
        [2, 2, 2, 255],
        [1, 1, 1, 255],
        [1, 1, 1, 0],
        [2, 2, 2, 255],
      ],
      [{ name: 'r', indices: [0, 2, 4] }],
    );
    const e = dedupe(p);
    expect(e.palette.colors).toEqual([
      [1, 1, 1, 255],
      [2, 2, 2, 255],
      [1, 1, 1, 0],
    ]);
    expect(e.remap).toEqual([0, 1, 0, 2, 1]);
    expect(e.palette.ramps[0]?.indices).toEqual([0, 0, 1]);
  });

  it('never mutates its input and keeps palette identity fields', () => {
    removeColor(base, 0);
    sortBy(base, 'hue');
    dedupe(base);
    expect(JSON.stringify(base)).toBe(frozen);
    expect(removeColor(base, 0).palette.id).toBe(base.id);
  });

  it('property: random edit sequences keep pixel colours stable', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let trial = 0; trial < 50; trial++) {
      const colors: RGBA8[] = Array.from({ length: 2 + rnd(12) }, () => [
        rnd(4) * 60,
        rnd(4) * 60,
        0,
        255,
      ]);
      const p = pal(colors);
      const edit =
        rnd(3) === 0
          ? dedupe(p)
          : rnd(2) === 0
            ? sortBy(p, (['hue', 'luminance', 'chroma'] as const)[rnd(3)] ?? 'hue')
            : moveColor(p, rnd(colors.length), rnd(colors.length));
      colors.forEach((c, i) => {
        expect(edit.palette.colors[edit.remap[i] ?? -1]).toEqual(c);
      });
    }
  });
});
