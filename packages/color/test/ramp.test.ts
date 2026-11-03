import { Palette, PaletteId, type RGBA8 } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  composeRemaps,
  generateRamp,
  insertRamp,
  oklabToOklch,
  replaceColor,
  sinCosDeg,
  sortBy,
  srgb8ToOklab,
} from '../src/index.js';

const pal = (colors: RGBA8[]): Palette =>
  Palette.parse({ id: PaletteId.parse('pal_aaaaaa'), name: 't', colors, ramps: [] });
const lch = (c: RGBA8 | undefined) => {
  if (c === undefined) throw new Error('missing colour');
  return oklabToOklch(srgb8ToOklab(c[0], c[1], c[2]));
};

describe('sinCosDeg', () => {
  it('is exact at zero and matches Math.sin/cos closely', () => {
    expect(sinCosDeg(0)).toEqual({ sin: 0, cos: 1 });
    for (const d of [-540, -170, -90, 30, 45, 90, 179, 265, 360, 725]) {
      const { sin, cos } = sinCosDeg(d);
      expect(sin).toBeCloseTo(Math.sin((d * Math.PI) / 180), 12);
      expect(cos).toBeCloseTo(Math.cos((d * Math.PI) / 180), 12);
    }
  });
});

describe('generateRamp', () => {
  // Expected values come from an independent float implementation of the same recipe (Python, with
  // pow, atan2, cos, sin), not from this code.
  it('matches the independent oracle for a warm red', () => {
    expect(generateRamp({ base: [200, 80, 60, 255], steps: 5 })).toEqual([
      [52, 0, 13, 255],
      [135, 3, 28, 255],
      [200, 80, 60, 255],
      [248, 130, 83, 255],
      [255, 200, 168, 255],
    ]);
  });

  it('matches the oracle for a blue', () => {
    expect(generateRamp({ base: [60, 120, 200, 255], steps: 5 })).toEqual([
      [1, 0, 83, 255],
      [30, 60, 141, 255],
      [60, 120, 200, 255],
      [82, 172, 246, 255],
      [166, 221, 255, 255],
    ]);
  });

  it('matches the oracle with baseIndex 0, and with hueShift and satShift', () => {
    expect(generateRamp({ base: [200, 80, 60, 255], steps: 4, baseIndex: 0 })).toEqual([
      [200, 80, 60, 255],
      [232, 113, 75, 255],
      [255, 152, 105, 255],
      [255, 200, 168, 255],
    ]);
    expect(
      generateRamp({ base: [30, 160, 70, 255], steps: 7, hueShift: 30, satShift: -0.2 }),
    ).toEqual([
      [0, 32, 26, 255],
      [0, 70, 52, 255],
      [0, 114, 70, 255],
      [30, 160, 70, 255],
      [108, 183, 81, 255],
      [160, 206, 98, 255],
      [208, 228, 122, 255],
    ]);
  });

  it('keeps a grey base grey, with lightness 0.35*L at the dark end', () => {
    expect(generateRamp({ base: [128, 128, 128, 255], steps: 3 })).toEqual([
      [24, 24, 24, 255],
      [128, 128, 128, 255],
      [214, 214, 214, 255],
    ]);
  });

  it('returns the base unchanged at baseIndex, and keeps its alpha', () => {
    const r = generateRamp({ base: [10, 200, 90, 128], steps: 6, baseIndex: 4 });
    expect(r[4]).toEqual([10, 200, 90, 128]);
    expect(r.every((c) => c[3] === 128)).toBe(true);
    expect(generateRamp({ base: [1, 2, 3, 255], steps: 1 })).toEqual([[1, 2, 3, 255]]);
  });

  it('is monotone in lightness; hue ends nearer the cool target in shadow and the warm one in light', () => {
    const dist = (h: number, t: number): number => Math.abs(((h - t + 540) % 360) - 180);
    for (const base of [
      [200, 80, 60, 255],
      [60, 120, 200, 255],
      [30, 160, 70, 255],
      [150, 60, 170, 255],
    ] satisfies RGBA8[]) {
      const r = generateRamp({ base, steps: 9 });
      for (let i = 1; i < r.length; i++) {
        expect(lch(r[i]).L, `${base.join(',')} step ${String(i)}`).toBeGreaterThan(lch(r[i - 1]).L);
      }
      const h = (i: number): number => lch(r[i]).h;
      expect(dist(h(0), 265)).toBeLessThanOrEqual(dist(h(4), 265) + 1);
      expect(dist(h(8), 90)).toBeLessThanOrEqual(dist(h(4), 90) + 1);
    }
  });

  it('turns a red-orange base clockwise (down) toward blue in shadow and up toward yellow in light', () => {
    const r = generateRamp({ base: [200, 80, 60, 255], steps: 3, lightRange: [0.3, 0.8] });
    const base = lch(r[1]).h;
    expect(lch(r[0]).h).toBeLessThan(base);
    expect(lch(r[2]).h).toBeGreaterThan(base);
  });

  it('hueShift 0 keeps the hue and a larger shift turns further', () => {
    const flat = generateRamp({ base: [200, 80, 60, 255], steps: 5, hueShift: 0 });
    const h0 = lch(flat[2]).h;
    for (const c of [flat[1], flat[3]] as RGBA8[]) expect(Math.abs(lch(c).h - h0)).toBeLessThan(4);
    const a = generateRamp({ base: [200, 80, 60, 255], steps: 5, hueShift: 10 });
    const b = generateRamp({ base: [200, 80, 60, 255], steps: 5, hueShift: 40 });
    expect(Math.abs(lch(b[4]).h - h0)).toBeGreaterThan(Math.abs(lch(a[4]).h - h0));
  });

  it('satShift raises chroma toward the light end when positive', () => {
    const r = generateRamp({
      base: [90, 120, 160, 255],
      steps: 5,
      satShift: 0.5,
      hueShift: 0,
      lightRange: [0.4, 0.7],
    });
    expect(lch(r[3]).C).toBeGreaterThan(lch(r[1]).C);
  });

  it('is deterministic and gives 8-bit integers', () => {
    const a = generateRamp({ base: [17, 233, 101, 255], steps: 32 });
    expect(generateRamp({ base: [17, 233, 101, 255], steps: 32 })).toEqual(a);
    for (const c of a) {
      for (const v of c) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
    }
  });

  it('rejects bad parameters', () => {
    const base: RGBA8 = [1, 2, 3, 255];
    expect(() => generateRamp({ base, steps: 0 })).toThrow(RangeError);
    expect(() => generateRamp({ base, steps: 33 })).toThrow(RangeError);
    expect(() => generateRamp({ base, steps: 3, baseIndex: 3 })).toThrow(RangeError);
    expect(() => generateRamp({ base, steps: 3, lightRange: [0.8, 0.2] })).toThrow(RangeError);
  });
});

describe('palette editing helpers', () => {
  const p = pal([
    [0, 0, 0, 0],
    [10, 10, 10, 255],
    [20, 20, 20, 255],
  ]);

  it('replaceColor changes one colour and keeps every index', () => {
    const e = replaceColor(p, 1, [1, 2, 3, 255]);
    expect(e.palette.colors[1]).toEqual([1, 2, 3, 255]);
    expect(e.remap).toEqual([0, 1, 2]);
    expect(p.colors[1]).toEqual([10, 10, 10, 255]);
    expect(() => replaceColor(p, 3, [0, 0, 0, 255])).toThrow(RangeError);
  });

  it('insertRamp inserts a block, shifts later indices and records a named ramp', () => {
    const withRamp = { ...p, ramps: [{ name: 'greys', indices: [1, 2] }] };
    const e = insertRamp(
      withRamp,
      [
        [5, 5, 5, 255],
        [6, 6, 6, 255],
      ],
      { at: 1, name: 'new' },
    );
    expect(e.palette.colors.map((c) => c[0])).toEqual([0, 5, 6, 10, 20]);
    expect(e.remap).toEqual([0, 3, 4]);
    expect(e.palette.ramps).toEqual([
      { name: 'greys', indices: [3, 4] },
      { name: 'new', indices: [1, 2] },
    ]);
    expect(() => insertRamp(withRamp, [[1, 1, 1, 255]], { name: 'greys' })).toThrow(RangeError);
    expect(() => insertRamp(p, [])).toThrow(RangeError);
    expect(() => insertRamp(p, [[1, 1, 1, 255]], { at: 4 })).toThrow(RangeError);
    const full = pal(Array.from({ length: 256 }, (): RGBA8 => [1, 1, 1, 255]));
    expect(() => insertRamp(full, [[1, 1, 1, 255]])).toThrow(RangeError);
  });

  it('composeRemaps chains two edits', () => {
    expect(composeRemaps([0, null, 1], [2, 0])).toEqual([2, null, 0]);
  });
});

describe('sortBy luma, hue and ties', () => {
  it('luma orders by 2126R+7152G+722B and keeps original order on ties', () => {
    const p = pal([
      [0, 255, 0, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
    ]);
    expect(sortBy(p, 'luma').order).toEqual([2, 1, 3, 0]);
    expect(sortBy(p, 'luma', true).order).toEqual([0, 1, 3, 2]);
  });

  it('hue sort puts greys first, then turns counter-clockwise from the +a axis', () => {
    const p = pal([
      [0, 0, 255, 255], // blue, hue about 264
      [128, 128, 128, 255],
      [255, 0, 0, 255], // red, about 29
      [255, 255, 0, 255], // yellow, about 110
    ]);
    expect(sortBy(p, 'hue').order).toEqual([1, 2, 3, 0]);
  });

  it('sort remaps the ramps with the colours', () => {
    const base = pal([
      [200, 200, 200, 255],
      [10, 10, 10, 255],
    ]);
    const e = sortBy({ ...base, ramps: [{ name: 'g', indices: [0, 1] }] }, 'luma');
    expect(e.palette.ramps).toEqual([{ name: 'g', indices: [1, 0] }]);
  });
});
