import { TILE_SIZE } from '@pixel-forge/schema';
import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import { IndexedImage, MAX_DIMENSION, RasterError, TiledImage } from '../src/index.js';
import type { Rgba } from '../src/index.js';
import { randomImage } from './util.js';

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const legend = { R: RED, B: BLUE, G: [0, 255, 0, 255] } as const;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof RasterError ? e.code : 'other';
  }
  return undefined;
}

describe('TiledImage basics', () => {
  it('starts empty: transparent everywhere, no tiles, no bytes, no bounds', () => {
    const img = new TiledImage(40, 20);
    expect([img.width, img.height, img.tilesX, img.tilesY]).toEqual([40, 20, 3, 2]);
    expect(img.get(39, 19)).toEqual([0, 0, 0, 0]);
    expect(img.tileCount).toBe(0);
    expect(img.byteSize()).toBe(0);
    expect(img.bounds()).toBeUndefined();
    expect(img.version).toBe(0);
  });

  it('get / set round trip and ASCII view', () => {
    const img = new TiledImage(3, 2);
    expect(img.set(0, 0, RED)).toBe(true);
    expect(img.set(2, 1, BLUE)).toBe(true);
    expect(img.get(0, 0)).toEqual(RED);
    expectAscii(img.toRGBA(), 'R..\n..B', legend);
  });

  it('out of bounds: get is transparent, set is a no-op returning false', () => {
    const img = new TiledImage(4, 4);
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [4, 0],
      [0, 4],
      [100, 100],
    ] as const) {
      expect(img.get(x, y)).toEqual([0, 0, 0, 0]);
      expect(img.set(x, y, RED)).toBe(false);
    }
    expect(img.tileCount).toBe(0);
    expect(img.version).toBe(0);
  });

  it('rejects non-integer coordinates, bad channels and bad sizes with typed errors', () => {
    const img = new TiledImage(4, 4);
    expect(code(() => img.get(0.5, 0))).toBe('NON_INTEGER');
    expect(code(() => img.set(NaN, 0, RED))).toBe('NON_INTEGER');
    expect(code(() => img.set(0, 0, [256, 0, 0, 0]))).toBe('BAD_VALUE');
    expect(code(() => img.set(0, 0, [0, 0, -1, 0]))).toBe('BAD_VALUE');
    expect(code(() => img.set(0, 0, [0, 0, 0.5, 0]))).toBe('BAD_VALUE');
    expect(code(() => img.set(0, 0, [0, 0, 0] as unknown as Rgba))).toBe('BAD_VALUE');
    expect(code(() => new TiledImage(0, 4))).toBe('BAD_SIZE');
    expect(code(() => new TiledImage(4, 1.5))).toBe('BAD_SIZE');
    expect(code(() => new TiledImage(MAX_DIMENSION + 1, 1))).toBe('BAD_SIZE');
    expect(img.tileCount).toBe(0);
  });

  it('allocates a tile on the first non-empty write only', () => {
    const img = new TiledImage(64, 64);
    img.set(5, 5, [0, 0, 0, 0]); // empty value into absent tile: nothing
    expect(img.tileCount).toBe(0);
    expect(img.version).toBe(0);
    img.set(5, 5, [0, 0, 0, 1]);
    expect(img.tileCount).toBe(1);
    expect(img.byteSize()).toBe(TILE_BYTES);
    img.set(6, 5, RED); // same tile
    expect(img.tileCount).toBe(1);
    img.set(40, 5, RED); // tile (2, 0)
    expect(img.tileCount).toBe(2);
    expect(img.byteSize()).toBe(2 * TILE_BYTES);
  });

  it('stores values exactly (colour under alpha 0 is kept)', () => {
    const img = new TiledImage(2, 1);
    img.set(0, 0, [9, 8, 7, 0]);
    expect(img.get(0, 0)).toEqual([9, 8, 7, 0]);
    expect(img.bounds()).toBeUndefined(); // alpha 0 is not "visible"
    expect(img.tileCount).toBe(1);
  });

  it('bounds() is the tight box over tiles', () => {
    const img = new TiledImage(100, 100);
    img.set(70, 50, RED);
    img.set(17, 90, BLUE);
    img.set(33, 20, [1, 2, 3, 0]); // invisible
    expect(img.bounds()).toEqual({ x: 17, y: 20 + 30, w: 70 - 17 + 1, h: 90 - 50 + 1 });
  });

  it('edge tiles never write outside the image', () => {
    const img = new TiledImage(17, 17);
    img.set(16, 16, RED);
    expect(img.tileCount).toBe(1);
    expect(img.bounds()).toEqual({ x: 16, y: 16, w: 1, h: 1 });
    expect(img.toRGBA().data.length).toBe(17 * 17 * 4);
  });
});

describe('dense conversion', () => {
  it('fromRGBA / toRGBA round trip, allocating only touched tiles', () => {
    const dense = new Uint8Array(64 * 64 * 4);
    dense.set([1, 2, 3, 4], (40 * 64 + 50) * 4);
    const img = TiledImage.fromRGBA({ width: 64, height: 64, data: dense });
    expect(img.tileCount).toBe(1);
    expect(img.version).toBe(0);
    expect(img.tilesChanged(0)).toEqual([]);
    expect(img.get(50, 40)).toEqual([1, 2, 3, 4]);
    const back = img.toRGBA();
    expect(back.width).toBe(64);
    expect(back.data).toEqual(dense);
  });

  it('round trips random non-tile-aligned images', () => {
    const src = randomImage(37, 21, 11, 0.5);
    const again = TiledImage.fromRGBA(src.toRGBA());
    expect(again.equals(src)).toBe(true);
    expect(again.toRGBA().data).toEqual(src.toRGBA().data);
  });

  it('copies the input and checks its length', () => {
    const data = new Uint8Array(2 * 2 * 4);
    const img = TiledImage.fromRGBA({ width: 2, height: 2, data });
    data[3] = 255;
    expect(img.get(0, 0)).toEqual([0, 0, 0, 0]);
    expect(code(() => TiledImage.fromRGBA({ width: 2, height: 2, data: new Uint8Array(5) }))).toBe(
      'BAD_DATA',
    );
  });
});

describe('copy-on-write clone', () => {
  it('shares buffers until a write; the two images then diverge independently', () => {
    const a = new TiledImage(48, 16);
    a.set(1, 1, RED);
    a.set(20, 1, BLUE);
    const b = a.clone();
    const tileA = [...a.tiles()].map((t) => t.data);
    const tileB = [...b.tiles()].map((t) => t.data);
    expect(tileB[0]).toBe(tileA[0]); // same buffer: O(tiles), no byte copy
    expect(tileB[1]).toBe(tileA[1]);

    b.set(1, 1, BLUE); // writes tile 0 of b only
    expect(a.get(1, 1)).toEqual(RED);
    expect(b.get(1, 1)).toEqual(BLUE);
    expect([...a.tiles()].map((t) => t.data)[0]).toBe(tileA[0]); // a's tile untouched
    expect([...b.tiles()].map((t) => t.data)[1]).toBe(tileA[1]); // tile 1 still shared

    a.set(2, 2, RED); // a copies too
    expect(b.get(2, 2)).toEqual([0, 0, 0, 0]);
    a.set(40, 8, RED); // a new tile on a only
    expect(a.tileCount).toBe(3);
    expect(b.tileCount).toBe(2);
  });

  it('property: random writes on either side never leak to the other', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const a = randomImage(50, 40, seed, 0.2);
      const snapshot = a.toRGBA().data.slice();
      const b = a.clone();
      const r = randomImage(50, 40, seed + 100, 0.2);
      for (let y = 0; y < 40; y++) for (let x = 0; x < 50; x++) b.set(x, y, r.get(x, y));
      expect(a.toRGBA().data).toEqual(snapshot);
      expect(b.equals(r)).toBe(true);
      const c = b.clone();
      c.clear();
      expect(b.equals(r)).toBe(true);
      expect(c.bounds()).toBeUndefined();
    }
  });
});

describe('versions, tilesChanged and tile capture (T2.1 contract)', () => {
  it('advances version once per mutating call that touches a tile', () => {
    const img = new TiledImage(64, 64);
    img.set(0, 0, RED);
    expect(img.version).toBe(1);
    img.set(0, 0, RED); // no change
    expect(img.version).toBe(1);
    img.set(0, 0, [0, 0, 0, 0]); // erase: a change
    expect(img.version).toBe(2);
    img.get(0, 0);
    img.clone();
    img.compact();
    expect(img.version).toBe(2);
  });

  it('tilesChanged reports exactly the tiles written after a version, row-major', () => {
    const img = new TiledImage(64, 64);
    img.set(60, 0, RED); // tile (3, 0), v1
    img.set(0, 50, RED); // tile (0, 3), v2
    const v = img.version;
    img.set(20, 20, RED); // tile (1, 1), v3
    img.set(1, 50, BLUE); // tile (0, 3), v4
    expect(img.tilesChanged(v)).toEqual([
      { tx: 1, ty: 1 },
      { tx: 0, ty: 3 },
    ]);
    expect(img.tilesChanged(img.version)).toEqual([]);
    expect(img.tilesChanged(0).length).toBe(3);
    expect(img.tilesChanged(-1).length).toBe(3);
  });

  it('transaction flow: clone as base, capture changed tiles before/after, undo and redo', () => {
    const img = randomImage(80, 48, 5, 0.15);
    const original = img.clone();
    const base = img.clone(); // transaction start
    const v0 = img.version;

    img.set(3, 3, RED);
    img.set(70, 40, BLUE);
    img.set(70, 41, BLUE);
    const edited = img.clone();

    const changed = img.tilesChanged(v0);
    expect(changed.length).toBe(2);
    const before = base.captureTiles(changed);
    const after = img.captureTiles(changed);

    img.restoreTiles(before); // undo
    expect(img.equals(original)).toBe(true);
    expect(img.tilesChanged(img.version - 1).length).toBe(2); // restored tiles are reported (redraw)
    img.restoreTiles(after); // redo
    expect(img.equals(edited)).toBe(true);
  });

  it('captured buffers are immutable: later writes copy first', () => {
    const img = new TiledImage(32, 16);
    img.set(0, 0, RED);
    const data = img.captureTiles([{ tx: 0, ty: 0 }])[0]?.data;
    expect(data).toBeDefined();
    const frozen = data?.slice();
    img.set(1, 0, BLUE);
    expect(data).toEqual(frozen);
    expect(img.get(1, 0)).toEqual(BLUE);
  });

  it('undo can remove a tile that did not exist before', () => {
    const img = new TiledImage(32, 32);
    const base = img.clone();
    img.set(20, 20, RED);
    const changed = img.tilesChanged(0);
    const before = base.captureTiles(changed);
    expect(before[0]?.data).toBeUndefined();
    img.restoreTiles(before);
    expect(img.tileCount).toBe(0);
    expect(img.get(20, 20)).toEqual([0, 0, 0, 0]);
    expect(img.tilesChanged(1)).toEqual([{ tx: 1, ty: 1 }]); // removal is reported
  });

  it('rejects bad tiles', () => {
    const img = new TiledImage(32, 16);
    expect(code(() => img.captureTiles([{ tx: 2, ty: 0 }]))).toBe('BAD_TILE');
    expect(code(() => img.captureTiles([{ tx: 0, ty: -1 }]))).toBe('BAD_TILE');
    expect(
      code(() => {
        img.restoreTiles([{ tx: 0, ty: 0, data: new Uint8Array(3) }]);
      }),
    ).toBe('BAD_TILE');
    expect(img.version).toBe(0);
  });

  it('restoring the very same buffer is a no-op', () => {
    const img = new TiledImage(16, 16);
    img.set(0, 0, RED);
    const snaps = img.captureTiles(img.tilesChanged(0));
    const v = img.version;
    img.restoreTiles(snaps);
    expect(img.version).toBe(v);
  });

  it('clone keeps the version and change history', () => {
    const img = new TiledImage(32, 32);
    img.set(0, 0, RED);
    const c = img.clone();
    expect(c.version).toBe(1);
    expect(c.tilesChanged(0)).toEqual([{ tx: 0, ty: 0 }]);
  });
});

describe('compact, clear, equals, tiles()', () => {
  it('compact frees all-zero tiles only', () => {
    const img = new TiledImage(48, 16);
    img.set(0, 0, RED);
    img.set(20, 0, RED);
    img.set(40, 0, [5, 5, 5, 0]);
    img.set(0, 0, [0, 0, 0, 0]);
    img.set(20, 0, [0, 0, 0, 0]);
    expect(img.tileCount).toBe(3);
    expect(img.compact()).toBe(2);
    expect(img.tileCount).toBe(1); // the (5,5,5,0) tile survives: its bytes are not zero
    expect(img.compact()).toBe(0);
  });

  it('clear empties and reports the removed tiles', () => {
    const img = new TiledImage(32, 16);
    img.set(0, 0, RED);
    img.set(20, 0, RED);
    const v = img.version;
    img.clear();
    expect(img.tileCount).toBe(0);
    expect(img.tilesChanged(v).length).toBe(2);
    img.clear();
    expect(img.version).toBe(v + 1);
  });

  it('equals ignores allocation layout and compares kind and size', () => {
    const a = new TiledImage(32, 16);
    const b = new TiledImage(32, 16);
    a.set(0, 0, RED);
    a.set(0, 0, [0, 0, 0, 0]); // allocated but all zero
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
    b.set(31, 15, RED);
    expect(a.equals(b)).toBe(false);
    expect(b.equals(a)).toBe(false);
    expect(a.equals(new TiledImage(16, 32))).toBe(false);
    expect(a.equals(new IndexedImage(32, 16))).toBe(false);
  });

  it('tiles() is row-major with pixel origins', () => {
    const img = new TiledImage(48, 48);
    img.set(40, 40, RED);
    img.set(0, 20, RED);
    img.set(20, 0, RED);
    expect([...img.tiles()].map((t) => [t.tx, t.ty, t.x, t.y])).toEqual([
      [1, 0, 16, 0],
      [0, 1, 0, 16],
      [2, 2, 32, 32],
    ]);
  });
});

describe('sparse allocation (NFR-01)', () => {
  const fill = (img: TiledImage, x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.set(x, y, RED);
  };

  it('a 64x64 block in a 256x256 image uses 16 tiles (<= 30)', () => {
    const img = new TiledImage(256, 256);
    fill(img, 0, 0, 64, 64);
    expect(img.tileCount).toBe(16);
    expect(img.byteSize()).toBe(16 * 1024);
    expect(img.byteSize()).toBeLessThan(256 * 256 * 4);
  });

  it('10 % of the pixels (160x41 = 6560 of 65536) use <= 30 tiles', () => {
    const img = new TiledImage(256, 256);
    fill(img, 0, 0, 160, 41);
    expect(6560 / 65536).toBeGreaterThan(0.1);
    expect(img.tileCount).toBe(30);
    expect(img.tileCount).toBeLessThanOrEqual(30);
  });

  it('indexed images allocate 256 bytes per tile', () => {
    const img = new IndexedImage(256, 256);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) img.set(x, y, 1);
    expect(img.tileCount).toBe(16);
    expect(img.byteSize()).toBe(16 * 256);
  });
});

describe('IndexedImage', () => {
  it('absent tiles read as transparentIndex; writing it allocates nothing', () => {
    const img = new IndexedImage(40, 40, 7);
    expect(img.get(3, 3)).toBe(7);
    expect(img.get(-1, 3)).toBe(7);
    img.set(3, 3, 7);
    expect(img.tileCount).toBe(0);
    img.set(3, 3, 2);
    expect(img.get(3, 3)).toBe(2);
    expect(img.get(4, 3)).toBe(7); // the rest of the allocated tile is filled with 7
    expect(img.bounds()).toEqual({ x: 3, y: 3, w: 1, h: 1 });
    img.set(3, 3, 7);
    expect(img.bounds()).toBeUndefined();
    expect(img.set(99, 0, 1)).toBe(false);
  });

  it('bounds() can treat further alpha-0 palette entries as transparent', () => {
    const img = new IndexedImage(8, 8);
    img.set(1, 1, 5);
    img.set(6, 6, 2);
    expect(img.bounds()).toEqual({ x: 1, y: 1, w: 6, h: 6 });
    expect(img.bounds((i) => i === 5)).toEqual({ x: 6, y: 6, w: 1, h: 1 });
  });

  it('toRGBA resolves through the palette; absent area uses the transparent entry', () => {
    const img = new IndexedImage(3, 1, 0);
    img.set(1, 0, 2);
    const palette: Rgba[] = [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ];
    expectAscii(img.toRGBA(palette), '.B.', { B: BLUE });
    expect(code(() => img.toRGBA(palette.slice(0, 2)))).toBe('BAD_VALUE');
    // a different transparent index fills absent tiles with that palette entry
    const t = new IndexedImage(2, 1, 1);
    expectAscii(t.toRGBA(palette), 'RR', { R: RED });
  });

  it('fromIndices / toIndices round trip', () => {
    const data = new Uint8Array(20 * 20).fill(3);
    data[5 * 20 + 6] = 9;
    const img = IndexedImage.fromIndices(20, 20, data, 3);
    expect(img.tileCount).toBe(1);
    expect(img.toIndices()).toEqual(data);
    expect(code(() => IndexedImage.fromIndices(2, 2, new Uint8Array(3)))).toBe('BAD_DATA');
  });

  it('validates indices and the transparent index; clone keeps it', () => {
    expect(code(() => new IndexedImage(2, 2, 256))).toBe('BAD_VALUE');
    const img = new IndexedImage(2, 2, 4);
    expect(code(() => img.set(0, 0, -1))).toBe('BAD_VALUE');
    expect(code(() => img.get(0.1, 0))).toBe('NON_INTEGER');
    const c = img.clone();
    expect(c.transparentIndex).toBe(4);
    expect(c.get(0, 0)).toBe(4);
  });

  it('asciiToImage helper agrees with TiledImage.fromRGBA (sanity of the test harness)', () => {
    const img = TiledImage.fromRGBA(asciiToImage('RB\nBR', legend));
    expect(img.get(1, 1)).toEqual(RED);
  });
});
