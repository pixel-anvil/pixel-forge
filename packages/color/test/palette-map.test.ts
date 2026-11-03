// Mapping tables for palette remaps: known answers and refusals.
import type { RGBA8 } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { applyColorTable, applyIndexLut, colorTable, indexLut, swapPairs } from '../src/index.js';

const RED: RGBA8 = [255, 0, 0, 255];
const BLUE: RGBA8 = [0, 0, 255, 255];
const CLEAR: RGBA8 = [0, 0, 0, 0];

describe('indexLut', () => {
  it('is the identity except for the listed pairs, applied at once', () => {
    const lut = indexLut(
      [
        [1, 2],
        [2, 1],
      ],
      4,
    );
    expect([...lut.slice(0, 5)]).toEqual([0, 2, 1, 3, 4]);
    expect(lut[200]).toBe(200);
  });

  it('refuses out-of-range and repeated sources', () => {
    expect(() => indexLut([[1, 4]], 4)).toThrow(RangeError);
    expect(() => indexLut([[-1, 0]], 4)).toThrow(RangeError);
    expect(() => indexLut([[1.5, 0]], 4)).toThrow(RangeError);
    expect(() =>
      indexLut(
        [
          [1, 2],
          [1, 3],
        ],
        4,
      ),
    ).toThrow(/twice/);
  });
});

describe('applyIndexLut', () => {
  it('counts changed pixels and skips the transparent index', () => {
    const idx = Uint8Array.from([0, 1, 2, 1, 3]);
    const lut = indexLut(
      [
        [1, 0],
        [0, 3],
      ],
      4,
    );
    expect(applyIndexLut(idx, lut, 0)).toBe(2);
    expect([...idx]).toEqual([0, 0, 2, 0, 3]);
  });
});

describe('colorTable and applyColorTable', () => {
  it('matches exact RGBA only and never touches alpha 0', () => {
    const table = colorTable([[RED, BLUE]]);
    const px = Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 254, 255, 0, 0, 0, 9, 9, 9, 255]);
    expect(applyColorTable(px, table)).toBe(1);
    expect([...px]).toEqual([0, 0, 255, 255, 255, 0, 0, 254, 255, 0, 0, 0, 9, 9, 9, 255]);
  });

  it('refuses transparent colours and repeated sources', () => {
    expect(() => colorTable([[CLEAR, BLUE]])).toThrow(/transparent/);
    expect(() => colorTable([[RED, CLEAR]])).toThrow(/transparent/);
    expect(() =>
      colorTable([
        [RED, BLUE],
        [RED, [7, 8, 9, 255]],
      ]),
    ).toThrow(/twice/);
  });
});

describe('swapPairs', () => {
  const a: RGBA8[] = [CLEAR, [1, 1, 1, 255], [2, 2, 2, 255]];
  it('pairs entry i with entry i, leaving out transparent and unchanged entries', () => {
    const b: RGBA8[] = [CLEAR, [1, 1, 1, 255], [9, 9, 9, 255]];
    expect(swapPairs(a, b)).toEqual([
      [
        [2, 2, 2, 255],
        [9, 9, 9, 255],
      ],
    ]);
  });

  it('refuses another length, moved transparency and ambiguity', () => {
    expect(() => swapPairs(a, a.slice(1))).toThrow(/length/);
    expect(() =>
      swapPairs(a, [
        [5, 5, 5, 255],
        [1, 1, 1, 255],
        [2, 2, 2, 255],
      ]),
    ).toThrow(/transparency/);
    const dup: RGBA8[] = [CLEAR, [1, 1, 1, 255], [1, 1, 1, 255]];
    expect(() => swapPairs(dup, [CLEAR, [3, 3, 3, 255], [4, 4, 4, 255]])).toThrow(/twice/);
    expect(swapPairs(dup, [CLEAR, [3, 3, 3, 255], [3, 3, 3, 255]])).toHaveLength(1);
  });
});
