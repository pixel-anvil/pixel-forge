import { describe, expect, it } from 'vitest';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { oklabToSrgb8, srgb8ToOklab } from '@pixel-forge/color';
import type { Oklab } from '@pixel-forge/color';
import { ConvertError, DOWNSCALE_METHODS, detectGrid, downscale } from '../src/index.js';
import type { ConvertErrorCode, DownscaleMethod, DownscaleOptions } from '../src/index.js';
import { maxDiff, perturb, randomArt, upscale, upscaleWithPhase } from './synth.js';

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

/** Image from rows of RGBA quads. */
function img(w: number, h: number, px: readonly (readonly number[])[]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  px.forEach((c, i) => {
    data.set(c, i * 4);
  });
  return { width: w, height: h, data };
}

function pixels(im: RgbaImage): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < im.width * im.height; i++) out.push([...im.data.subarray(i * 4, i * 4 + 4)]);
  return out;
}

const R = [255, 0, 0, 255];
const G = [0, 255, 0, 255];
const B = [0, 0, 255, 255];
const T = [0, 0, 0, 0];
const EXACT: readonly DownscaleMethod[] = ['nearest', 'mode', 'kcentroid'];

describe('downscale: round trip of upscaled art (oracle: the source)', () => {
  const cases: [number, number, number, number][] = [];
  // A left or top remnant is at least half a cell (ceil(s/2)): thinner slivers are dropped (below).
  for (let s = 2; s <= 12; s++) cases.push([s, s, (s + 1) >> 1, (s * 5) % s]);
  cases.push([2, 3, 1, 0], [3, 5, 2, 4], [7, 4, 0, 3], [12, 6, 11, 5]);

  it.each(cases)(
    'cell %ix%i, phase %i,%i: every method gives the source back',
    (cw, ch, ox, oy) => {
      const src = randomArt(13, 9, 300 + cw * 13 + ch);
      const up = upscaleWithPhase(src, cw, ch, ox, oy, cw >> 1, ch >> 2);
      const grid = { cellWidth: cw, cellHeight: ch, offsetX: ox, offsetY: oy };
      for (const method of DOWNSCALE_METHODS) {
        const out = downscale(up, { method, grid });
        expect([out.width, out.height]).toEqual([13, 9]);
        expect(out.data, method).toEqual(src.data);
      }
    },
  );

  it.each([2, 3, 4, 6, 9, 12])('detect then downscale, cell %i', (s) => {
    const src = randomArt(16, 12, 40 + s);
    const up = upscaleWithPhase(src, s, s, s - 1, (s + 1) >> 1);
    const d = detectGrid(up);
    if (!d.found) throw new Error('grid not found');
    for (const method of DOWNSCALE_METHODS)
      expect(downscale(up, { method, grid: d }).data).toEqual(src.data);
  });

  it.each([3, 4, 6, 8])('cell %i with +-8 noise: within 8 per channel (box within 4)', (s) => {
    const src = randomArt(16, 16, 70 + s);
    const up = perturb(upscale(src, s, s), 5 + s, 8);
    const d = detectGrid(up);
    if (!d.found) throw new Error('grid not found');
    expect([d.cellWidth, d.offsetX]).toEqual([s, 0]);
    for (const method of EXACT) {
      const out = downscale(up, { method, grid: d });
      expect(maxDiff(out, src), method).toBeLessThanOrEqual(8);
    }
    // The mean of s*s noise samples is close to the true colour.
    expect(maxDiff(downscale(up, { method: 'box', grid: d }), src)).toBeLessThanOrEqual(
      s >= 4 ? 4 : 6,
    );
  });

  it('size target equal to an integer factor gives the source back', () => {
    const src = randomArt(10, 7, 12);
    const up = upscale(src, 4, 4);
    for (const method of DOWNSCALE_METHODS) {
      expect(downscale(up, { method, width: 10 }).data).toEqual(src.data);
      expect(downscale(up, { method, height: 7 }).data).toEqual(src.data);
      expect(downscale(up, { method, width: 10, height: 7 }).data).toEqual(src.data);
    }
  });
});

describe('downscale: cells and targets', () => {
  it('keeps the aspect with integer rounding', () => {
    const src = randomArt(10, 6, 1);
    expect(downscale(src, { method: 'box', width: 5 })).toMatchObject({ width: 5, height: 3 });
    expect(downscale(src, { method: 'box', width: 3 })).toMatchObject({ width: 3, height: 2 }); // 1.8
    expect(downscale(src, { method: 'box', width: 1 })).toMatchObject({ width: 1, height: 1 }); // 0.6
    expect(downscale(src, { method: 'box', height: 4 })).toMatchObject({ width: 7, height: 4 }); // 6.67
    expect(downscale(randomArt(9, 1, 2), { method: 'box', width: 2 })).toMatchObject({
      width: 2,
      height: 1,
    });
  });

  it('uneven size cells follow floor(i*w/W)', () => {
    // 5 columns into 2: cells [0,2) and [2,5).
    const row = img(5, 1, [R, R, G, G, G]);
    expect(pixels(downscale(row, { method: 'mode', width: 2 }))).toEqual([R, G]);
    expect(pixels(downscale(row, { method: 'nearest', width: 2 }))).toEqual([R, G]);
  });

  it('same size target is a copy (not the same buffer)', () => {
    const src = randomArt(6, 5, 3);
    for (const method of DOWNSCALE_METHODS) {
      const out = downscale(src, { method, width: 6 });
      expect(out.data).toEqual(src.data);
      expect(out.data).not.toBe(src.data);
    }
  });

  it('1x1 image', () => {
    const one = img(1, 1, [[10, 20, 30, 255]]);
    for (const method of DOWNSCALE_METHODS) {
      expect(pixels(downscale(one, { method, width: 1 }))).toEqual([[10, 20, 30, 255]]);
      expect(
        pixels(
          downscale(one, { method, grid: { cellWidth: 4, cellHeight: 4, offsetX: 0, offsetY: 0 } }),
        ),
      ).toEqual([[10, 20, 30, 255]]);
    }
  });

  it('a grid larger than the image gives one partial cell; drop refuses it', () => {
    const tiny = img(2, 2, [R, R, R, G]);
    const grid = { cellWidth: 8, cellHeight: 8, offsetX: 3, offsetY: 0 };
    expect(pixels(downscale(tiny, { method: 'mode', grid }))).toEqual([R]);
    expect(code(() => downscale(tiny, { method: 'mode', grid, edges: 'drop' }))).toBe('BAD_OPTION');
  });

  it('edges: keep keeps partial cells of at least half a cell, drop removes all of them', () => {
    // 7 columns, cell 3, offset 2: cells [0,2) [2,5) [5,7) -> keep 3 (2 px >= 1.5), drop 1.
    const row = img(7, 1, [G, G, R, R, R, B, B]);
    const grid = { cellWidth: 3, cellHeight: 1, offsetX: 2, offsetY: 0 };
    expect(pixels(downscale(row, { method: 'mode', grid }))).toEqual([G, R, B]);
    expect(pixels(downscale(row, { method: 'mode', grid, edges: 'drop' }))).toEqual([R]);
    // Cell 4: a half cell (2 px) is kept, 1 px is a sliver.
    const half = { cellWidth: 4, cellHeight: 1, offsetX: 2, offsetY: 0 };
    expect(
      pixels(downscale(img(6, 1, [G, G, R, R, R, R]), { method: 'mode', grid: half })),
    ).toEqual([G, R]);
    expect(
      pixels(downscale(img(7, 1, [G, G, R, R, R, R, B]), { method: 'mode', grid: half })),
    ).toEqual([G, R]);
  });

  it('edges: keep drops a sliver of less than half a cell (no spurious extra pixel)', () => {
    // 41 columns, cell 4, offset 0: ten full cells and a 1 px remnant.
    const row = img(
      41,
      1,
      Array.from({ length: 41 }, (_, i) => (i === 40 ? B : (i >> 2) % 2 === 0 ? R : G)),
    );
    const grid = { cellWidth: 4, cellHeight: 1, offsetX: 0, offsetY: 0 };
    for (const method of DOWNSCALE_METHODS) {
      const out = downscale(row, { method, grid });
      expect(out.width, method).toBe(10);
      expect(pixels(downscale(row, { method, grid, edges: 'drop' })), method).toEqual(pixels(out));
    }
    // The same on the left (offset 1 of cell 4) and on both axes.
    const tall = img(
      2,
      9,
      Array.from({ length: 18 }, (_, i) => (i >> 1 === 0 ? B : R)),
    );
    const col = downscale(tall, {
      method: 'mode',
      grid: { cellWidth: 2, cellHeight: 4, offsetX: 0, offsetY: 1 },
    });
    expect([col.width, col.height]).toEqual([1, 2]);
  });

  it('edges: keep with no cell left on an axis makes the whole axis one cell', () => {
    // 5 columns, cell 8, offset 3: two slivers (3 and 2 px, both under 4) -> one cell.
    const row = img(5, 1, [G, G, G, R, R]);
    const grid = { cellWidth: 8, cellHeight: 1, offsetX: 3, offsetY: 0 };
    expect(pixels(downscale(row, { method: 'mode', grid }))).toEqual([G]);
    expect(code(() => downscale(row, { method: 'mode', grid, edges: 'drop' }))).toBe('BAD_OPTION');
  });

  it.each<[string, Partial<DownscaleOptions>]>([
    ['no target', {}],
    ['width larger than source', { width: 9 }],
    ['height larger than source', { height: 5 }],
    ['zero width', { width: 0 }],
    ['fractional height', { height: 1.5 }],
    ['grid and width', { width: 2, grid: { cellWidth: 2, cellHeight: 2, offsetX: 0, offsetY: 0 } }],
    ['cell 0', { grid: { cellWidth: 0, cellHeight: 2, offsetX: 0, offsetY: 0 } }],
    ['offset = cell', { grid: { cellWidth: 2, cellHeight: 2, offsetX: 2, offsetY: 0 } }],
    ['negative offset', { grid: { cellWidth: 2, cellHeight: 2, offsetX: 0, offsetY: -1 } }],
    ['edges with a size target', { width: 2, edges: 'drop' }],
    [
      'bad edges',
      { grid: { cellWidth: 2, cellHeight: 2, offsetX: 0, offsetY: 0 }, edges: 'all' as 'keep' },
    ],
    ['alphaThreshold 0', { width: 2, alphaThreshold: 0 }],
    ['alphaThreshold 256', { width: 2, alphaThreshold: 256 }],
    ['k 0', { width: 2, k: 0 }],
    ['k 9', { width: 2, k: 9 }],
    ['unknown method', { width: 2, method: 'bicubic' as DownscaleMethod }],
  ])('refuses: %s', (_, extra) => {
    const src = randomArt(8, 4, 1);
    expect(code(() => downscale(src, { method: 'box', ...extra }))).toBe('BAD_OPTION');
  });

  it('refuses a malformed image', () => {
    expect(
      code(() =>
        downscale({ width: 1, height: 1, data: new Uint8Array(3) }, { method: 'box', width: 1 }),
      ),
    ).toBe('BAD_IMAGE');
  });

  it('does not change the input', () => {
    const src = randomArt(8, 8, 2);
    const before = src.data.slice();
    for (const method of DOWNSCALE_METHODS) downscale(src, { method, width: 3 });
    expect(src.data).toEqual(before);
  });
});

describe('downscale: methods on hand-written cells', () => {
  const half = [0, 0, 255, 100];

  it('box averages with alpha weighting and rounds half up', () => {
    // [R, B] -> (127.5, 0, 127.5) -> 128, 0, 128
    expect(pixels(downscale(img(2, 1, [R, B]), { method: 'box', width: 1 }))).toEqual([
      [128, 0, 128, 255],
    ]);
    // R (alpha 255) and half-blue (alpha 100), threshold 1: RGB weighted by alpha, alpha is the mean.
    // r = 255*255/355 = 183.17, b = 255*100/355 = 71.83, a = 177.5 -> 183, 0, 72, 178
    expect(
      pixels(downscale(img(2, 1, [R, half]), { method: 'box', width: 1, alphaThreshold: 1 })),
    ).toEqual([[183, 0, 72, 178]]);
  });

  it('alpha: transparent majority becomes 0,0,0,0, a tie keeps the visible colour', () => {
    const tie = img(2, 2, [R, T, T, R]);
    const minority = img(2, 2, [T, T, T, [9, 9, 9, 255]]);
    for (const method of DOWNSCALE_METHODS) {
      expect(pixels(downscale(tie, { method, width: 1 })), method).toEqual([R]);
      expect(pixels(downscale(minority, { method, width: 1 })), method).toEqual([T]);
    }
    // Alpha 100 is hidden under the default threshold 128, visible with threshold 100.
    const soft = img(2, 1, [half, half]);
    expect(pixels(downscale(soft, { method: 'mode', width: 1 }))).toEqual([T]);
    expect(pixels(downscale(soft, { method: 'mode', width: 1, alphaThreshold: 100 }))).toEqual([
      half,
    ]);
  });

  it('hidden pixels never leak their RGB', () => {
    // Two red pixels and one "hidden" green pixel with alpha 50.
    const cell = img(3, 1, [R, [0, 255, 0, 50], R]);
    for (const method of DOWNSCALE_METHODS)
      expect(pixels(downscale(cell, { method, width: 1 }))).toEqual([R]);
  });

  it('nearest takes the centre, the top-left of the middle 2x2 for even cells', () => {
    const odd = img(3, 3, [G, G, G, G, R, G, G, G, G]);
    expect(pixels(downscale(odd, { method: 'nearest', width: 1 }))).toEqual([R]);
    const even = img(4, 4, [G, G, G, G, G, R, B, G, G, B, B, G, G, G, G, G]);
    expect(pixels(downscale(even, { method: 'nearest', width: 1 }))).toEqual([R]);
    // Centre hidden: the nearest visible pixel (first in row-major order on ties).
    const hole = img(3, 3, [G, B, G, R, T, G, G, G, G]);
    expect(pixels(downscale(hole, { method: 'nearest', width: 1 }))).toEqual([B]);
  });

  it('mode takes the most common colour, the first seen on ties', () => {
    expect(pixels(downscale(img(5, 1, [R, G, G, B, R]), { method: 'mode', width: 1 }))).toEqual([
      R,
    ]);
    expect(pixels(downscale(img(5, 1, [B, G, G, B, G]), { method: 'mode', width: 1 }))).toEqual([
      G,
    ]);
  });

  it('kcentroid keeps the dominant cluster and averages it in OKLab', () => {
    // 5 near-reds and 4 blues: the red cluster wins; its centroid lies inside the reds' box.
    const reds = [
      [250, 0, 0, 255],
      [255, 4, 0, 255],
      [252, 0, 6, 255],
      [255, 0, 0, 255],
      [248, 2, 2, 255],
    ];
    const cell = img(
      3,
      3,
      [R, B, R, B, R, B, R, B, R].map((c, i) => (c === R ? (reds[i >> 1] ?? R) : c)),
    );
    const px = pixels(downscale(cell, { method: 'kcentroid', width: 1 }))[0] ?? [];
    for (let ch = 0; ch < 3; ch++) {
      const vs = reds.map((r) => r[ch] ?? 0);
      expect(px[ch]).toBeGreaterThanOrEqual(Math.min(...vs));
      expect(px[ch]).toBeLessThanOrEqual(Math.max(...vs));
    }
    expect(px[3]).toBe(255);
    // Box mixes to purple; mode picks the one most common colour, blue.
    expect((pixels(downscale(cell, { method: 'box', width: 1 }))[0] ?? [])[2]).toBeGreaterThan(100);
    expect(pixels(downscale(cell, { method: 'mode', width: 1 }))).toEqual([B]);
  });

  it('kcentroid: k=1 is the OKLab mean; k >= distinct colours is the mode', () => {
    const cell = img(4, 2, [R, G, B, R, G, R, B, G]);
    const labs = [R, G, B].map((c) => srgb8ToOklab(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0));
    const w = [3, 3, 2];
    const mean = (f: (l: Oklab) => number): number =>
      labs.reduce((s, l, i) => s + f(l) * (w[i] ?? 0), 0) / 8;
    const expected = [
      ...oklabToSrgb8({ L: mean((l) => l.L), a: mean((l) => l.a), b: mean((l) => l.b) }),
      255,
    ];
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1, k: 1 }))).toEqual([expected]);
    // Three clusters of one colour each: R and G tie at 3, the first seeded (R, seen first) wins.
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1, k: 3 }))).toEqual([R]);
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1, k: 8 }))).toEqual([R]);
  });

  it('kcentroid terminates on a cell of many colours', () => {
    const out = downscale(randomArt(16, 16, 99), { method: 'kcentroid', width: 1, k: 8 });
    expect([out.width, out.height]).toEqual([1, 1]);
  });

  it('kcentroid with a single distinct colour per cluster returns it exactly (alpha included)', () => {
    const cell = img(3, 1, [
      [10, 20, 30, 200],
      [10, 20, 30, 200],
      [200, 200, 200, 255],
    ]);
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1 }))).toEqual([[10, 20, 30, 200]]);
  });

  it('kcentroid counts one RGB at several alphas as one colour: exact RGB, mean alpha', () => {
    const RA = [255, 0, 0, 200];
    // R has weight 1 + 2 = 3 and ties with G (3): the tie goes to the colour seen first, R. (Counted
    // per RGBA, G with 3 would have been the single heaviest colour and won.)
    const cell = img(3, 2, [R, G, RA, G, RA, G]);
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1 }))).toEqual([[255, 0, 0, 218]]);
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1, k: 1 }))[0]?.[3]).toBe(
      Math.round((255 + 2 * 200 + 3 * 255) / 6),
    );
    // Only one RGB, three alphas: that RGB exactly.
    const solid = img(3, 1, [
      [12, 200, 77, 255],
      [12, 200, 77, 200],
      [12, 200, 77, 130],
    ]);
    expect(pixels(downscale(solid, { method: 'kcentroid', width: 1 }))).toEqual([
      [12, 200, 77, 195],
    ]);
  });

  it('kcentroid assigns once more against the final centres when the iteration cap ends the loop', () => {
    // A 7x7 cell of near-random colours with k=4 does not converge in 16 iterations. Before the
    // final assignment the weights and the centre of the heaviest cluster came from the previous
    // assignment (old result 168,228,137).
    const px = [
      [139, 10, 132],
      [219, 241, 212],
      [69, 233, 33],
      [55, 216, 6],
      [133, 4, 105],
      [109, 36, 136],
      [102, 242, 143],
      [106, 62, 122],
      [206, 50, 141],
      [196, 241, 198],
      [194, 200, 102],
      [44, 181, 76],
      [1, 171, 71],
      [151, 251, 54],
      [23, 163, 84],
      [202, 7, 168],
      [186, 112, 171],
      [187, 204, 203],
      [237, 48, 106],
      [24, 28, 81],
      [13, 70, 0],
      [122, 182, 158],
      [92, 74, 148],
      [210, 212, 153],
      [243, 190, 217],
      [91, 129, 75],
      [127, 163, 102],
      [194, 97, 131],
      [183, 75, 150],
      [50, 245, 96],
      [133, 224, 67],
      [145, 222, 126],
      [61, 189, 49],
      [217, 230, 148],
      [101, 160, 160],
      [212, 174, 200],
      [247, 12, 181],
      [112, 106, 90],
      [223, 135, 132],
      [193, 255, 132],
      [235, 62, 209],
      [247, 48, 132],
      [137, 122, 130],
      [224, 32, 116],
      [69, 127, 34],
      [19, 66, 16],
      [245, 4, 136],
      [44, 67, 86],
      [208, 11, 150],
    ];
    const cell = img(
      7,
      7,
      px.map((c) => [...c, 255]),
    );
    expect(pixels(downscale(cell, { method: 'kcentroid', width: 1, k: 4 }))).toEqual([
      [172, 225, 142, 255],
    ]);
  });
});

describe('downscale: determinism', () => {
  const runAll = (): string[] => {
    const src = randomArt(24, 18, 2026);
    const up = perturb(upscaleWithPhase(src, 5, 5, 2, 3), 7, 10);
    const d = detectGrid(up);
    if (!d.found) throw new Error('grid not found');
    return [
      JSON.stringify(d),
      ...DOWNSCALE_METHODS.map((method) => hashRGBA(downscale(up, { method, grid: d }))),
      ...DOWNSCALE_METHODS.map((method) => hashRGBA(downscale(up, { method, width: 31 }))),
      hashRGBA(downscale(up, { method: 'kcentroid', width: 17, k: 4 })),
    ];
  };

  it('same input, same output, run twice', () => {
    expect(runAll()).toEqual(runAll());
  });

  it('pinned hashes', () => {
    expect(runAll()).toEqual(EXPECTED);
  });
});

const EXPECTED: string[] = [
  '{"found":true,"cellWidth":5,"cellHeight":5,"offsetX":2,"offsetY":3,"confidence":0.989,"confidenceX":0.989,"confidenceY":0.99}',
  '394c132a5ed30128e6130d52cb7d2809d5d2bac9ea02b36fb6280f33de0a50ed', // grid, box
  '0f4349e8edda92904271d2fe0b0414baf0fc223b2025e71c84a64964d4346c41', // grid, kcentroid
  '6fbeec9b1034e1b50154458636bddfddb49efc38aae38bdde9e97793388a4773', // grid, nearest
  '2b24acd5ae4b13892ea94b3e1dfb230eefc1370ec7014e8ba7428e87b3aa5776', // grid, mode
  'cfde3aadb3d37de3399e927505fe38077e724ecbdd8d1bb22ea4f1fef287d10c', // width 31, box
  '6c39fa332f831c924a9cc565e6f925226a93cb1aa9b0d1c0e043babd5b216bff', // width 31, kcentroid
  '4a626c20bbecf48c31229401a2c9f2ee7757e968a42a2a3eb33e4cd55be15171', // width 31, nearest
  'feaed9cce41f0917824b160d5e3b26b3f94702d61aaf1328ef8177cd469b0fab', // width 31, mode
  '8074fbb3603395a72c8bd5ad7e33f3e1a6d2a00ccc7b3b8fad6e59616453f70a', // width 17, kcentroid k=4
];
