import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '@pixel-forge/raster';
import { ConvertError, detectGrid } from '../src/index.js';
import type { ConvertErrorCode, GridDetection } from '../src/index.js';
import { perturb, randomArt, rng, upscale, upscaleWithPhase } from './synth.js';

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

function solid(w: number, h: number, rgba: readonly number[]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) data.set(rgba, p * 4);
  return { width: w, height: h, data };
}

function grid(d: GridDetection): [number, number, number, number] | false {
  return d.found ? [d.cellWidth, d.cellHeight, d.offsetX, d.offsetY] : false;
}

describe('detectGrid: oracle (known cell size and phase)', () => {
  const cases: [number, number, number][] = [];
  for (let s = 2; s <= 12; s++)
    for (const ph of new Set([0, 1, s - 1, s >> 1])) cases.push([s, ph, (s * 7 + ph) % s]);

  it.each(cases)('square cell %i, phase x %i, phase y %i', (s, ox, oy) => {
    const src = randomArt(16, 12, 1000 + s * 31 + ox);
    const img = upscaleWithPhase(src, s, s, ox, oy, s >> 2, (s + 1) >> 2);
    const d = detectGrid(img);
    expect(grid(d)).toEqual([s, s, ox, oy]);
    expect(d.found && d.confidence).toBe(1);
    expect(grid(detectGrid(img, { square: true }))).toEqual([s, s, ox, oy]);
  });

  it.each([
    [2, 3, 1, 2],
    [3, 5, 0, 4],
    [4, 2, 3, 1],
    [6, 9, 2, 7],
    [12, 4, 11, 0],
    [5, 8, 4, 3],
  ])('non-square cell %ix%i, phase %i,%i', (cw, ch, ox, oy) => {
    const src = randomArt(14, 11, 77 + cw * ch);
    const img = upscaleWithPhase(src, cw, ch, ox, oy, 1, 0);
    expect(grid(detectGrid(img))).toEqual([cw, ch, ox, oy]);
  });

  it.each([2, 3, 4, 5, 6, 8, 10, 12])('cell %i with +-8 noise and softened boundaries', (s) => {
    const ox = s - 1;
    const oy = s >> 1;
    const src = randomArt(16, 16, 500 + s);
    const img = perturb(upscaleWithPhase(src, s, s, ox, oy), 9 + s, 8, { cw: s, ch: s, ox, oy });
    const d = detectGrid(img);
    expect(grid(d)).toEqual([s, s, ox, oy]);
    expect(d.found && d.confidence).toBeGreaterThan(0.8);
  });

  it('cell 4 with heavy noise (+-16): found, and a higher noise floor raises the confidence', () => {
    const src = randomArt(16, 16, 4242);
    const img = perturb(upscale(src, 4, 4), 3, 16);
    const plain = detectGrid(img);
    const floored = detectGrid(img, { noiseFloor: 60 });
    expect(grid(plain)).toEqual([4, 4, 0, 0]);
    expect(grid(floored)).toEqual([4, 4, 0, 0]);
    expect(floored.confidence).toBeGreaterThan(plain.confidence);
  });

  it('a fractional scale (2.5) is not a whole-pixel grid: no grid (documented limit)', () => {
    const src = randomArt(20, 20, 1);
    const n = 50;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = (Math.floor(y / 2.5) * 20 + Math.floor(x / 2.5)) * 4;
        data.set(src.data.subarray(s, s + 4), (y * n + x) * 4);
      }
    }
    expect(detectGrid({ width: n, height: n, data })).toMatchObject({
      found: false,
      reason: 'no-period',
    });
  });

  it('a sprite on a transparent background (sparse edges)', () => {
    // A 6x6 figure in the middle of a 16x16 transparent canvas, upscaled by 5.
    const src = randomArt(16, 16, 9);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (x < 5 || x > 10 || y < 5 || y > 10)
          src.data.fill(0, (y * 16 + x) * 4, (y * 16 + x) * 4 + 4);
      }
    }
    expect(grid(detectGrid(upscale(src, 5, 5)))).toEqual([5, 5, 0, 0]);
  });

  it('art drawn in 2x2 blocks then upscaled by 3 reports the coarsest grid, 6', () => {
    const src = upscale(randomArt(10, 10, 5), 2, 2);
    expect(grid(detectGrid(upscale(src, 3, 3)))).toEqual([6, 6, 0, 0]);
  });

  it('maxCell bounds the search', () => {
    const img = upscale(randomArt(12, 12, 8), 10, 10);
    const d = detectGrid(img, { maxCell: 8 });
    // 10 is out of reach; its divisors 2 and 5 still fit every edge.
    expect(grid(d)).toEqual([5, 5, 0, 0]);
  });
});

describe('detectGrid: no grid', () => {
  it('native pixel art (1 pixel per cell)', () => {
    const d = detectGrid(randomArt(48, 40, 3));
    expect(d).toMatchObject({ found: false, reason: 'no-period' });
    expect(d.confidence).toBeLessThan(0.5);
    expect(detectGrid(randomArt(48, 40, 3), { square: true })).toMatchObject({
      found: false,
      reason: 'no-period',
    });
  });

  it('a smooth photo-like image with noise', () => {
    const w = 64;
    const h = 48;
    const next = rng(11);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const r = ((x - 30) * (x - 30) + (y - 20) * (y - 20)) % 255;
        data[o] = r;
        data[o + 1] = (x * 4 + (next() % 40)) % 256;
        data[o + 2] = (y * 5 + (next() % 40)) % 256;
        data[o + 3] = 255;
      }
    }
    expect(detectGrid({ width: w, height: h, data })).toMatchObject({
      found: false,
      reason: 'no-period',
    });
  });

  it('a flat image', () => {
    expect(detectGrid(solid(20, 20, [10, 20, 30, 255]))).toEqual({
      found: false,
      reason: 'flat',
      confidence: 0,
    });
    expect(detectGrid(solid(20, 20, [0, 0, 0, 0]), { square: true })).toMatchObject({
      reason: 'flat',
    });
  });

  it('stripes in one direction are flat without square, found with square', () => {
    const src = randomArt(12, 1, 6);
    const tall: RgbaImage = upscale(src, 4, 20);
    expect(detectGrid(tall)).toMatchObject({ found: false, reason: 'flat' });
    expect(detectGrid(tall, { square: true })).toMatchObject({
      found: true,
      cellWidth: 4,
      cellHeight: 4,
      offsetX: 0,
      offsetY: 0,
      confidenceY: 0,
    });
  });

  it('too few grid lines', () => {
    // Two edges only: a single bar. Many periods fit, so no answer.
    const img = solid(40, 40, [0, 0, 0, 0]);
    for (let y = 0; y < 40; y++)
      for (let x = 12; x < 28; x++) img.data.set([200, 0, 0, 255], (y * 40 + x) * 4);
    expect(detectGrid(img)).toMatchObject({ found: false });
  });

  it.each([
    [1, 1],
    [5, 30],
    [30, 5],
    [2, 2],
  ])('too small: %ix%i', (w, h) => {
    expect(detectGrid(randomArt(w, h, 1))).toEqual({
      found: false,
      reason: 'too-small',
      confidence: 0,
    });
  });

  it('square mode needs only one long axis', () => {
    const img = upscale(randomArt(8, 1, 2), 3, 3);
    expect(grid(detectGrid(img, { square: true }))).toEqual([3, 3, 0, 0]);
  });
});

describe('detectGrid: options and purity', () => {
  it.each([
    [{ maxCell: 1 }],
    [{ maxCell: 257 }],
    [{ maxCell: 2.5 }],
    [{ minConfidence: 0 }],
    [{ minConfidence: 1.5 }],
    [{ minConfidence: Number.NaN }],
    [{ noiseFloor: -1 }],
    [{ noiseFloor: 1021 }],
    [{ noiseFloor: 0.5 }],
  ])('refuses %j', (opts) => {
    expect(code(() => detectGrid(randomArt(8, 8, 1), opts))).toBe('BAD_OPTION');
  });

  it('refuses a malformed image', () => {
    expect(code(() => detectGrid({ width: 2, height: 2, data: new Uint8Array(4) }))).toBe(
      'BAD_IMAGE',
    );
  });

  it('does not change the input', () => {
    const img = upscale(randomArt(8, 8, 1), 3, 3);
    const before = img.data.slice();
    detectGrid(img);
    expect(img.data).toEqual(before);
  });
});
