import { asciiToImage, expectAscii } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import {
  blendOver,
  blit,
  composite,
  div255,
  IndexedImage,
  RasterError,
  TiledImage,
} from '../src/index.js';
import { randomImage, rng } from './util.js';

// h = half-transparent red (alpha 128); P = h over opaque blue; b = opaque blue.
// Hand-computed: sa = 128, D = 255*128 + 255*127 = 65025 -> r = 128*255*255/65025 = 128, b = 127*255*255/65025 = 127.
const legend = {
  R: [255, 0, 0, 255],
  b: [0, 0, 255, 255],
  h: [255, 0, 0, 128],
  P: [128, 0, 127, 255],
  l: [255, 0, 0, 1],
  G: [0, 255, 0, 255],
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

describe('composite: ASCII expectations', () => {
  it('opaque source replaces; transparent source pixels leave the destination alone', () => {
    const dst = img('bbbb\nbbbb\n....');
    composite(dst, img('RR\nR.'), { x: 1, y: 1 });
    expectAscii(dst.toRGBA(), 'bbbb\nbRRb\n.R..', legend);
  });

  it('partial alpha over an opaque pixel and over transparency', () => {
    const dst = img('bb.');
    composite(dst, img('hhh'));
    // over blue: (128,0,127,255); over transparent: the source pixel as is (alpha 128)
    expectAscii(dst.toRGBA(), 'PPh', legend);
  });

  it('opacity scales the source alpha: 128/255 of opaque red = alpha 128', () => {
    const dst = img('bb.');
    composite(dst, img('RRR'), { opacity: 128 });
    expectAscii(dst.toRGBA(), 'PPh', legend);
  });

  it('opacity 0 does nothing; opacity 255 is the default', () => {
    const dst = img('bb');
    composite(dst, img('RR'), { opacity: 0 });
    expectAscii(dst.toRGBA(), 'bb', legend);
    expect(dst.version).toBe(0);
    composite(dst, img('RR'), { opacity: 255 });
    expectAscii(dst.toRGBA(), 'RR', legend);
  });

  it('clips against all four edges and with negative offsets', () => {
    const dst = img('....\n....\n....');
    composite(dst, img('RRR\nRRR\nRRR'), { x: -2, y: -1 });
    expectAscii(dst.toRGBA(), 'R...\nR...\n....', legend);
    const dst2 = img('....\n....\n....');
    composite(dst2, img('RRR\nRRR\nRRR'), { x: 3, y: 2 });
    expectAscii(dst2.toRGBA(), '....\n....\n...R', legend);
    const dst3 = img('..\n..');
    composite(dst3, img('R'), { x: 5, y: 5 });
    composite(dst3, img('R'), { x: -5, y: -5 });
    expectAscii(dst3.toRGBA(), '..\n..', legend);
    expect(dst3.tileCount).toBe(0);
  });

  it('works across tile boundaries', () => {
    const dst = new TiledImage(40, 40);
    const src = new TiledImage(20, 20);
    for (let i = 0; i < 20; i++) src.set(i, i, [255, 0, 0, 255]);
    composite(dst, src, { x: 10, y: 10 });
    for (let i = 0; i < 20; i++) expect(dst.get(10 + i, 10 + i)).toEqual([255, 0, 0, 255]);
    expect(dst.get(11, 10)).toEqual([0, 0, 0, 0]);
    expect(dst.tileCount).toBe(2); // diagonal visits tiles (0,0) and (1,1) only
  });
});

describe('composite: documented rounding', () => {
  it('div255 is round(v / 255)', () => {
    expect([0, 126, 127, 128, 254, 255, 382, 383, 65025].map(div255)).toEqual([
      0, 0, 0, 1, 1, 1, 1, 2, 255,
    ]);
    for (let v = 0; v <= 65025; v += 7) expect(div255(v)).toBe(Math.round(v / 255));
  });

  it('effective alpha = div255(alpha * opacity)', () => {
    const cases: [number, number, number][] = [
      // [src alpha, opacity, expected alpha written over transparent]
      [255, 1, 1],
      [255, 127, 127],
      [255, 128, 128],
      [128, 128, 64], // 16384 -> 64.25 -> 64
      [1, 127, 0], // 127 -> 0.498 -> skipped, nothing written
      [2, 127, 1], // 254 -> 0.996 -> 1
      [3, 85, 1], // 255 -> exactly 1
    ];
    for (const [a, opacity, expected] of cases) {
      const dst = new TiledImage(1, 1);
      const src = new TiledImage(1, 1);
      src.set(0, 0, [10, 20, 30, a]);
      composite(dst, src, { opacity });
      expect(dst.get(0, 0)).toEqual(expected === 0 ? [0, 0, 0, 0] : [10, 20, 30, expected]);
    }
  });

  it('two partial alphas: (200,100,50,128) over (10,20,30,64) = (162,84,46,160)', () => {
    // ida = 127, ws = 255*128 = 32640, wd = 64*127 = 8128, D = 40768
    // alpha = floor((40768+127)/255) = 160; r: N = 6609280, N/D = 162.12 -> 162; g: 3426560/40768 = 84.05 -> 84;
    // b: 1875840/40768 = 46.01 -> 46
    const dst = new TiledImage(1, 1);
    dst.set(0, 0, [10, 20, 30, 64]);
    const src = new TiledImage(1, 1);
    src.set(0, 0, [200, 100, 50, 128]);
    composite(dst, src);
    expect(dst.get(0, 0)).toEqual([162, 84, 46, 160]);
  });

  it('rounds to nearest on a fractional channel: (0,0,0,64) over (255,255,255,255) = 191.25 -> 191', () => {
    // sa=64, ida=191, ws=16320, wd=255*191=48705, D=65025; r = 48705*255/65025 = 191
    const dst = new TiledImage(1, 1);
    dst.set(0, 0, [255, 255, 255, 255]);
    const src = new TiledImage(1, 1);
    src.set(0, 0, [0, 0, 0, 64]);
    composite(dst, src);
    expect(dst.get(0, 0)).toEqual([191, 191, 191, 255]);
  });

  it('matches an exact-rational oracle (BigInt, round half up) on random pixels', () => {
    const r = rng(99);
    const px = (): number => Math.floor(r() * 256);
    const out = new Uint8Array(4);
    for (let i = 0; i < 20000; i++) {
      const sa = 1 + Math.floor(r() * 255);
      const da = r() < 0.2 ? 255 : px();
      const s = [px(), px(), px()];
      const d = [px(), px(), px()];
      blendOver(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, sa, d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, da, out);
      // real alpha (in 1/255 units) = sa + da*(255-sa)/255 ; exact colour = (sC*sa*255 + dC*da*(255-sa)) / D
      const D = BigInt(255 * sa + da * (255 - sa));
      expect(out[3]).toBe(Number((D + 127n) / 255n));
      for (let c = 0; c < 3; c++) {
        const N = BigInt((s[c] ?? 0) * sa * 255 + (d[c] ?? 0) * da * (255 - sa));
        expect(out[c]).toBe(Number((2n * N + D) / (2n * D)));
      }
    }
  });
});

describe('composite: other behaviour', () => {
  it('allocates and dirties only tiles that actually change', () => {
    const dst = new TiledImage(64, 16);
    dst.set(0, 0, [255, 0, 0, 255]);
    const v = dst.version;
    const src = new TiledImage(64, 16);
    src.set(0, 0, [255, 0, 0, 255]); // identical pixel: no change
    src.set(50, 5, [0, 0, 255, 255]); // tile (3, 0)
    composite(dst, src);
    expect(dst.version).toBe(v + 1);
    expect(dst.tilesChanged(v)).toEqual([{ tx: 3, ty: 0 }]);
    expect(dst.tileCount).toBe(2);
  });

  it('never writes through a shared tile (clone stays intact)', () => {
    const dst = img('bb');
    const keep = dst.clone();
    composite(dst, img('RR'));
    expectAscii(keep.toRGBA(), 'bb', legend);
    expectAscii(dst.toRGBA(), 'RR', legend);
  });

  it('is associative enough to be stable: compositing the same layers twice gives the same hash', () => {
    const run = (): string => {
      const d = randomImage(40, 40, 1, 0.6);
      composite(d, randomImage(40, 40, 2, 0.5), { x: 3, y: -2, opacity: 200 });
      composite(d, randomImage(30, 30, 3, 0.5), { x: -4, y: 9, opacity: 77 });
      return d.hashRGBA();
    };
    expect(run()).toBe(run());
  });

  it('throws typed errors for bad arguments', () => {
    const a = new TiledImage(2, 2);
    expect(
      code(() => {
        composite(a, a);
      }),
    ).toBe('SAME_IMAGE');
    expect(
      code(() => {
        composite(a, new TiledImage(1, 1), { opacity: 256 });
      }),
    ).toBe('BAD_VALUE');
    expect(
      code(() => {
        composite(a, new TiledImage(1, 1), { opacity: 1.5 });
      }),
    ).toBe('BAD_VALUE');
    expect(
      code(() => {
        composite(a, new TiledImage(1, 1), { x: 0.5 });
      }),
    ).toBe('NON_INTEGER');
  });
});

describe('blit', () => {
  it('stamps non-empty pixels without blending', () => {
    const dst = img('bbb\nbbb');
    blit(dst, img('h.R'), 0, 1);
    expectAscii(dst.toRGBA(), 'bbb\nhbR', legend);
  });

  it('replace mode overwrites the whole rectangle, empty pixels included', () => {
    const dst = img('bbb\nbbb');
    blit(dst, img('R.\n.R'), 1, 0, { replace: true });
    expectAscii(dst.toRGBA(), 'bR.\nb.R', legend);
  });

  it('clips and handles negative offsets', () => {
    const dst = img('...\n...');
    blit(dst, img('RG\nGR'), -1, 1);
    expectAscii(dst.toRGBA(), '...\nG..', legend);
  });

  it('works for indexed images and rejects mixed kinds', () => {
    const dst = new IndexedImage(4, 1, 0);
    const src = new IndexedImage(2, 1, 0);
    src.set(1, 0, 3);
    blit(dst, src, 1, 0);
    expect([0, 1, 2, 3].map((x) => dst.get(x, 0))).toEqual([0, 0, 3, 0]);
    expect(
      code(() => {
        blit(dst as never, new TiledImage(1, 1) as never, 0, 0);
      }),
    ).toBe('MISMATCH');
    expect(
      code(() => {
        blit(dst, new IndexedImage(1, 1, 5), 0, 0);
      }),
    ).toBe('MISMATCH');
    expect(
      code(() => {
        blit(dst, dst, 0, 0);
      }),
    ).toBe('SAME_IMAGE');
    expect(
      code(() => {
        blit(dst, src, 0.5, 0);
      }),
    ).toBe('NON_INTEGER');
  });

  it('indexed with a non-zero transparent index treats it as empty', () => {
    const dst = new IndexedImage(2, 1, 9);
    dst.set(0, 0, 1);
    const src = new IndexedImage(2, 1, 9);
    src.set(1, 0, 2);
    blit(dst, src, 0, 0);
    expect([dst.get(0, 0), dst.get(1, 0)]).toEqual([1, 2]);
    blit(dst, src, 0, 0, { replace: true });
    expect([dst.get(0, 0), dst.get(1, 0)]).toEqual([9, 2]);
  });
});
