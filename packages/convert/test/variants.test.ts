import { describe, expect, it } from 'vitest';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import {
  ConvertError,
  DEFAULT_MAX_VARIANTS,
  runRecipe,
  runVariants,
  variantSheet,
} from '../src/index.js';
import type {
  ConvertErrorCode,
  ConvertRecipe,
  NamedPalette,
  RecipeDownscale,
  VariantAxes,
} from '../src/index.js';
import { toAscii } from './ascii.js';
import type { Legend } from './ascii.js';
import { ART_PALETTE, fakePixelArt } from './scene.js';
import { randomArt } from './synth.js';

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

const SRC = randomArt(8, 8, 41);
const WIDE = fakePixelArt(SRC, 41);
const DOWNSCALE: RecipeDownscale = { method: 'mode', grid: 'auto' };
const BASE: ConvertRecipe = {
  version: 1,
  downscale: DOWNSCALE,
  cleanup: { orphanMinSize: 1 },
  quantize: { palette: ART_PALETTE },
};
const BW: NamedPalette = {
  name: 'bw',
  colors: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ],
};
const WARM: NamedPalette = {
  name: 'warm',
  colors: [
    [40, 10, 10, 255],
    [200, 80, 40, 255],
    [250, 220, 120, 255],
  ],
};

describe('runVariants', () => {
  it('no axes: one variant, labelled base, equal to runRecipe', () => {
    const v = runVariants(WIDE, BASE, {});
    expect(v).toHaveLength(1);
    expect(v[0]?.label).toBe('base');
    expect(v[0]?.params).toEqual({});
    expect(v[0]?.image).toEqual(runRecipe(WIDE, BASE).image);
  });

  it('is the cartesian product in axis order, the last axis changing fastest', () => {
    const v = runVariants(WIDE, BASE, {
      method: ['box', 'mode', 'nearest'],
      dither: ['none', 'bayer4'],
    });
    expect(v.map((x) => x.label)).toEqual([
      'method=box dither=none',
      'method=box dither=bayer4',
      'method=mode dither=none',
      'method=mode dither=bayer4',
      'method=nearest dither=none',
      'method=nearest dither=bayer4',
    ]);
    expect(v.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(v[3]?.params).toEqual({ method: 'mode', dither: 'bayer4' });
  });

  it('the order of the keys in the axes object does not matter', () => {
    const a = runVariants(WIDE, BASE, { method: ['box', 'mode'], dither: ['none', 'bayer2'] });
    const b = runVariants(WIDE, BASE, { dither: ['none', 'bayer2'], method: ['box', 'mode'] });
    expect(b.map((x) => x.label)).toEqual(a.map((x) => x.label));
    expect(b.map((x) => hashRGBA(x.image))).toEqual(a.map((x) => hashRGBA(x.image)));
  });

  it('every variant equals runRecipe of its own recipe, and the recipe differs from the base only in the axes', () => {
    const axes: VariantAxes = {
      method: ['box', 'kcentroid'],
      k: [2, 3],
      palette: [BW, WARM],
      dither: ['floyd-steinberg'],
      strength: [0.5, 1],
      spread: ['auto', 40],
      orphanMinSize: [1, 3],
    };
    const v = runVariants(WIDE, BASE, axes);
    expect(v).toHaveLength(2 * 2 * 2 * 1 * 2 * 2 * 2);
    for (const x of v) {
      expect(hashRGBA(x.image)).toBe(hashRGBA(runRecipe(WIDE, x.recipe).image));
      expect(x.recipe.downscale?.grid).toBe('auto');
      expect(x.recipe.cleanup?.orphanMinSize).toBe(x.params.orphanMinSize);
      expect(x.recipe.quantize?.palette).toEqual(
        x.params.palette === 'bw' ? BW.colors : WARM.colors,
      );
    }
    // all labels differ
    expect(new Set(v.map((x) => x.label)).size).toBe(v.length);
  });

  it('a palette axis and the context palette: the axis wins, the context fills an unset palette', () => {
    const noPal: ConvertRecipe = { version: 1, quantize: {} };
    const ctx = BW.colors;
    const v = runVariants(WIDE, noPal, { dither: ['none', 'bayer4'] }, { palette: ctx });
    expect(v[0]?.report.paletteSize).toBe(2);
    expect(code(() => runVariants(WIDE, noPal, { dither: ['none'] }))).toBe('BAD_PALETTE');
  });

  it('does not change the input or the base recipe', () => {
    const copy = WIDE.data.slice();
    const base = JSON.stringify(BASE);
    runVariants(WIDE, BASE, { method: ['box', 'mode'] });
    expect(WIDE.data).toEqual(copy);
    expect(JSON.stringify(BASE)).toBe(base);
  });

  describe('the cap', () => {
    it('allows exactly 64 by default and refuses 65 before running anything', () => {
      expect(DEFAULT_MAX_VARIANTS).toBe(64);
      const ok = runVariants(WIDE, BASE, {
        method: ['box', 'mode', 'nearest', 'kcentroid'],
        dither: ['none', 'bayer2', 'bayer4', 'bayer8'],
        strength: [0.25, 0.5, 0.75, 1],
      });
      expect(ok).toHaveLength(64);
      expect(
        code(() =>
          runVariants(WIDE, BASE, {
            method: ['box', 'mode', 'nearest', 'kcentroid'],
            dither: ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'],
            strength: [0.25, 0.5, 0.75, 1],
          }),
        ),
      ).toBe('TOO_MANY_VARIANTS');
    });

    it('the cap is checked before the recipes run (a bad image would fail there)', () => {
      const bad: RgbaImage = { width: 1, height: 1, data: new Uint8Array(4) };
      expect(
        code(() =>
          runVariants(bad, BASE, {
            strength: Array.from({ length: 70 }, (_, i) => i / 100),
          }),
        ),
      ).toBe('TOO_MANY_VARIANTS');
    });

    it('maxVariants raises or lowers the cap, within 1..256', () => {
      const strengths = Array.from({ length: 70 }, (_, i) => i / 100);
      expect(runVariants(WIDE, BASE, { strength: strengths }, { maxVariants: 70 })).toHaveLength(
        70,
      );
      expect(code(() => runVariants(WIDE, BASE, { strength: [0, 1] }, { maxVariants: 1 }))).toBe(
        'TOO_MANY_VARIANTS',
      );
      expect(code(() => runVariants(WIDE, BASE, {}, { maxVariants: 257 }))).toBe('BAD_OPTION');
      expect(code(() => runVariants(WIDE, BASE, {}, { maxVariants: 0 }))).toBe('BAD_OPTION');
    });
  });

  describe('axis errors', () => {
    const cases: [
      string,
      ConvertRecipe,
      VariantAxes | Record<string, unknown>,
      ConvertErrorCode,
    ][] = [
      ['unknown axis', BASE, { colour: [1] }, 'BAD_AXES'],
      ['empty axis', BASE, { method: [] }, 'BAD_AXES'],
      ['duplicate values', BASE, { method: ['box', 'box'] }, 'BAD_AXES'],
      ['duplicate palette names', BASE, { palette: [BW, { ...WARM, name: 'bw' }] }, 'BAD_AXES'],
      ['palette name with space', BASE, { palette: [{ ...BW, name: 'b w' }] }, 'BAD_AXES'],
      ['method without downscale', { version: 1, quantize: {} }, { method: ['box'] }, 'BAD_AXES'],
      [
        'dither without quantize',
        { version: 1, downscale: DOWNSCALE },
        { dither: ['none'] },
        'BAD_AXES',
      ],
      ['orphanMinSize without cleanup', { version: 1 }, { orphanMinSize: [2] }, 'BAD_AXES'],
      ['bad value is refused by validation', BASE, { strength: [2] }, 'BAD_RECIPE'],
      ['bad method value', BASE, { method: ['lanczos'] }, 'BAD_RECIPE'],
      ['bad base recipe', { version: 2 } as unknown as ConvertRecipe, {}, 'BAD_RECIPE'],
    ];
    it.each(cases)('%s', (_name, base, axes, expected) => {
      expect(code(() => runVariants(WIDE, base, axes as VariantAxes))).toBe(expected);
    });
  });
});

describe('variantSheet', () => {
  const L: Legend = {
    '.': [0, 0, 0, 0],
    b: [9, 9, 9, 255],
    r: [255, 0, 0, 255],
    g: [0, 255, 0, 255],
    u: [0, 0, 255, 255],
  };
  const solid = (w: number, h: number, c: RGBA8): RgbaImage => {
    const data = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) data.set(c, p * 4);
    return { width: w, height: h, data };
  };
  const results = [
    { index: 0, label: 'a', image: solid(2, 2, [255, 0, 0, 255]) },
    { index: 1, label: 'b', image: solid(3, 1, [0, 255, 0, 255]) },
    { index: 2, label: 'c', image: solid(1, 3, [0, 0, 255, 255]) },
  ];

  it('lays tiles out row by row, centred in equal cells, with a gap and a background', () => {
    const s = variantSheet(results, { columns: 2, gap: 1, background: [9, 9, 9, 255] });
    expect(s.columns).toBe(2);
    expect(s.rows).toBe(2);
    expect(s.cell).toEqual({ w: 3, h: 3 });
    expect(s.image.width).toBe(9);
    expect(s.image.height).toBe(9);
    expect(toAscii(s.image, L)).toEqual([
      'bbbbbbbbb',
      'brrbbbbbb',
      'brrbbgggb',
      'bbbbbbbbb',
      'bbbbbbbbb',
      'bbubbbbbb',
      'bbubbbbbb',
      'bbubbbbbb',
      'bbbbbbbbb',
    ]);
    expect(s.tiles).toEqual([
      { index: 0, label: 'a', x: 1, y: 1, w: 2, h: 2 },
      { index: 1, label: 'b', x: 5, y: 2, w: 3, h: 1 },
      { index: 2, label: 'c', x: 2, y: 5, w: 1, h: 3 },
    ]);
  });

  it('default columns is ceil(sqrt(n)), default gap 2, default background transparent', () => {
    const s = variantSheet(results);
    expect(s.columns).toBe(2);
    expect(s.image.width).toBe(2 + 2 * (3 + 2));
    expect(s.image.data[3]).toBe(0);
  });

  it('more columns than results is clamped; one result is one cell', () => {
    const wide = variantSheet(results, { columns: 10, gap: 0 });
    expect(wide.columns).toBe(3);
    expect(wide.rows).toBe(1);
    expect(wide.image.width).toBe(9);
    const one = variantSheet(results.slice(0, 1), { gap: 0 });
    expect(one.image).toEqual(results[0]?.image);
  });

  it('copies pixels as they are, including partly transparent ones', () => {
    const half: RgbaImage = { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 77]) };
    const s = variantSheet([{ index: 0, label: 'x', image: half }], { gap: 1 });
    expect([...s.image.data.subarray((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)]).toEqual([1, 2, 3, 77]);
  });

  it('errors', () => {
    expect(code(() => variantSheet([]))).toBe('BAD_OPTION');
    expect(code(() => variantSheet(results, { columns: 0 }))).toBe('BAD_OPTION');
    expect(code(() => variantSheet(results, { gap: -1 }))).toBe('BAD_OPTION');
    expect(code(() => variantSheet(results, { gap: 1.5 }))).toBe('BAD_OPTION');
    expect(code(() => variantSheet(results, { background: [0, 0, 0, 300] }))).toBe('BAD_OPTION');
    const huge = [
      { index: 0, label: 'h', image: { width: 20000, height: 1, data: new Uint8Array(80000) } },
    ];
    expect(code(() => variantSheet(huge))).toBe('BAD_OPTION');
    const bad = [{ index: 0, label: 'x', image: { width: 2, height: 2, data: new Uint8Array(3) } }];
    expect(code(() => variantSheet(bad))).toBe('BAD_IMAGE');
  });
});

describe('variants: pinned hashes', () => {
  it('a grid of downscale methods and dither modes, and its sheet', () => {
    const v = runVariants(WIDE, BASE, {
      method: ['box', 'mode', 'kcentroid'],
      palette: [BW, WARM],
      dither: ['none', 'bayer4', 'floyd-steinberg'],
    });
    const sheet = variantSheet(v, { columns: 6, gap: 1 });
    expect(v).toHaveLength(18);
    // the sheet hash covers every tile; two tiles are pinned on their own to localise a failure
    expect([v[0], v[17]].map((x) => (x === undefined ? '' : hashRGBA(x.image)))).toEqual(
      PINNED_TILES,
    );
    expect(hashRGBA(sheet.image)).toBe(PINNED_SHEET);
  });
});

const PINNED_TILES: string[] = [
  'b37b085c20cae57a3509362a3b8e1bd31e1c8420be659506555d5a3933a5da82',
  '1f0eb07101b84bbe8e3afefa01ce4bad2b2fe31b743e36db6af2cb36c1f0a062',
];
const PINNED_SHEET = '06ec187b49afdc08dd6427add1783ccc6abdcace49f9b748f460f2db88daf359';
