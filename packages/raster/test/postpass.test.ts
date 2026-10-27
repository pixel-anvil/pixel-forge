import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import { IndexedImage, RasterError, TiledImage, outline, removeOrphans } from '../src/index.js';
import type { OutlineOptions } from '../src/index.js';

// X = opaque white shape, o = red outline, h = half-transparent green (alpha 128, counts as opaque).
const legend = {
  X: [255, 255, 255, 255],
  o: [255, 0, 0, 255],
  h: [0, 255, 0, 128],
} as const;
const RED = [255, 0, 0, 255] as const;

const img = (ascii: string): TiledImage => TiledImage.fromRGBA(asciiToImage(ascii, legend));
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof RasterError ? e.code : 'other';
  }
  return undefined;
};

/** Outlines `shape` and compares the (w+2) x (h+2) result with `expected`. */
function check(shape: string, expected: string, opts?: OutlineOptions): void {
  // Expectations below are written for square corners unless a test says otherwise.
  const res = outline(img(shape), RED, { corners: 'square', ...opts });
  expectAscii(res.img.toRGBA(), expected, legend);
}

describe('outline: ASCII expectations', () => {
  it('single pixel: square gets the 8-neighbour ring, round omits the diagonals', () => {
    check('X', 'ooo\noXo\nooo', { corners: 'square' });
    check('X', '.o.\noXo\n.o.', { corners: 'round' });
  });

  it('defaults are outsideOnly and round (matches the schema: corners absent = false)', () => {
    expectAscii(outline(img('X'), RED).img.toRGBA(), '.o.\noXo\n.o.', legend);
  });

  it('2x2 block', () => {
    check('XX\nXX', 'oooo\noXXo\noXXo\noooo', { corners: 'square' });
    check('XX\nXX', '.oo.\noXXo\noXXo\n.oo.', { corners: 'round' });
  });

  it('L-shape: the concave corner pixel is outlined in both modes', () => {
    const L = 'X..\nX..\nXXX';
    check(L, 'ooo..\noXo..\noXooo\noXXXo\nooooo', { corners: 'square' });
    check(L, '.o...\noXo..\noXoo.\noXXXo\n.ooo.', { corners: 'round' });
  });

  it('diagonal line: square connects the corners, round leaves diagonal gaps out', () => {
    const D = 'X..\n.X.\n..X';
    check(D, 'ooo..\noXoo.\nooXoo\n.ooXo\n..ooo', { corners: 'square' });
    check(D, '.o...\noXo..\n.oXo.\n..oXo\n...o.', { corners: 'round' });
  });

  it('ring with a hole: outsideOnly true skips the hole, false fills it', () => {
    const ring = 'XXX\nX.X\nXXX';
    check(ring, 'ooooo\noXXXo\noX.Xo\noXXXo\nooooo', { outsideOnly: true });
    check(ring, 'ooooo\noXXXo\noXoXo\noXXXo\nooooo', { outsideOnly: false });
    check(ring, '.ooo.\noXXXo\noX.Xo\noXXXo\n.ooo.', { outsideOnly: true, corners: 'round' });
    check(ring, '.ooo.\noXXXo\noXoXo\noXXXo\n.ooo.', { outsideOnly: false, corners: 'round' });
  });

  it('a bigger hole is only outlined along its rim when outsideOnly is false', () => {
    const ring = 'XXXXX\nX...X\nX...X\nX...X\nXXXXX';
    check(ring, 'ooooooo\noXXXXXo\noXoooXo\noXo.oXo\noXoooXo\noXXXXXo\nooooooo', {
      outsideOnly: false,
      corners: 'square',
    });
  });

  it('a hole closed only diagonally is still a hole (4-connected outside)', () => {
    check('.X.\nX.X\n.X.', '.ooo.\nooXoo\noX.Xo\nooXoo\n.ooo.', { outsideOnly: true });
  });

  it('shapes touching the image border are not clipped: the canvas grows by 1 px', () => {
    const res = outline(img('XX'), RED, { corners: 'square' });
    expect([res.img.width, res.img.height]).toEqual([4, 3]);
    expect(res.offset).toEqual({ x: 1, y: 1 });
    expectAscii(res.img.toRGBA(), 'oooo\noXXo\noooo', legend);
    check('XXX\nXXX\nXXX', 'ooooo\noXXXo\noXXXo\noXXXo\nooooo');
  });

  it('keeps source pixels exactly (also partial alpha) and never paints over them', () => {
    check('hX', 'oooo\nohXo\noooo');
  });

  it('an empty image yields an empty grown image', () => {
    const res = outline(new TiledImage(2, 2), RED, { corners: 'square' });
    expect([res.img.width, res.img.height]).toEqual([4, 4]);
    expect(res.img.bounds()).toBeUndefined();
  });

  it('does not modify the input', () => {
    const src = img('X');
    const before = src.hashRGBA();
    outline(src, RED, { corners: 'square' });
    expect(src.hashRGBA()).toBe(before);
    expect(src.width).toBe(1);
  });

  it('rejects bad options and colours', () => {
    expect(code(() => outline(img('X'), [1, 2, 3, 0]))).toBe('BAD_VALUE');
    expect(code(() => outline(img('X'), 3 as never))).toBe('BAD_VALUE');
    expect(code(() => outline(img('X'), RED, { corners: 'bevel' as never }))).toBe('BAD_VALUE');
    const idx = new IndexedImage(1, 1, 0);
    expect(code(() => outline(idx, 0))).toBe('BAD_VALUE');
    expect(code(() => outline(idx, RED as never))).toBe('BAD_VALUE');
  });
});

describe('outline: indexed images', () => {
  it('outlines with a palette index and keeps the transparent index', () => {
    const src = IndexedImage.fromIndices(2, 2, Uint8Array.from([0, 1, 0, 0]), 0);
    const { img: out, offset } = outline(src, 2, { corners: 'round' });
    expect(offset).toEqual({ x: 1, y: 1 });
    expect(out.transparentIndex).toBe(0);
    // grown 4x4: pixel (1,0) -> (2,1); round ring around it
    expect(Array.from(out.toIndices())).toEqual([0, 0, 2, 0, 0, 2, 1, 2, 0, 0, 2, 0, 0, 0, 0, 0]);
  });

  it('honours a non-zero transparent index', () => {
    const src = IndexedImage.fromIndices(1, 1, Uint8Array.from([5]), 7);
    const { img: out } = outline(src, 1, { corners: 'square' });
    expect(Array.from(out.toIndices())).toEqual([1, 1, 1, 1, 5, 1, 1, 1, 1]);
    const { img: out2 } = outline(IndexedImage.fromIndices(1, 1, Uint8Array.from([7]), 7), 1);
    expect(out2.bounds()).toBeUndefined();
  });
});

describe('removeOrphans: ASCII expectations', () => {
  const shape = 'X....\n..XX.\n..XX.\n....X';

  const run = (
    ascii: string,
    opts: Parameters<typeof removeOrphans>[1],
    expected: string,
    removed: number,
  ): void => {
    const res = removeOrphans(img(ascii), opts);
    expectAscii(res.img.toRGBA(), expected, legend);
    expect(res.removed).toBe(removed);
  };

  it('defaults (minNeighbours 1, 8-connected): only fully isolated pixels go', () => {
    run(shape, {}, '.....\n..XX.\n..XX.\n....X', 1);
  });

  it('minNeighbours 1, 4-connected: a diagonal-only neighbour does not count', () => {
    run(shape, { connectivity: 4 }, '.....\n..XX.\n..XX.\n.....', 2);
  });

  it('minNeighbours 2, 8-connected', () => {
    run(shape, { minNeighbours: 2, connectivity: 8 }, '.....\n..XX.\n..XX.\n.....', 2);
  });

  it('minNeighbours 2, 4-connected: the 2x2 block pixels have exactly 2 edge neighbours', () => {
    run(shape, { minNeighbours: 2, connectivity: 4 }, '.....\n..XX.\n..XX.\n.....', 2);
  });

  it('minNeighbours 3, 4-connected removes the whole block too', () => {
    run(shape, { minNeighbours: 3, connectivity: 4 }, '.....\n.....\n.....\n.....', 6);
  });

  it('is single-pass: a 3-pixel line with minNeighbours 2 loses only its ends', () => {
    run('XXX', { minNeighbours: 2 }, '.X.', 2);
    run('XXX', { minNeighbours: 2, connectivity: 4 }, '.X.', 2);
  });

  it('minNeighbours 0 removes nothing', () => {
    run(shape, { minNeighbours: 0 }, shape, 0);
  });

  it('outside the image counts as empty; border pixels with a neighbour survive', () => {
    run('XX.\n...\n..X', {}, 'XX.\n...\n...', 1);
    run('XX', { minNeighbours: 2 }, '..', 2);
  });

  it('partial alpha counts as opaque', () => {
    run('hX', {}, 'hX', 0);
  });

  it('empty image: nothing to remove', () => {
    const res = removeOrphans(new TiledImage(3, 3));
    expect(res.removed).toBe(0);
  });

  it('does not modify the input', () => {
    const src = img(shape);
    const before = src.hashRGBA();
    const res = removeOrphans(src);
    expect(src.hashRGBA()).toBe(before);
    expect(res.img).not.toBe(src);
  });

  it('rejects bad options', () => {
    expect(code(() => removeOrphans(img('X'), { minNeighbours: 9 }))).toBe('BAD_VALUE');
    expect(code(() => removeOrphans(img('X'), { minNeighbours: 1.5 }))).toBe('BAD_VALUE');
    expect(code(() => removeOrphans(img('X'), { minNeighbours: -1 }))).toBe('BAD_VALUE');
    expect(code(() => removeOrphans(img('X'), { connectivity: 6 as never }))).toBe('BAD_VALUE');
  });

  it('works on indexed images with their transparent index', () => {
    // 3x2, transparent index 9: (0,0) is an orphan, (2,0),(2,1) form a pair
    const src = IndexedImage.fromIndices(3, 2, Uint8Array.from([4, 9, 5, 9, 9, 5]), 9);
    const res = removeOrphans(src);
    expect(res.removed).toBe(1);
    expect(Array.from(res.img.toIndices())).toEqual([9, 9, 5, 9, 9, 5]);
    expect(res.img.transparentIndex).toBe(9);
  });
});
