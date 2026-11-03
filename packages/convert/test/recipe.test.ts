import { describe, expect, it } from 'vitest';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import {
  ConvertError,
  autoDitherSpread,
  quantize,
  runRecipe,
  validateRecipe,
} from '../src/index.js';
import type { ConvertErrorCode, ConvertRecipe } from '../src/index.js';
import { fromAscii, toAscii } from './ascii.js';
import type { Legend } from './ascii.js';
import { ART_PALETTE, MAGENTA, fakePixelArt } from './scene.js';
import { cut, randomArt, upscale } from './synth.js';

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

const FULL: ConvertRecipe = {
  version: 1,
  alphaThreshold: 100,
  crop: { x: 6, y: 12, w: 60, h: 48 },
  background: { mode: 'flood', color: [250, 0, 250], tolerance: 30 },
  downscale: {
    method: 'mode',
    grid: 'auto',
    detect: { maxCell: 16, square: true },
    onNoGrid: 'skip',
  },
  cleanup: { orphanMinSize: 2, connectivity: 8, outline: { color: 'darken', shade: 40 } },
  quantize: {
    palette: [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ],
    dither: 'bayer4',
    strength: 0.5,
    spread: 'auto',
  },
};

describe('validateRecipe', () => {
  it('accepts a minimal and a full recipe and returns an equal copy', () => {
    expect(validateRecipe({ version: 1 })).toEqual({ version: 1 });
    const v = validateRecipe(FULL);
    expect(v).toEqual(FULL);
    expect(v).not.toBe(FULL);
  });

  it('survives a JSON round trip', () => {
    expect(validateRecipe(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });

  it('accepts an explicit grid and size targets', () => {
    const grid = { cellWidth: 4, cellHeight: 3, offsetX: 1, offsetY: 2 };
    expect(
      validateRecipe({ version: 1, downscale: { method: 'box', grid, edges: 'drop' } }),
    ).toEqual({
      version: 1,
      downscale: { method: 'box', grid, edges: 'drop' },
    });
    expect(validateRecipe({ version: 1, downscale: { method: 'nearest', width: 8 } })).toBeTruthy();
  });

  const bad: [string, unknown][] = [
    ['not an object', 5],
    ['null', null],
    ['array', []],
    ['no version', {}],
    ['version 2', { version: 2 }],
    ['version string', { version: '1' }],
    ['unknown top key', { version: 1, extra: 1 }],
    ['unknown crop key', { version: 1, crop: { x: 0, y: 0, w: 1, h: 1, z: 1 } }],
    ['crop missing field', { version: 1, crop: { x: 0, y: 0, w: 1 } }],
    ['crop negative', { version: 1, crop: { x: -1, y: 0, w: 1, h: 1 } }],
    ['crop float', { version: 1, crop: { x: 0.5, y: 0, w: 1, h: 1 } }],
    ['background mode', { version: 1, background: { mode: 'magic' } }],
    ['background none with key', { version: 1, background: { mode: 'none', tolerance: 1 } }],
    ['alpha mode with tolerance', { version: 1, background: { mode: 'alpha', tolerance: 1 } }],
    ['tolerance too big', { version: 1, background: { mode: 'key', tolerance: 443 } }],
    ['colour length', { version: 1, background: { mode: 'key', color: [1, 2] } }],
    ['alphaThreshold 0', { version: 1, alphaThreshold: 0 }],
    ['alphaThreshold 256', { version: 1, alphaThreshold: 256 }],
    ['downscale no method', { version: 1, downscale: { width: 4 } }],
    ['downscale bad method', { version: 1, downscale: { method: 'lanczos', width: 4 } }],
    ['downscale no target', { version: 1, downscale: { method: 'box' } }],
    ['downscale two targets', { version: 1, downscale: { method: 'box', width: 4, grid: 'auto' } }],
    ['detect without auto', { version: 1, downscale: { method: 'box', width: 4, detect: {} } }],
    [
      'onNoGrid without auto',
      { version: 1, downscale: { method: 'box', width: 4, onNoGrid: 'skip' } },
    ],
    ['edges without grid', { version: 1, downscale: { method: 'box', width: 4, edges: 'keep' } }],
    [
      'unknown detect key',
      { version: 1, downscale: { method: 'box', grid: 'auto', detect: { x: 1 } } },
    ],
    [
      'grid offset too big',
      {
        version: 1,
        downscale: { method: 'box', grid: { cellWidth: 2, cellHeight: 2, offsetX: 2, offsetY: 0 } },
      },
    ],
    ['k too big', { version: 1, downscale: { method: 'kcentroid', width: 4, k: 9 } }],
    ['cleanup unknown key', { version: 1, cleanup: { alphaThreshold: 5 } }],
    ['connectivity 6', { version: 1, cleanup: { connectivity: 6 } }],
    ['outline shade', { version: 1, cleanup: { outline: { shade: 101 } } }],
    ['outline unknown key', { version: 1, cleanup: { outline: { width: 2 } } }],
    ['quantize unknown key', { version: 1, quantize: { colors: 3 } }],
    ['quantize dither', { version: 1, quantize: { dither: 'atkinson' } }],
    ['quantize strength 2', { version: 1, quantize: { strength: 2 } }],
    ['quantize spread 0', { version: 1, quantize: { spread: 0 } }],
    ['quantize spread word', { version: 1, quantize: { spread: 'wide' } }],
    ['palette empty', { version: 1, quantize: { palette: [] } }],
    ['palette entry', { version: 1, quantize: { palette: [[1, 2, 3]] } }],
  ];
  it.each(bad)('refuses %s', (_name, value) => {
    expect(code(() => validateRecipe(value))).toBe('BAD_RECIPE');
  });

  it('names the path of the bad field', () => {
    expect(() => validateRecipe({ version: 1, cleanup: { outline: { width: 2 } } })).toThrow(
      /recipe\.cleanup\.outline\.width/,
    );
  });
});

describe('runRecipe', () => {
  it('an empty recipe returns a copy of the input', () => {
    const img = randomArt(5, 4, 3);
    const r = runRecipe(img, { version: 1 });
    expect(r.image).toEqual(img);
    expect(r.image.data).not.toBe(img.data);
    expect(r.report.steps).toEqual([]);
    expect(r.report.input).toEqual({ width: 5, height: 4 });
  });

  it('crop, background, grid, downscale, cleanup, quantise bring fake pixel art back to the sprite', () => {
    for (const seed of [11, 12, 13]) {
      const src = randomArt(14, 12, seed);
      const wide = fakePixelArt(src, seed);
      const recipe: ConvertRecipe = {
        version: 1,
        crop: { x: 6, y: 12, w: 60, h: 48 },
        background: { mode: 'key', color: MAGENTA, tolerance: 30 },
        downscale: { method: 'mode', grid: 'auto' },
        cleanup: { orphanMinSize: 1 },
        quantize: { palette: ART_PALETTE },
      };
      const r = runRecipe(wide, recipe);
      const want = cut(src, 1, 2, 10, 8);
      expect(r.image).toEqual(want);
      expect(r.report.steps.map((s) => s.step)).toEqual([
        'crop',
        'background',
        'downscale',
        'cleanup',
        'quantize',
      ]);
      expect(r.report.steps.map((s) => [s.width, s.height])).toEqual([
        [60, 48],
        [60, 48],
        [10, 8],
        [10, 8],
        [10, 8],
      ]);
      expect(r.report.grid).toEqual({ cellWidth: 6, cellHeight: 6, offsetX: 0, offsetY: 0 });
      expect(r.report.detection?.found).toBe(true);
      expect(r.report.paletteSize).toBe(6);
      expect(r.report.indices?.length).toBe(80);
    }
  });

  it('report indices match the image and use -1 for transparent', () => {
    const src = randomArt(8, 8, 5);
    const r = runRecipe(src, { version: 1, quantize: { palette: ART_PALETTE } });
    const idx = r.report.indices;
    expect(idx).toBeDefined();
    for (let p = 0; p < 64; p++) {
      const k = idx?.[p] ?? -2;
      if (k < 0) expect(r.image.data[p * 4 + 3]).toBe(0);
      else expect([...r.image.data.subarray(p * 4, p * 4 + 4)]).toEqual(ART_PALETTE[k]);
    }
  });

  it('explicit grid and size targets work', () => {
    const src = randomArt(6, 5, 2);
    const wide = upscale(src, 4, 3);
    const byGrid = runRecipe(wide, {
      version: 1,
      downscale: {
        method: 'nearest',
        grid: { cellWidth: 4, cellHeight: 3, offsetX: 0, offsetY: 0 },
      },
    });
    expect(byGrid.image).toEqual(src);
    expect(byGrid.report.detection).toBeUndefined();
    const bySize = runRecipe(wide, {
      version: 1,
      downscale: { method: 'nearest', width: 6, height: 5 },
    });
    expect(bySize.image).toEqual(src);
    expect(bySize.report.grid).toBeUndefined();
  });

  it("grid 'auto' with no grid: NO_GRID by default, skipped with onNoGrid 'skip'", () => {
    const flatish = randomArt(20, 20, 4); // native pixel art: no grid
    const r: ConvertRecipe = { version: 1, downscale: { method: 'box', grid: 'auto' } };
    expect(code(() => runRecipe(flatish, r))).toBe('NO_GRID');
    const skip = runRecipe(flatish, {
      version: 1,
      downscale: { method: 'box', grid: 'auto', onNoGrid: 'skip' },
    });
    expect(skip.image).toEqual(flatish);
    expect(skip.report.detection?.found).toBe(false);
    expect(skip.report.steps[0]?.note).toMatch(/no grid/);
  });

  it('one alpha threshold governs downscale, cleanup and quantise', () => {
    // a 2x2 cell of alpha 100 pixels
    const img: RgbaImage = { width: 2, height: 2, data: new Uint8Array(16) };
    for (let p = 0; p < 4; p++) img.data.set([200, 40, 40, 100], p * 4);
    const recipe = (alphaThreshold?: number): ConvertRecipe => ({
      version: 1,
      ...(alphaThreshold === undefined ? {} : { alphaThreshold }),
      downscale: { method: 'box', width: 1, height: 1 },
      cleanup: { orphanMinSize: 1 },
      quantize: { palette: ART_PALETTE },
    });
    const keep = runRecipe(img, recipe(100));
    expect(keep.image.data[3]).toBe(255);
    expect(keep.report.indices?.[0]).toBe(1);
    const drop = runRecipe(img, recipe());
    expect(drop.image.data[3]).toBe(0);
    expect(drop.report.indices?.[0]).toBe(-1);
  });

  it('flood treats transparent pixels as background: it passes through a transparent gap', () => {
    const L: Legend = { '.': [0, 0, 0, 0], '#': [20, 20, 30, 255], m: [250, 0, 250, 255] };
    const flood: ConvertRecipe = {
      version: 1,
      background: { mode: 'flood', color: MAGENTA, tolerance: 0 },
    };
    const open = fromAscii(['.######', '..mmm##', '#######'], L);
    expect(toAscii(runRecipe(open, flood).image, L)).toEqual(['.######', '.....##', '#######']);
    // the pocket is sealed by '#': the flood cannot reach it
    const sealed = fromAscii(['.######', '.#mmm##', '#######'], L);
    expect(toAscii(runRecipe(sealed, flood).image, L)).toEqual(['.######', '.#mmm##', '#######']);
  });

  it('the palette comes from the recipe, else from the context, else it is an error', () => {
    const img = randomArt(4, 4, 6);
    const bw: RGBA8[] = [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ];
    const noPalette: ConvertRecipe = { version: 1, quantize: {} };
    expect(code(() => runRecipe(img, noPalette))).toBe('BAD_PALETTE');
    const ctx = runRecipe(img, noPalette, { palette: bw });
    expect(ctx.report.paletteSize).toBe(2);
    const wrapped = runRecipe(img, noPalette, { palette: { colors: bw } });
    expect(wrapped.image).toEqual(ctx.image);
    // the recipe's own palette wins over the context
    const own = runRecipe(img, { version: 1, quantize: { palette: ART_PALETTE } }, { palette: bw });
    expect(own.report.paletteSize).toBe(6);
  });

  it("spread 'auto' is the palette-derived value and equals passing that number", () => {
    const grey = fromAscii(['aaaabbbbccccdddd', 'aaaabbbbccccdddd'], {
      a: [30, 30, 30, 255],
      b: [90, 90, 90, 255],
      c: [150, 150, 150, 255],
      d: [210, 210, 210, 255],
    });
    const pal: RGBA8[] = [
      [0, 0, 0, 255],
      [85, 85, 85, 255],
      [170, 170, 170, 255],
      [255, 255, 255, 255],
    ];
    const auto = runRecipe(grey, { version: 1, quantize: { palette: pal, dither: 'bayer4' } });
    expect(auto.report.ditherSpread).toBe(85);
    const explicit = runRecipe(grey, {
      version: 1,
      quantize: { palette: pal, dither: 'bayer4', spread: 85 },
    });
    expect(auto.image).toEqual(explicit.image);
    const direct = quantize(grey, pal, { dither: 'bayer4', spread: 85 }).image;
    expect(auto.image).toEqual(direct);
    // not reported for modes that do not use it
    const none = runRecipe(grey, { version: 1, quantize: { palette: pal } });
    expect(none.report.ditherSpread).toBeUndefined();
  });

  it('step errors keep their codes', () => {
    const img = randomArt(8, 8, 1);
    expect(code(() => runRecipe(img, { version: 1, crop: { x: 5, y: 0, w: 9, h: 1 } }))).toBe(
      'BAD_RECT',
    );
    expect(code(() => runRecipe(img, { version: 1, downscale: { method: 'box', width: 9 } }))).toBe(
      'BAD_OPTION',
    );
    expect(code(() => runRecipe(img, { version: 2 } as unknown as ConvertRecipe))).toBe(
      'BAD_RECIPE',
    );
  });

  it('does not change its input and is deterministic', () => {
    const wide = fakePixelArt(randomArt(14, 12, 21), 21);
    const copy = wide.data.slice();
    const a = runRecipe(wide, FULL);
    const b = runRecipe(wide, FULL);
    expect(wide.data).toEqual(copy);
    expect(hashRGBA(a.image)).toBe(hashRGBA(b.image));
    expect(a.report).toEqual(b.report);
  });

  it('cleanup outline offset is reported and the canvas grows', () => {
    const r = runRecipe(randomArt(6, 6, 8), {
      version: 1,
      cleanup: { outline: { color: [1, 2, 3] } },
    });
    expect(r.report.cleanup?.offset).toEqual({ x: 1, y: 1 });
    expect(r.image.width).toBe(8);
    expect(r.report.steps.at(-1)).toEqual({ step: 'cleanup', width: 8, height: 8 });
  });
});

describe('autoDitherSpread', () => {
  const c = (v: number): RGBA8 => [v, v, v, 255];
  it('black and white give 255; a grey ramp gives its step', () => {
    expect(autoDitherSpread([c(0), c(255)])).toBe(255);
    expect(autoDitherSpread([c(0), c(85), c(170), c(255)])).toBe(85);
    expect(autoDitherSpread([c(0), c(16), c(32), c(48)])).toBe(16);
  });
  it('is at least 1 and at most 255; ignores alpha 0 entries and duplicates', () => {
    expect(autoDitherSpread([c(10), c(11)])).toBe(1);
    expect(autoDitherSpread([c(0), [255, 255, 255, 0], c(255), c(255)])).toBe(255);
  });
  it('falls back to 64 with fewer than two distinct visible colours', () => {
    expect(autoDitherSpread([c(5)])).toBe(64);
    expect(autoDitherSpread([c(5), c(5)])).toBe(64);
    expect(autoDitherSpread([c(5), [9, 9, 9, 0]])).toBe(64);
  });
  it('accepts an object with colors', () => {
    expect(autoDitherSpread({ colors: [c(0), c(255)] })).toBe(255);
  });
});

describe('recipe: pinned hashes', () => {
  it('the full pipeline on fake pixel art', () => {
    const wide = fakePixelArt(randomArt(14, 12, 31), 31);
    const flat = runRecipe(wide, {
      version: 1,
      crop: { x: 6, y: 12, w: 60, h: 48 },
      background: { mode: 'flood', color: MAGENTA, tolerance: 30 },
      downscale: { method: 'kcentroid', grid: 'auto' },
      cleanup: { orphanMinSize: 3, outline: { color: 'darken' } },
      quantize: { palette: ART_PALETTE, dither: 'floyd-steinberg', strength: 0.5 },
    });
    const ordered = runRecipe(wide, {
      version: 1,
      downscale: { method: 'box', grid: 'auto' },
      quantize: { palette: ART_PALETTE.slice(0, 3), dither: 'bayer8' },
    });
    expect([hashRGBA(flat.image), hashRGBA(ordered.image)]).toEqual(PINNED);
  });
});

const PINNED = [
  'e12d50a75fa6c725cccc4ec1642928b9e37ea4085db44fd80b6d8bc581cf7717',
  'a61eac90a9fe7599db879171406283765017b06034e5e406db98612e428cf9f0',
];
