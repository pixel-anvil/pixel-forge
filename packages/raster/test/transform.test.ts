import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  crop,
  flipH,
  flipV,
  IndexedImage,
  RasterError,
  rot180,
  rot270,
  rot90,
  scaleInt,
  TiledImage,
  translate,
} from '../src/index.js';
import { randomImage } from './util.js';

const legend = {
  R: [255, 0, 0, 255],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  K: [0, 0, 0, 255],
} as const;
const img = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof RasterError ? e.code : 'other';
  }
  return undefined;
};

const SRC = 'RGB\nK..';

describe('transforms: ASCII expectations', () => {
  it('flipH', () => {
    expectAscii(flipH(img(SRC)).toRGBA(), 'BGR\n..K', legend);
  });
  it('flipV', () => {
    expectAscii(flipV(img(SRC)).toRGBA(), 'K..\nRGB', legend);
  });
  it('rot90 is clockwise and swaps the dimensions', () => {
    const out = rot90(img(SRC));
    expect([out.width, out.height]).toEqual([2, 3]);
    expectAscii(out.toRGBA(), 'KR\n.G\n.B', legend);
  });
  it('rot180', () => {
    expectAscii(rot180(img(SRC)).toRGBA(), '..K\nBGR', legend);
  });
  it('rot270 is counter-clockwise', () => {
    const out = rot270(img(SRC));
    expect([out.width, out.height]).toEqual([2, 3]);
    expectAscii(out.toRGBA(), 'B.\nG.\nRK', legend);
  });
  it('scaleInt(2) makes 2x2 blocks', () => {
    const out = scaleInt(img('RG\n.B'), 2);
    expect([out.width, out.height]).toEqual([4, 4]);
    expectAscii(out.toRGBA(), 'RRGG\nRRGG\n..BB\n..BB', legend);
  });
  it('scaleInt(1) is a copy', () => {
    const a = img(SRC);
    expect(scaleInt(a, 1).equals(a)).toBe(true);
  });
  it('crop copies a rectangle; parts outside the source are empty', () => {
    expectAscii(crop(img('RGB\nKRG\nBKR'), { x: 1, y: 1, w: 2, h: 2 }).toRGBA(), 'RG\nKR', legend);
    expectAscii(crop(img('RG\nBK'), { x: -1, y: 1, w: 3, h: 2 }).toRGBA(), '.BK\n...', legend);
  });
  it('translate shifts and clips', () => {
    expectAscii(translate(img('RG.\nBK.'), 1, 1).toRGBA(), '...\n.RG', legend);
    expectAscii(translate(img('RG.\nBK.'), -1, 0).toRGBA(), 'G..\nK..', legend);
  });
  it('does not modify the input', () => {
    const a = img(SRC);
    const h = a.hashRGBA();
    flipH(a);
    rot90(a);
    scaleInt(a, 3);
    crop(a, { x: 0, y: 0, w: 1, h: 1 });
    translate(a, 1, 1);
    expect(a.hashRGBA()).toBe(h);
  });
});

describe('transforms: properties', () => {
  const sizes: [number, number][] = [
    [1, 1],
    [3, 2],
    [16, 16],
    [17, 33],
    [37, 21],
    [64, 40],
  ];

  it('flipping twice is the identity', () => {
    for (const [w, h] of sizes) {
      const a = randomImage(w, h, w * 31 + h);
      expect(flipH(flipH(a)).equals(a)).toBe(true);
      expect(flipV(flipV(a)).equals(a)).toBe(true);
      expect(flipH(flipV(a)).equals(rot180(a))).toBe(true);
    }
  });

  it('rot90 four times is the identity; 90 + 270 cancel; 180 = 90 twice', () => {
    for (const [w, h] of sizes) {
      const a = randomImage(w, h, w * 17 + h);
      const r1 = rot90(a);
      expect([r1.width, r1.height]).toEqual([h, w]);
      expect(rot90(rot90(rot90(r1))).equals(a)).toBe(true);
      expect(rot270(r1).equals(a)).toBe(true);
      expect(rot90(r1).equals(rot180(a))).toBe(true);
      expect(rot270(rot270(rot270(rot270(a)))).equals(a)).toBe(true);
    }
  });

  it('rot90 moves pixel (x, y) to (h-1-y, x) exactly', () => {
    const a = randomImage(21, 13, 4);
    const r = rot90(a);
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) expect(r.get(a.height - 1 - y, x)).toEqual(a.get(x, y));
    }
  });

  it('transforms preserve the pixel count and the hash is deterministic', () => {
    const a = randomImage(37, 21, 9);
    const count = (i: TiledImage): number => {
      let n = 0;
      for (let y = 0; y < i.height; y++)
        for (let x = 0; x < i.width; x++) if (i.get(x, y)[3] !== 0) n++;
      return n;
    };
    expect(count(rot90(a))).toBe(count(a));
    expect(count(flipH(a))).toBe(count(a));
    expect(rot90(a).hashRGBA()).toBe(rot90(a.clone()).hashRGBA());
  });

  it('scaleInt(k) then crop of a block returns the original pixel', () => {
    const a = randomImage(10, 9, 2);
    const k = 3;
    const s = scaleInt(a, k);
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const block = crop(s, { x: x * k, y: y * k, w: k, h: k });
        for (let j = 0; j < k; j++)
          for (let i = 0; i < k; i++) expect(block.get(i, j)).toEqual(a.get(x, y));
      }
    }
  });

  it('crop of the full rectangle and translate(0,0) are copies; translate there and back loses only the clipped edge', () => {
    const a = randomImage(30, 20, 6);
    expect(crop(a, { x: 0, y: 0, w: 30, h: 20 }).equals(a)).toBe(true);
    expect(translate(a, 0, 0).equals(a)).toBe(true);
    const there = translate(translate(a, 5, 3), -5, -3);
    const inner = crop(a, { x: 0, y: 0, w: 25, h: 17 });
    expect(crop(there, { x: 0, y: 0, w: 25, h: 17 }).equals(inner)).toBe(true);
  });

  it('results are fresh images (version 0, no history) and stay sparse', () => {
    const a = new TiledImage(256, 256);
    a.set(3, 3, [1, 2, 3, 255]);
    const r = rot90(a);
    expect(r.version).toBe(0);
    expect(r.tilesChanged(0)).toEqual([]);
    expect(r.tileCount).toBe(1);
    expect(scaleInt(a, 4).tileCount).toBe(1);
  });
});

describe('transforms on IndexedImage', () => {
  it('keep the kind and the transparent index', () => {
    const a = new IndexedImage(3, 2, 5);
    a.set(0, 0, 1);
    a.set(2, 1, 2);
    const r = rot90(a);
    expect(r).toBeInstanceOf(IndexedImage);
    expect(r.transparentIndex).toBe(5);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(r.get(1, 0)).toBe(1);
    expect(r.get(0, 2)).toBe(2);
    expect(r.get(0, 0)).toBe(5);
    expect(flipH(flipH(a)).equals(a)).toBe(true);
    expect(scaleInt(a, 2).get(5, 3)).toBe(2);
    expect(crop(a, { x: 2, y: 1, w: 1, h: 1 }).get(0, 0)).toBe(2);
  });
});

describe('transforms: errors', () => {
  it('rejects bad arguments with typed errors', () => {
    const a = img(SRC);
    expect(code(() => scaleInt(a, 0))).toBe('BAD_SIZE');
    expect(code(() => scaleInt(a, 1.5))).toBe('NON_INTEGER');
    expect(code(() => scaleInt(a, 1 << 20))).toBe('BAD_SIZE');
    expect(code(() => crop(a, { x: 0, y: 0, w: 0, h: 1 }))).toBe('BAD_SIZE');
    expect(code(() => crop(a, { x: 0.5, y: 0, w: 1, h: 1 }))).toBe('NON_INTEGER');
    expect(code(() => translate(a, 1, NaN))).toBe('NON_INTEGER');
  });
});
