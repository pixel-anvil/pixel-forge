import { describe, expect, it } from 'vitest';
import { hashRGBA } from '@pixel-forge/raster';
import { ConvertError, DEFAULT_ALPHA_THRESHOLD, cleanup } from '../src/index.js';
import type { CleanupOptions, ConvertErrorCode } from '../src/index.js';
import { fromAscii, toAscii } from './ascii.js';
import type { Legend } from './ascii.js';
import { randomArt } from './synth.js';

const L: Legend = {
  '.': [0, 0, 0, 0],
  '#': [200, 100, 50, 255],
  o: [10, 20, 30, 255],
  r: [255, 0, 0, 255],
  d: [100, 50, 25, 255],
};

function code(fn: () => unknown): ConvertErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConvertError) return e.code;
    throw e;
  }
  return undefined;
}

const run = (rows: readonly string[], opts?: CleanupOptions): string[] =>
  toAscii(cleanup(fromAscii(rows, L), opts).image, L);

describe('cleanup: alpha threshold', () => {
  it('is one cut at the threshold, keeps RGB of visible pixels, sets alpha 255', () => {
    const data = new Uint8Array([10, 20, 30, 127, 10, 20, 30, 128, 1, 2, 3, 255, 9, 9, 9, 0]);
    const out = cleanup({ width: 4, height: 1, data }, { orphanMinSize: 1 }).image.data;
    expect([...out]).toEqual([0, 0, 0, 0, 10, 20, 30, 255, 1, 2, 3, 255, 0, 0, 0, 0]);
  });

  it('uses the shared default (128) and a custom value', () => {
    expect(DEFAULT_ALPHA_THRESHOLD).toBe(128);
    const img = { width: 1, height: 1, data: new Uint8Array([5, 5, 5, 100]) };
    expect(cleanup(img, { orphanMinSize: 1 }).image.data[3]).toBe(0);
    expect(cleanup(img, { orphanMinSize: 1, alphaThreshold: 100 }).image.data[3]).toBe(255);
    expect(cleanup(img, { orphanMinSize: 1, alphaThreshold: 101 }).image.data[3]).toBe(0);
  });

  it('does not change its input', () => {
    const img = fromAscii(['#.', '.#'], L);
    const copy = img.data.slice();
    cleanup(img, { outline: {} });
    expect(img.data).toEqual(copy);
  });
});

describe('cleanup: orphans', () => {
  it('removes isolated pixels by default and keeps components of 2 or more', () => {
    expect(
      run(['#.....#', '.......', '..##...', '.......', '.....#.', '.....#.', '.......']),
    ).toEqual(['.......', '.......', '..##...', '.......', '.....#.', '.....#.', '.......']);
  });

  it('reports the number of removed pixels', () => {
    const r = cleanup(fromAscii(['#...', '....', '..#.', '...#'], L));
    expect(r.removedPixels).toBe(1);
    expect(r.outlinePixels).toBe(0);
    expect(r.offset).toEqual({ x: 0, y: 0 });
  });

  it('8-connectivity (default) keeps a diagonal line; 4-connectivity removes it', () => {
    const rows = ['#...', '.#..', '..#.', '...#'];
    expect(run(rows)).toEqual(rows);
    expect(run(rows, { connectivity: 4 })).toEqual(['....', '....', '....', '....']);
  });

  it('orphanMinSize removes every component smaller than it', () => {
    const rows = ['##.....', '.......', '.###...', '.......', '.....##'];
    expect(run(rows, { orphanMinSize: 3 })).toEqual([
      '.......',
      '.......',
      '.###...',
      '.......',
      '.......',
    ]);
    expect(run(rows, { orphanMinSize: 4 })).toEqual(Array<string>(5).fill('.......'));
  });

  it('orphanMinSize 1 removes nothing', () => {
    const rows = ['#..#', '....', '..#.'];
    expect(run(rows, { orphanMinSize: 1 })).toEqual(rows);
  });

  it('counts pixels of a component whatever their colour', () => {
    expect(run(['#o..', '....', '..r.'])).toEqual(['#o..', '....', '....']);
  });

  it('property: after the default clean-up no visible pixel is without a visible 8-neighbour', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const img = randomArt(15, 11, seed);
      const out = cleanup(img).image;
      for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
          if (out.data[(y * out.width + x) * 4 + 3] === 0) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (
                (dx !== 0 || dy !== 0) &&
                nx >= 0 &&
                ny >= 0 &&
                nx < out.width &&
                ny < out.height
              ) {
                if (out.data[(ny * out.width + nx) * 4 + 3] !== 0) n++;
              }
            }
          }
          expect(n).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is idempotent without an outline', () => {
    const once = cleanup(randomArt(20, 20, 9)).image;
    expect(hashRGBA(cleanup(once).image)).toBe(hashRGBA(once));
  });
});

describe('cleanup: outline', () => {
  const block = ['.....', '.###.', '.###.', '.###.', '.....'];

  it('round corners: 4-neighbour ring, canvas grows by 1 on each side, opaque pixels kept', () => {
    const r = cleanup(fromAscii(block, L), { outline: { color: [255, 0, 0] } });
    expect(toAscii(r.image, L)).toEqual([
      '.......',
      '..rrr..',
      '.r###r.',
      '.r###r.',
      '.r###r.',
      '..rrr..',
      '.......',
    ]);
    expect(r.outlinePixels).toBe(12);
    expect(r.offset).toEqual({ x: 1, y: 1 });
  });

  it('square corners fill the diagonal pixels', () => {
    const r = cleanup(fromAscii(block, L), { outline: { color: [255, 0, 0], corners: 'square' } });
    expect(toAscii(r.image, L)).toEqual([
      '.......',
      '.rrrrr.',
      '.r###r.',
      '.r###r.',
      '.r###r.',
      '.rrrrr.',
      '.......',
    ]);
    expect(r.outlinePixels).toBe(16);
  });

  it('outlines a sprite that touches the border without clipping (canvas grows)', () => {
    const r = cleanup(fromAscii(['##', '##'], L), { outline: { color: [255, 0, 0] } });
    expect(toAscii(r.image, L)).toEqual(['.rr.', 'r##r', 'r##r', '.rr.']);
  });

  it("canvas 'keep' crops back to the input size and loses outline outside it", () => {
    const touching = cleanup(fromAscii(['##', '##'], L), {
      outline: { color: [255, 0, 0], canvas: 'keep' },
    });
    expect(toAscii(touching.image, L)).toEqual(['##', '##']);
    expect(touching.outlinePixels).toBe(0);
    expect(touching.offset).toEqual({ x: 0, y: 0 });
    const inner = cleanup(fromAscii(block, L), { outline: { color: [255, 0, 0], canvas: 'keep' } });
    expect(toAscii(inner.image, L)).toEqual(['.rrr.', 'r###r', 'r###r', 'r###r', '.rrr.']);
    expect(inner.outlinePixels).toBe(12);
  });

  it('does not outline holes', () => {
    const ring = ['#####', '#...#', '#.#.#', '#...#', '#####'];
    expect(
      toAscii(
        cleanup(fromAscii(ring, L), { orphanMinSize: 1, outline: { color: [255, 0, 0] } }).image,
        L,
      ),
    ).toEqual(['.rrrrr.', 'r#####r', 'r#...#r', 'r#.#.#r', 'r#...#r', 'r#####r', '.rrrrr.']);
  });

  it('never overwrites a visible pixel', () => {
    const img = fromAscii(['#o#', 'o#o', '#o#'], L);
    const out = cleanup(img, { outline: { color: [255, 0, 0] } }).image;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const a = (y * 3 + x) * 4;
        const b = ((y + 1) * out.width + x + 1) * 4;
        expect([...out.data.subarray(b, b + 4)]).toEqual([...img.data.subarray(a, a + 4)]);
      }
    }
  });

  it("'darken' (default) scales the colour of the single touching pixel", () => {
    const r = cleanup(fromAscii(['#'], L), {
      orphanMinSize: 1,
      outline: { shade: 50 },
    });
    expect(toAscii(r.image, L)).toEqual(['.d.', 'd#d', '.d.']);
    // default shade 35 percent, rounded half up: 200 -> 70, 100 -> 35, 50 -> 18
    const def = cleanup(fromAscii(['#'], L), { orphanMinSize: 1, outline: {} });
    expect([...def.image.data.subarray(4, 8)]).toEqual([70, 35, 18, 255]);
  });

  it("'darken' uses the mean of all touching visible pixels", () => {
    // the gap above '#' and 'o' touches '#' (left), 'o' (right) and '#' (below)
    const r = cleanup(fromAscii(['#.o', '###'], L), { outline: { shade: 100 } });
    const o = (1 * r.image.width + 2) * 4; // input (1,0) -> output (2,1)
    // gap pixel: mean of (200,100,50), (10,20,30), (200,100,50) rounded half up = 137, 73, 43
    expect([...r.image.data.subarray(o, o + 4)]).toEqual([137, 73, 43, 255]);
  });

  it('outline pixels are opaque even when the threshold left RGB at low alpha', () => {
    const img = { width: 1, height: 1, data: new Uint8Array([90, 90, 90, 200]) };
    const out = cleanup(img, { orphanMinSize: 1, outline: { color: [1, 2, 3] } }).image;
    expect([...out.data.subarray(4, 8)]).toEqual([1, 2, 3, 255]);
    expect(out.data[(1 * 3 + 1) * 4 + 3]).toBe(255);
  });

  it('outline on an empty image adds nothing but grows the canvas', () => {
    const r = cleanup(fromAscii(['...', '...'], L), { outline: {} });
    expect(r.image.width).toBe(5);
    expect(r.outlinePixels).toBe(0);
  });
});

describe('cleanup: errors', () => {
  const img = fromAscii(['#'], L);
  it.each<[string, CleanupOptions, ConvertErrorCode]>([
    ['threshold 0', { alphaThreshold: 0 }, 'BAD_OPTION'],
    ['threshold 256', { alphaThreshold: 256 }, 'BAD_OPTION'],
    ['threshold 1.5', { alphaThreshold: 1.5 }, 'BAD_OPTION'],
    ['orphanMinSize 0', { orphanMinSize: 0 }, 'BAD_OPTION'],
    ['orphanMinSize 2.5', { orphanMinSize: 2.5 }, 'BAD_OPTION'],
    ['connectivity 6', { connectivity: 6 as 4 }, 'BAD_OPTION'],
    ['shade 101', { outline: { shade: 101 } }, 'BAD_OPTION'],
    ['colour out of range', { outline: { color: [0, 0, 256] } }, 'BAD_OPTION'],
    [
      'colour wrong length',
      { outline: { color: [0, 0] as unknown as [number, number, number] } },
      'BAD_OPTION',
    ],
    ['corners', { outline: { corners: 'x' as 'round' } }, 'BAD_OPTION'],
    ['canvas', { outline: { canvas: 'x' as 'grow' } }, 'BAD_OPTION'],
  ])('%s is refused', (_name, opts, expected) => {
    expect(code(() => cleanup(img, opts))).toBe(expected);
  });

  it('a malformed image is refused', () => {
    expect(code(() => cleanup({ width: 2, height: 2, data: new Uint8Array(3) }))).toBe('BAD_IMAGE');
  });
});

describe('cleanup: pinned hash', () => {
  it('is stable', () => {
    const r = cleanup(randomArt(24, 24, 77), { orphanMinSize: 3, outline: { color: 'darken' } });
    expect(hashRGBA(r.image)).toBe(PINNED_CLEANUP);
  });
});

const PINNED_CLEANUP = 'f8d0c005e4f8809251e280f8e1881fa36194d6dc0b6436236057890d3c6444a2';
