import { describe, expect, it } from 'vitest';
import { generatePalette, srgb8ToOklab } from '@pixel-forge/color';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import {
  ConvertError,
  TRANSPARENT_INDEX,
  bayerMatrix,
  bayerThreshold,
  quantize,
} from '../src/index.js';
import type { ConvertErrorCode, DitherMode } from '../src/index.js';

const BLACK: RGBA8 = [0, 0, 0, 255];
const WHITE: RGBA8 = [255, 255, 255, 255];
const RED: RGBA8 = [255, 0, 0, 255];
const GREEN: RGBA8 = [0, 255, 0, 255];
const BLUE: RGBA8 = [0, 0, 255, 255];

function solid(w: number, h: number, c: RGBA8): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(c, i * 4);
  return { width: w, height: h, data };
}

function fromPixels(w: number, pixels: readonly RGBA8[]): RgbaImage {
  const data = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => {
    data.set(p, i * 4);
  });
  return { width: w, height: pixels.length / w, data };
}

/** Rows of `#` (white) and `.` (black) for an image quantised to black and white. */
function bw(img: RgbaImage): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      row += img.data[i + 3] === 0 ? '_' : img.data[i] === 255 ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

describe('bayer matrices', () => {
  it('match the published matrices', () => {
    expect(bayerMatrix(2)).toEqual([0, 2, 3, 1]);
    expect(bayerMatrix(4)).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    expect(bayerMatrix(8).slice(0, 8)).toEqual([0, 32, 8, 40, 2, 34, 10, 42]);
    expect(bayerMatrix(8).slice(56)).toEqual([63, 31, 55, 23, 61, 29, 53, 21]);
  });

  it.each([2, 4, 8] as const)('%i x %i holds every index once and thresholds are centred', (n) => {
    const m = [...bayerMatrix(n)].sort((a, b) => a - b);
    expect(m).toEqual(Array.from({ length: n * n }, (_, i) => i));
    let sum = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) sum += bayerThreshold(n, x, y);
    expect(sum).toBeCloseTo(0, 12);
    expect(bayerThreshold(n, n, n)).toBe(bayerThreshold(n, 0, 0));
  });
});

describe('quantize: nearest colour', () => {
  it('maps pixels to the nearest palette colour', () => {
    const img = fromPixels(4, [
      [250, 10, 10, 255],
      [10, 240, 20, 255],
      [20, 20, 200, 255],
      [30, 30, 30, 255],
    ]);
    const r = quantize(img, [RED, GREEN, BLUE, BLACK, WHITE]);
    expect(Array.from(r.indices)).toEqual([0, 1, 2, 3]);
    expect(Array.from(r.image.data)).toEqual([...RED, ...GREEN, ...BLUE, ...BLACK]);
  });

  it('judges distance in OKLab, not sRGB', () => {
    // Mid grey 100: sRGB distance prefers black (100 vs 155), OKLab lightness says mid grey 100 is
    // closer to black too but 120 vs white is the case: sRGB halfway is 128, OKLab halfway is lower.
    const r = quantize(solid(1, 1, [118, 118, 118, 255]), [BLACK, WHITE]);
    expect(r.indices[0]).toBe(1);
  });

  it('breaks ties to the lowest palette index', () => {
    const r = quantize(solid(2, 1, [10, 20, 30, 255]), [RED, RED, RED]);
    expect(Array.from(r.indices)).toEqual([0, 0]);
    const r2 = quantize(solid(1, 1, [10, 20, 30, 255]), [BLACK, BLACK]);
    expect(r2.indices[0]).toBe(0);
  });

  it('accepts a generated palette as is', () => {
    const src = fromPixels(2, [RED, GREEN, BLUE, WHITE]);
    const gen = generatePalette(src.data, { n: 4 });
    const r = quantize(src, gen);
    expect(r.indices.length).toBe(4);
    expect(new Set(r.indices).size).toBe(4);
  });

  it('does not change the input', () => {
    const img = solid(2, 2, [10, 200, 30, 255]);
    const copy = new Uint8Array(img.data);
    quantize(img, [RED, GREEN], { dither: 'floyd-steinberg' });
    expect(Array.from(img.data)).toEqual(Array.from(copy));
  });
});

describe('quantize: alpha', () => {
  it('turns pixels below the threshold transparent and the rest opaque', () => {
    const img = fromPixels(4, [
      [255, 0, 0, 0],
      [255, 0, 0, 127],
      [255, 0, 0, 128],
      [255, 0, 0, 255],
    ]);
    const r = quantize(img, [RED, BLUE]);
    expect(Array.from(r.indices)).toEqual([TRANSPARENT_INDEX, TRANSPARENT_INDEX, 0, 0]);
    expect(Array.from(r.image.data.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(r.image.data.subarray(8))).toEqual([...RED, ...RED]);
  });

  it('honours alphaThreshold and never picks a transparent palette entry', () => {
    const img = fromPixels(2, [
      [0, 0, 0, 10],
      [0, 0, 0, 255],
    ]);
    const pal: RGBA8[] = [
      [0, 0, 0, 0],
      [40, 40, 40, 255],
    ];
    const r = quantize(img, pal, { alphaThreshold: 5 });
    expect(Array.from(r.indices)).toEqual([1, 1]);
    const r0 = quantize(img, pal, { alphaThreshold: 0 });
    expect(Array.from(r0.indices)).toEqual([1, 1]);
  });

  it('transparent pixels send no error to their neighbours (Floyd-Steinberg)', () => {
    const a = fromPixels(3, [
      [120, 120, 120, 255],
      [0, 0, 0, 0],
      [120, 120, 120, 255],
    ]);
    const b = fromPixels(3, [
      [120, 120, 120, 255],
      [9, 9, 9, 0],
      [120, 120, 120, 255],
    ]);
    const ra = quantize(a, [BLACK, WHITE], { dither: 'floyd-steinberg' });
    const rb = quantize(b, [BLACK, WHITE], { dither: 'floyd-steinberg' });
    expect(Array.from(ra.indices)).toEqual(Array.from(rb.indices));
    // the right pixel starts fresh, so it equals the plain nearest colour
    expect(ra.indices[2]).toBe(
      quantize(solid(1, 1, [120, 120, 120, 255]), [BLACK, WHITE]).indices[0],
    );
  });

  it('an all-transparent image gives an all-transparent result', () => {
    const r = quantize(solid(3, 2, [5, 5, 5, 0]), [RED], { dither: 'bayer4' });
    expect(Array.from(r.indices)).toEqual(new Array<number>(6).fill(-1));
    expect(r.image.data.every((v) => v === 0)).toBe(true);
  });
});

describe('quantize: ordered dither', () => {
  it('bayer2 on flat grey 120 with a black-white palette is a checkerboard', () => {
    // offsets at spread 255: (0,0) -95.6, (1,0) +31.9, (0,1) +95.6, (1,1) -31.9
    const r = quantize(solid(4, 4, [120, 120, 120, 255]), [BLACK, WHITE], {
      dither: 'bayer2',
      spread: 255,
    });
    expect(bw(r.image)).toEqual(['.#.#', '#.#.', '.#.#', '#.#.']);
  });

  it('bayer2 on dark and light flat greys gives sparse patterns', () => {
    const dark = quantize(solid(2, 2, [20, 20, 20, 255]), [BLACK, WHITE], {
      dither: 'bayer2',
      spread: 255,
    });
    expect(bw(dark.image)).toEqual(['..', '#.']); // only the +95.6 cell crosses the OKLab midpoint
    const light = quantize(solid(2, 2, [160, 160, 160, 255]), [BLACK, WHITE], {
      dither: 'bayer2',
      spread: 255,
    });
    expect(bw(light.image)).toEqual(['.#', '##']); // only the -95.6 cell drops to black
  });

  it.each(['bayer4', 'bayer8'] as const)(
    '%s has a flat-grey pattern that tiles and is balanced',
    (mode) => {
      const n = mode === 'bayer4' ? 4 : 8;
      const r = quantize(solid(2 * n, 2 * n, [128, 128, 128, 255]), [BLACK, WHITE], {
        dither: mode,
        spread: 255,
      });
      const rows = bw(r.image);
      for (let y = 0; y < n; y++) {
        expect(rows[y]?.slice(0, n)).toBe(rows[y]?.slice(n));
        expect(rows[y]).toBe(rows[y + n]);
      }
      const whites = rows.join('').split('#').length - 1;
      expect(whites).toBeGreaterThan(n * n * 4 * 0.4);
      expect(whites).toBeLessThan(n * n * 4 * 0.9);
    },
  );

  it('a ramp gets more white as the grey rises', () => {
    let last = -1;
    for (let g = 0; g <= 255; g += 15) {
      const r = quantize(solid(8, 8, [g, g, g, 255]), [BLACK, WHITE], {
        dither: 'bayer8',
        spread: 255,
      });
      const whites = Array.from(r.indices).filter((i) => i === 1).length;
      expect(whites).toBeGreaterThanOrEqual(last);
      last = whites;
    }
    expect(last).toBe(64);
  });

  it('strength 0 equals none, small strength leaves a flat colour alone', () => {
    const img = solid(4, 4, [120, 120, 120, 255]);
    for (const mode of ['bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'] as DitherMode[]) {
      const z = quantize(img, [BLACK, WHITE], { dither: mode, strength: 0 });
      const n = quantize(img, [BLACK, WHITE]);
      expect(Array.from(z.indices)).toEqual(Array.from(n.indices));
    }
    const low = quantize(img, [BLACK, WHITE], { dither: 'bayer4', spread: 255, strength: 0.05 });
    expect(new Set(low.indices).size).toBe(1);
  });
});

describe('quantize: Floyd-Steinberg', () => {
  /** Independent 1-D oracle for grey on a black-white palette: lightness error goes right (7/16). */
  function oracleRow(grey: number, n: number): string {
    const lWhite = srgb8ToOklab(255, 255, 255).L;
    let carry = 0;
    let out = '';
    const base = srgb8ToOklab(grey, grey, grey).L;
    for (let i = 0; i < n; i++) {
      const v = base + carry;
      const white = Math.abs(v - lWhite) < Math.abs(v - 0);
      out += white ? '#' : '.';
      carry = ((v - (white ? lWhite : 0)) * 7) / 16;
    }
    return out;
  }

  it('propagates error along a single row exactly like the oracle', () => {
    const r = quantize(solid(12, 1, [120, 120, 120, 255]), [BLACK, WHITE], {
      dither: 'floyd-steinberg',
    });
    expect(bw(r.image)[0]).toBe(oracleRow(120, 12));
    expect(bw(r.image)[0]).toContain('.');
    expect(bw(r.image)[0]).toContain('#');
  });

  it('sends 5/16 of the error down in a one-pixel-wide column', () => {
    const lWhite = srgb8ToOklab(255, 255, 255).L;
    const base = srgb8ToOklab(120, 120, 120).L;
    let carry = 0;
    let want = '';
    for (let i = 0; i < 10; i++) {
      const v = base + carry;
      const white = Math.abs(v - lWhite) < Math.abs(v);
      want += white ? '#' : '.';
      carry = ((v - (white ? lWhite : 0)) * 5) / 16;
    }
    const r = quantize(solid(1, 10, [120, 120, 120, 255]), [BLACK, WHITE], {
      dither: 'floyd-steinberg',
    });
    expect(bw(r.image).join('')).toBe(want);
  });

  it('first pixel equals the plain nearest colour and exact palette colours stay put', () => {
    const img = fromPixels(3, [BLACK, WHITE, BLACK, WHITE, BLACK, WHITE]);
    const r = quantize(img, [BLACK, WHITE], { dither: 'floyd-steinberg' });
    expect(Array.from(r.indices)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('keeps the mean lightness of a flat region close to the input', () => {
    const r = quantize(solid(32, 32, [120, 120, 120, 255]), [BLACK, WHITE], {
      dither: 'floyd-steinberg',
    });
    const white = Array.from(r.indices).filter((i) => i === 1).length / 1024;
    const l = srgb8ToOklab(120, 120, 120).L / srgb8ToOklab(255, 255, 255).L;
    expect(Math.abs(white - l)).toBeLessThan(0.03);
  });

  it('lower strength moves toward none monotonically in error count', () => {
    const img = solid(16, 16, [120, 120, 120, 255]);
    const none = quantize(img, [BLACK, WHITE]).indices;
    const diff = (s: number): number => {
      const r = quantize(img, [BLACK, WHITE], { dither: 'floyd-steinberg', strength: s }).indices;
      return Array.from(r).filter((v, i) => v !== none[i]).length;
    };
    expect(diff(0)).toBe(0);
    expect(diff(0.02)).toBeLessThanOrEqual(diff(0.5));
    expect(diff(0.5)).toBeLessThanOrEqual(diff(1));
    expect(diff(1)).toBeGreaterThan(0);
  });
});

describe('quantize: edge cases and errors', () => {
  it('handles a 1x1 image in every mode', () => {
    for (const mode of ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'] as DitherMode[]) {
      const r = quantize(solid(1, 1, [250, 5, 5, 255]), [BLUE, RED], { dither: mode });
      expect(Array.from(r.indices)).toEqual([1]);
      expect(r.image.width).toBe(1);
    }
  });

  it('a one-colour palette maps everything to it', () => {
    const r = quantize(fromPixels(2, [RED, GREEN, BLUE, WHITE]), [[9, 8, 7, 255]], {
      dither: 'floyd-steinberg',
    });
    expect(Array.from(r.indices)).toEqual([0, 0, 0, 0]);
    expect(Array.from(r.image.data.subarray(0, 4))).toEqual([9, 8, 7, 255]);
  });

  it('accepts exactly 256 colours and refuses 257', () => {
    const pal = (n: number): RGBA8[] => Array.from({ length: n }, (_, i) => [i % 256, 0, 0, 255]);
    expect(quantize(solid(1, 1, RED), pal(256)).indices[0]).toBe(255);
    expect(code(() => quantize(solid(1, 1, RED), pal(257)))).toBe('BAD_PALETTE');
  });

  it('rejects bad input with typed errors', () => {
    const img = solid(2, 2, RED);
    expect(code(() => quantize(img, []))).toBe('BAD_PALETTE');
    expect(code(() => quantize(img, [[0, 0, 0, 0]]))).toBe('BAD_PALETTE');
    expect(code(() => quantize(img, [[300, 0, 0, 255]]))).toBe('BAD_PALETTE');
    expect(code(() => quantize({ width: 0, height: 1, data: new Uint8Array(0) }, [RED]))).toBe(
      'BAD_IMAGE',
    );
    expect(code(() => quantize(img, [RED], { strength: 1.5 }))).toBe('BAD_OPTION');
    expect(code(() => quantize(img, [RED], { strength: Number.NaN }))).toBe('BAD_OPTION');
    expect(code(() => quantize(img, [RED], { spread: 0 }))).toBe('BAD_OPTION');
    expect(code(() => quantize(img, [RED], { alphaThreshold: 256 }))).toBe('BAD_OPTION');
    expect(code(() => quantize(img, [RED], { dither: 'bayer16' as DitherMode }))).toBe(
      'BAD_OPTION',
    );
  });
});

describe('quantize: determinism', () => {
  /** A fixed 24x24 colour gradient with a transparent corner. */
  function testImage(): RgbaImage {
    const w = 24;
    const data = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = Math.floor((x * 255) / 23);
        data[i + 1] = Math.floor((y * 255) / 23);
        data[i + 2] = (x * 7 + y * 13) % 256;
        data[i + 3] = x < 3 && y < 3 ? 0 : 255;
      }
    }
    return { width: w, height: w, data };
  }
  const PAL: RGBA8[] = [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [190, 38, 51, 255],
    [224, 111, 139, 255],
    [73, 60, 43, 255],
    [164, 100, 34, 255],
    [47, 72, 78, 255],
    [68, 137, 26, 255],
    [27, 38, 50, 255],
    [49, 162, 242, 255],
  ];
  const PINNED: Record<string, string> = {
    none: 'd4bd15957368edd58520a757c244794bac43965a28f84d5e4d88c77dc442bb7d',
    bayer2: 'be647f9623d3f632356490ac2234dcb6b2e5e6a6efdd84f18b52db81726989ec',
    bayer4: '96e44d5a44d3da5f289705f1f1d3014f31e283325a9b47e5a8425c7943ab134f',
    bayer8: '15f9fa4ebce933f8da6ccd5091055cb33e73b0079bde5d96475003e75671d2aa',
    'floyd-steinberg': '09c0be8887b129313ae6850d3e722c0de9021284e5e6250f3437e3acb2b5c850',
    'floyd-steinberg@0.5': 'b01b8a6dab42168e19f80e2918c8fdf764fbab6c777ea5a4e0b6c5bcc717b31a',
  };
  const hashFor = (key: string): string => {
    const [mode, s] = key.split('@');
    const r = quantize(testImage(), PAL, {
      dither: mode as DitherMode,
      strength: s === undefined ? 1 : Number(s),
    });
    return hashRGBA(r.image);
  };

  it.each(Object.keys(PINNED))('%s has a pinned hash and repeats', (key) => {
    const h = hashFor(key);
    expect(hashFor(key)).toBe(h);
    expect(h).toBe(PINNED[key]);
  });
});
