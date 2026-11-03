import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashRGBA } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GIF_LIMITS, IoError, decodeGif, isGif } from '../src/index.js';
import type { DecodedGif } from '../src/index.js';
import { need } from './helpers.js';
import { buildGif, interlaceOrder, lzwEncode, packBits, scanFrames } from './gif-builder.js';
import type { Rgb } from './gif-builder.js';

const dir = fileURLToPath(new URL('../../../fixtures/gif/', import.meta.url));
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(dir + name));
const json = (name: string): unknown => JSON.parse(readFileSync(dir + name, 'utf8'));

interface Expected {
  width: number;
  height: number;
  durationsMs: number[];
  loopCount: number | null;
  hashes: string[];
}

const frameOf = (g: DecodedGif, i: number): DecodedGif['frames'][number] => need(g.frames[i]);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof IoError) return e.code;
    throw e;
  }
  return undefined;
}

// ---- oracle 1: GIFs written by other tools ---------------------------------------------------------
// The expected hashes come from the scene arrays of the generator scripts (make_pil.py, make_imageio.swift,
// make_sips.py), never from this decoder.

function expectMatches(gif: DecodedGif, e: Expected): void {
  expect([gif.width, gif.height]).toEqual([e.width, e.height]);
  expect(gif.frames.map((f) => hashRGBA(f.image))).toEqual(e.hashes);
  expect(gif.frames.map((f) => f.durationMs)).toEqual(e.durationsMs);
  expect(gif.loopCount ?? null).toEqual(e.loopCount);
}

describe('GIFs written by Pillow 11.3.0', () => {
  const expected = json('pil_expected.json') as Record<string, Expected>;

  for (const name of Object.keys(expected)) {
    it(`${name}: frames, durations and loop count`, () => {
      expectMatches(decodeGif(file(`${name}.gif`)), need(expected[name]));
    });
  }

  it('the interlaced file really is interlaced, the others are not', () => {
    expect(scanFrames(file('pil_interlaced.gif')).every((f) => f.interlaced)).toBe(true);
    expect(scanFrames(file('pil_opaque.gif')).some((f) => f.interlaced)).toBe(false);
  });

  it('uses each disposal method', () => {
    for (const d of [0, 1, 2, 3]) {
      const used = scanFrames(file(`pil_sprite_disposal${String(d)}.gif`)).map((f) => f.disposal);
      expect(used.includes(d), `disposal ${String(d)} in the file`).toBe(true);
    }
  });

  it('the opaque file has no loop extension in pil_interlaced (plays once)', () => {
    expect(decodeGif(file('pil_interlaced.gif')).loopCount).toBeUndefined();
    expect(decodeGif(file('pil_opaque.gif')).loopCount).toBe(0);
  });
});

describe('GIFs written by macOS ImageIO and sips', () => {
  it('ImageIO animation: four frames, delays 0.1 0.2 0.05 0.5 s, loop forever, transparency', () => {
    const gif = decodeGif(file('imageio_anim.gif'));
    expectMatches(gif, json('imageio_expected.json') as Expected);
    expect(new TextDecoder().decode(file('imageio_anim.gif').subarray(0, 6))).toBe('GIF87a');
  });

  it('sips still image (GIF87a with a transparent index)', () => {
    const gif = decodeGif(file('sips_static.gif'));
    expect(gif.frames).toHaveLength(1);
    expect(hashRGBA((gif.frames[0] as { image: RgbaImage }).image)).toBe(
      '027d0ebcc3b3110d53fb29c8c1b6b367010a356d52557a085db1807ccec2a246',
    );
  });

  it('is deterministic: decoding twice gives the same bytes', () => {
    const a = decodeGif(file('imageio_anim.gif'));
    const b = decodeGif(file('imageio_anim.gif'));
    expect(a.frames.map((f) => hashRGBA(f.image))).toEqual(b.frames.map((f) => hashRGBA(f.image)));
  });
});

// ---- oracle 2: hand-built files with hand-written ASCII expectations ---------------------------------

const A: Rgb = [200, 10, 10];
const B: Rgb = [10, 200, 10];
const C: Rgb = [10, 10, 200];
const D: Rgb = [200, 200, 10];
const PALETTE = [A, B, C, D];
const LEGEND: Record<string, Rgb> = { A, B, C, D };

function ascii(img: RgbaImage): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const px = [img.data[o], img.data[o + 1], img.data[o + 2]];
      if (img.data[o + 3] === 0) row += '.';
      else
        row += Object.entries(LEGEND).find(([, c]) => c.every((v, i) => v === px[i]))?.[0] ?? '?';
    }
    rows.push(row);
  }
  return rows;
}

const fill = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

describe('composition (hand-built files)', () => {
  const canvas = { width: 4, height: 3, palette: PALETTE };

  it('disposal 1 keeps the frame; a later frame draws over it', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 4, h: 3, indices: fill(12, 0), gce: { disposal: 1, delayCs: 5 } },
          { x: 1, y: 1, w: 2, h: 1, indices: [1, 2], gce: { disposal: 1, delayCs: 5 } },
        ],
      }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['AAAA', 'AAAA', 'AAAA']);
    expect(ascii(frameOf(gif, 1).image)).toEqual(['AAAA', 'ABCA', 'AAAA']);
  });

  it('disposal 2 clears the frame rectangle to transparent', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 2, h: 2, indices: fill(4, 1), gce: { disposal: 2, delayCs: 5 } },
          { x: 1, y: 1, w: 2, h: 2, indices: fill(4, 2), gce: { disposal: 0, delayCs: 5 } },
        ],
      }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['BB..', 'BB..', '....']);
    expect(ascii(frameOf(gif, 1).image)).toEqual(['....', '.CC.', '.CC.']);
  });

  it('disposal 2 clears only the frame rectangle, not what was drawn before it', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 4, h: 3, indices: fill(12, 0), gce: { disposal: 1, delayCs: 5 } },
          { x: 2, y: 0, w: 2, h: 2, indices: fill(4, 3), gce: { disposal: 2, delayCs: 5 } },
          { x: 0, y: 2, w: 1, h: 1, indices: [1], gce: { delayCs: 5 } },
        ],
      }),
    );
    expect(ascii(frameOf(gif, 1).image)).toEqual(['AADD', 'AADD', 'AAAA']);
    // the DD rectangle is gone (transparent), the A under it was never restored
    expect(ascii(frameOf(gif, 2).image)).toEqual(['AA..', 'AA..', 'BAAA']);
  });

  it('disposal 3 restores the canvas as it was before the frame', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 4, h: 3, indices: fill(12, 0), gce: { disposal: 1, delayCs: 5 } },
          { x: 1, y: 0, w: 2, h: 2, indices: fill(4, 1), gce: { disposal: 3, delayCs: 5 } },
          { x: 0, y: 2, w: 4, h: 1, indices: fill(4, 2), gce: { disposal: 0, delayCs: 5 } },
        ],
      }),
    );
    expect(ascii(frameOf(gif, 1).image)).toEqual(['ABBA', 'ABBA', 'AAAA']);
    expect(ascii(frameOf(gif, 2).image)).toEqual(['AAAA', 'AAAA', 'CCCC']);
  });

  it('the reserved disposal values 4..7 act as 0 and are reported as 0', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 2, h: 2, indices: fill(4, 1), gce: { disposal: 5, delayCs: 5 } },
          { x: 2, y: 1, w: 2, h: 2, indices: fill(4, 2), gce: { delayCs: 5 } },
        ],
      }),
    );
    expect(frameOf(gif, 0).disposal).toBe(0);
    expect(ascii(frameOf(gif, 1).image)).toEqual(['BB..', 'BBCC', '..CC']);
  });

  it('a transparent index leaves the pixel below untouched; a frame without GCE is opaque', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 4, h: 3, indices: fill(12, 0) },
          {
            w: 4,
            h: 3,
            indices: [1, 3, 1, 3, 3, 3, 3, 3, 1, 3, 3, 1],
            gce: { transparent: 3, delayCs: 5 },
          },
        ],
      }),
    );
    expect(ascii(frameOf(gif, 1).image)).toEqual(['BABA', 'AAAA', 'BAAB']);
  });

  it('a local colour table replaces the global one for its frame only', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 2, h: 1, indices: [0, 1] },
          { w: 2, h: 1, indices: [0, 1], palette: [D, C] },
          { w: 2, h: 1, indices: [0, 1] },
        ],
      }),
    );
    expect(gif.frames.map((f) => ascii(f.image)[0])).toEqual(['AB..', 'DC..', 'AB..']);
  });

  it('frames start transparent; the first frame may be smaller than the screen', () => {
    const gif = decodeGif(
      buildGif({ ...canvas, frames: [{ x: 2, y: 1, w: 1, h: 1, indices: [3] }] }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['....', '..D.', '....']);
    expect(frameOf(gif, 0).rect).toEqual({ x: 2, y: 1, w: 1, h: 1 });
  });

  it('a frame that starts inside but ends outside the screen is clipped', () => {
    const gif = decodeGif(
      buildGif({ ...canvas, frames: [{ x: 3, y: 2, w: 2, h: 2, indices: [1, 2, 3, 0] }] }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['....', '....', '...B']);
    expect(frameOf(gif, 0).rect).toEqual({ x: 3, y: 2, w: 1, h: 1 });
  });

  it('a frame that starts outside the screen draws nothing', () => {
    const gif = decodeGif(
      buildGif({ ...canvas, frames: [{ x: 9, y: 9, w: 1, h: 1, indices: [1] }] }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['....', '....', '....']);
  });

  it('a pixel index outside the colour table draws nothing', () => {
    // 2 colours, min code size 2 allows index 3
    const gif = decodeGif(
      buildGif({
        width: 3,
        height: 1,
        palette: [A, B],
        frames: [{ w: 3, h: 1, indices: [0, 3, 1] }],
      }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['A.B']);
  });

  it('the returned frames are independent copies', () => {
    const gif = decodeGif(
      buildGif({
        ...canvas,
        frames: [
          { w: 4, h: 3, indices: fill(12, 0), gce: { disposal: 1 } },
          { w: 4, h: 3, indices: fill(12, 1), gce: { disposal: 1 } },
        ],
      }),
    );
    expect(frameOf(gif, 0).image.data).not.toBe(frameOf(gif, 1).image.data);
    expect(ascii(frameOf(gif, 0).image)[0]).toBe('AAAA');
  });
});

describe('interlace', () => {
  it('maps stored rows to the rows of the four passes (hand-written order for 10 rows)', () => {
    // Appendix E for 10 rows: pass 1 rows 0 8, pass 2 row 4, pass 3 rows 2 6, pass 4 rows 1 3 5 7 9.
    expect(interlaceOrder(10)).toEqual([0, 8, 4, 2, 6, 1, 3, 5, 7, 9]);
    const stored = Array.from({ length: 10 }, (_, s) => fill(2, s)).flat(); // value = stored row number
    const palette = Array.from({ length: 16 }, (_, i) => [i * 10, 0, 0] as Rgb);
    const bytes = buildGif({
      width: 2,
      height: 10,
      palette,
      frames: [{ w: 2, h: 10, indices: [], interlace: true, lzw: lzwEncode(stored, 4) }],
    });
    const img = frameOf(decodeGif(bytes), 0).image;
    const valueAt = (y: number): number => (img.data[y * 2 * 4] ?? 0) / 10;
    // image row y shows the stored row s with order[s] = y
    expect(Array.from({ length: 10 }, (_, y) => valueAt(y))).toEqual([
      0, 5, 3, 6, 2, 7, 4, 8, 1, 9,
    ]);
  });

  it('an interlaced frame equals the same picture written in order', () => {
    const w = 7;
    const h = 19;
    const indices = Array.from({ length: w * h }, (_, i) => (i * 7 + (i % w)) % 4);
    const plain = decodeGif(
      buildGif({ width: w, height: h, palette: PALETTE, frames: [{ w, h, indices }] }),
    );
    const inter = decodeGif(
      buildGif({
        width: w,
        height: h,
        palette: PALETTE,
        frames: [{ w, h, indices, interlace: true }],
      }),
    );
    expect(hashRGBA(frameOf(inter, 0).image)).toBe(hashRGBA(frameOf(plain, 0).image));
  });
});

describe('timing and looping', () => {
  const base = { width: 1, height: 1, palette: PALETTE };
  const frame = (delayCs: number | undefined) => ({
    w: 1,
    h: 1,
    indices: [0],
    ...(delayCs === undefined ? {} : { gce: { delayCs } }),
  });

  it('centiseconds become milliseconds (x10)', () => {
    const gif = decodeGif(buildGif({ ...base, frames: [frame(1), frame(7), frame(65535)] }));
    expect(gif.frames.map((f) => f.durationMs)).toEqual([10, 70, 655350]);
  });

  it('delay 0 and a missing GCE get 100 ms (browsers), or the given zeroDelayMs', () => {
    const bytes = buildGif({ ...base, frames: [frame(0), frame(undefined), frame(3)] });
    const gif = decodeGif(bytes);
    expect(gif.frames.map((f) => f.durationMs)).toEqual([100, 100, 30]);
    expect(gif.zeroDelayFrames).toBe(2);
    expect(decodeGif(bytes, { zeroDelayMs: 40 }).frames.map((f) => f.durationMs)).toEqual([
      40, 40, 30,
    ]);
  });

  it('refuses a bad zeroDelayMs', () => {
    expect(
      code(() => decodeGif(buildGif({ ...base, frames: [frame(1)] }), { zeroDelayMs: 0 })),
    ).toBe('BAD_INPUT');
  });

  it('reads the NETSCAPE2.0 loop count; no extension means undefined', () => {
    const f = [frame(1)];
    expect(decodeGif(buildGif({ ...base, frames: f })).loopCount).toBeUndefined();
    expect(decodeGif(buildGif({ ...base, loop: 0, frames: f })).loopCount).toBe(0);
    expect(decodeGif(buildGif({ ...base, loop: 7, frames: f })).loopCount).toBe(7);
    expect(decodeGif(buildGif({ ...base, loop: 65535, frames: f })).loopCount).toBe(65535);
  });

  it('skips comments, plain text and unknown application extensions', () => {
    const prelude = [
      0x21,
      0xfe,
      3,
      0x61,
      0x62,
      0x63,
      0, // comment "abc"
      0x21,
      0x01,
      12,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      1,
      1,
      0,
      0,
      2,
      0x68,
      0x69,
      0, // plain text "hi"
      0x21,
      0xff,
      11,
      ...Buffer.from('XMP DataXMP', 'latin1'),
      2,
      1,
      2,
      0, // application, 2 sub-blocks
      0x21,
      0x77,
      1,
      9,
      0, // unknown label
    ];
    const gif = decodeGif(buildGif({ ...base, prelude, frames: [frame(2)] }));
    expect(gif.frames).toHaveLength(1);
    expect(frameOf(gif, 0).durationMs).toBe(20);
  });

  it('a GCE applies to the next frame only', () => {
    const gif = decodeGif(
      buildGif({
        ...base,
        frames: [
          { w: 1, h: 1, indices: [0], gce: { delayCs: 9, disposal: 2 } },
          { w: 1, h: 1, indices: [0] },
        ],
      }),
    );
    expect(gif.frames.map((f) => [f.durationMs, f.disposal])).toEqual([
      [90, 2],
      [100, 0],
    ]);
  });

  it('GIF87a files decode too', () => {
    const gif = decodeGif(buildGif({ ...base, version: '87a', frames: [frame(undefined)] }));
    expect(gif.frames).toHaveLength(1);
  });
});

describe('LZW', () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s >>> 8;
    };
  }

  it('round-trips noise that fills the 4096-entry table many times (clear codes, widths up to 12 bits)', () => {
    const next = lcg(7);
    const w = 120;
    const h = 100;
    const indices = Array.from({ length: w * h }, () => next() % 256);
    const palette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) % 256] as Rgb);
    const gif = decodeGif(buildGif({ width: w, height: h, palette, frames: [{ w, h, indices }] }));
    const img = frameOf(gif, 0).image;
    for (let i = 0; i < indices.length; i += 97) {
      const k = indices[i] ?? 0;
      expect([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]).toEqual(palette[k]);
    }
    expect(img.data.subarray(0, 4)).toEqual(
      Uint8Array.of(...(palette[indices[0] ?? 0] ?? [0, 0, 0]), 255),
    );
  });

  it('decodes long runs (strings up to 4095 pixels, the KwKwK case) at every minimum code size', () => {
    for (let min = 2; min <= 8; min++) {
      const colours = 1 << min;
      const palette = Array.from({ length: colours }, (_, i) => [i, i, i] as Rgb);
      const indices = Array.from({ length: 5000 }, (_, i) =>
        i < 3000 ? colours - 1 : i % colours,
      );
      const gif = decodeGif(
        buildGif({
          width: 100,
          height: 50,
          palette,
          frames: [{ w: 100, h: 50, indices, minCodeSize: min }],
        }),
      );
      const img = frameOf(gif, 0).image;
      for (let i = 0; i < indices.length; i += 13) {
        expect(img.data[i * 4], `min ${String(min)} pixel ${String(i)}`).toBe(indices[i]);
      }
    }
  });

  it('continues with a full table when the encoder does not send a clear code', () => {
    // A stream that adds entries until the table is full (4096) and then keeps using codes.
    const min = 8;
    const codes: [number, number][] = [[256, 9]];
    let width = 9;
    let next = 258;
    // codes 0..N: each pair of codes adds one entry; widths grow as the decoder expects

    for (let i = 0; i < 4200; i++) {
      codes.push([i % 256, width]); // read with the width in force before this code adds its entry
      if (i > 0 && next < 4096) {
        next++;
        if (next === 1 << width && width < 12) width++;
      }
    }
    codes.push([257, width]);
    const gif = decodeGif(
      buildGif({
        width: 70,
        height: 60,
        palette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as Rgb),
        frames: [{ w: 70, h: 60, indices: [], lzw: packBits(codes), minCodeSize: min }],
      }),
    );
    const img = frameOf(gif, 0).image;
    for (let i = 0; i < 4200; i += 31) expect(img.data[i * 4]).toBe(i % 256);
  });

  it('ignores data after the frame is full', () => {
    const indices = [0, 1, 2, 3];
    const long = lzwEncode([...indices, ...fill(5000, 2)], 2);
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [{ w: 2, h: 2, indices, lzw: long }],
      }),
    );
    expect(ascii(frameOf(gif, 0).image)).toEqual(['AB', 'CD']);
  });

  it('decodes a legitimate 2048x2048 frame at the canvas limit (a 4096:1 expansion) in bounded time', () => {
    const n = 2048 * 2048;
    const t0 = Date.now();
    const gif = decodeGif(
      buildGif({
        width: 2048,
        height: 2048,
        palette: PALETTE,
        frames: [{ w: 2048, h: 2048, indices: fill(n, 1) }],
      }),
    );
    expect(frameOf(gif, 0).image.data.length).toBe(n * 4);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---- hostile input -------------------------------------------------------------------------------------

describe('hostile input', () => {
  const ok = buildGif({
    width: 4,
    height: 3,
    palette: PALETTE,
    loop: 0,
    frames: [
      {
        w: 4,
        h: 3,
        indices: [0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 1],
        gce: { delayCs: 5, disposal: 1 },
      },
      { w: 4, h: 3, indices: [3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1], gce: { delayCs: 5 } },
    ],
  });

  it('refuses data that is not a GIF', () => {
    expect(code(() => decodeGif(new Uint8Array(0)))).toBe('BAD_GIF');
    expect(code(() => decodeGif(Uint8Array.of(0x47, 0x49, 0x46)))).toBe('BAD_GIF');
    expect(code(() => decodeGif(new TextEncoder().encode('GIF90a....')))).toBe('BAD_GIF');
    expect(code(() => decodeGif(file('pil_expected.json')))).toBe('BAD_GIF');
    expect(isGif(ok)).toBe(true);
    expect(isGif(file('pil_expected.json'))).toBe(false);
  });

  it('refuses a truncated file at every length', () => {
    for (let n = 0; n < ok.length; n++) {
      expect(
        code(() => decodeGif(ok.subarray(0, n))),
        `cut at ${String(n)}`,
      ).toBe('BAD_GIF');
    }
    expect(code(() => decodeGif(ok))).toBeUndefined();
  });

  it('refuses a real file that is truncated at many lengths', () => {
    const real = file('pil_opaque.gif');
    for (let n = 0; n < real.length; n += 3) {
      expect(
        code(() => decodeGif(real.subarray(0, n))),
        `cut at ${String(n)}`,
      ).toBe('BAD_GIF');
    }
  });

  it('refuses a missing trailer even at a block boundary', () => {
    expect(
      code(() =>
        decodeGif(
          buildGif({
            width: 1,
            height: 1,
            palette: PALETTE,
            trailer: false,
            frames: [{ w: 1, h: 1, indices: [0] }],
          }),
        ),
      ),
    ).toBe('BAD_GIF');
  });

  it('never throws anything but IoError and never hangs on mutated real files (fuzz)', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s >>> 8;
    };
    const names = [
      'pil_opaque.gif',
      'pil_interlaced.gif',
      'pil_sprite_disposal3.gif',
      'imageio_anim.gif',
    ];
    let failed = 0;
    let passed = 0;
    const t0 = Date.now();
    for (let i = 0; i < 1500; i++) {
      const bytes = file(need(names[i % names.length])).slice();
      const flips = 1 + (rnd() % 6);
      for (let k = 0; k < flips; k++) bytes[rnd() % bytes.length] = rnd() & 255;
      try {
        const gif = decodeGif(bytes, {
          limits: { maxCanvasPixels: 1 << 20, maxTotalPixels: 1 << 22 },
        });
        expect(gif.frames.length).toBeGreaterThan(0);
        passed++;
      } catch (e) {
        expect(e).toBeInstanceOf(IoError);
        expect(['BAD_GIF', 'TOO_LARGE']).toContain((e as IoError).code);
        failed++;
      }
    }
    expect(failed).toBeGreaterThan(100);
    expect(passed + failed).toBe(1500);
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  it('refuses random bytes behind a valid header', () => {
    let s = 99;
    for (let i = 0; i < 200; i++) {
      const bytes = new Uint8Array(200);
      for (let k = 0; k < bytes.length; k++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        bytes[k] = s >>> 16;
      }
      bytes.set(new TextEncoder().encode('GIF89a'));
      const c = code(() => decodeGif(bytes, { limits: { maxCanvasPixels: 1 << 16 } }));
      expect(c === undefined || c === 'BAD_GIF' || c === 'TOO_LARGE').toBe(true);
    }
  });

  describe('size limits (checked before any allocation)', () => {
    it('refuses a 65535x65535 screen', () => {
      const bytes = buildGif({
        width: 65535,
        height: 65535,
        palette: PALETTE,
        frames: [{ w: 1, h: 1, indices: [0] }],
      });
      expect(code(() => decodeGif(bytes))).toBe('TOO_LARGE');
    });

    it('refuses a screen over maxCanvasPixels, accepts one at it', () => {
      const bytes = buildGif({
        width: 100,
        height: 100,
        palette: PALETTE,
        frames: [{ w: 1, h: 1, indices: [0] }],
      });
      expect(code(() => decodeGif(bytes, { limits: { maxCanvasPixels: 9999 } }))).toBe('TOO_LARGE');
      expect(code(() => decodeGif(bytes, { limits: { maxCanvasPixels: 10000 } }))).toBeUndefined();
      expect(DEFAULT_GIF_LIMITS.maxCanvasPixels).toBe(2048 * 2048);
    });

    it('refuses a zero-size screen or frame', () => {
      expect(
        code(() =>
          decodeGif(
            buildGif({
              width: 0,
              height: 4,
              palette: PALETTE,
              frames: [{ w: 1, h: 1, indices: [0] }],
            }),
          ),
        ),
      ).toBe('BAD_GIF');
      expect(
        code(() =>
          decodeGif(
            buildGif({
              width: 4,
              height: 4,
              palette: PALETTE,
              frames: [{ w: 0, h: 1, indices: [] }],
            }),
          ),
        ),
      ).toBe('BAD_GIF');
    });

    it('refuses a frame larger than the screen, before allocating its pixels', () => {
      const bytes = buildGif({
        width: 10,
        height: 10,
        palette: PALETTE,
        frames: [{ w: 65535, h: 65535, indices: [], lzw: Uint8Array.of(0) }],
      });
      expect(code(() => decodeGif(bytes))).toBe('BAD_GIF');
    });

    it('refuses more frames than maxFrames (default 1000)', () => {
      const frames = (n: number) => Array.from({ length: n }, () => ({ w: 1, h: 1, indices: [0] }));
      const mk = (n: number) =>
        buildGif({ width: 1, height: 1, palette: PALETTE, frames: frames(n) });
      expect(code(() => decodeGif(mk(1001)))).toBe('TOO_LARGE');
      expect(decodeGif(mk(1000)).frames).toHaveLength(1000);
      expect(code(() => decodeGif(mk(3), { limits: { maxFrames: 2 } }))).toBe('TOO_LARGE');
    });

    it('refuses more decoded pixels in total than maxTotalPixels', () => {
      const f = { w: 10, h: 10, indices: fill(100, 0) };
      const bytes = buildGif({ width: 10, height: 10, palette: PALETTE, frames: [f, f, f, f, f] });
      expect(code(() => decodeGif(bytes, { limits: { maxTotalPixels: 499 } }))).toBe('TOO_LARGE');
      expect(code(() => decodeGif(bytes, { limits: { maxTotalPixels: 500 } }))).toBeUndefined();
    });

    it('does not trust a frame that claims the whole screen but carries a few bytes of data', () => {
      const bytes = buildGif({
        width: 2048,
        height: 2048,
        palette: PALETTE,
        frames: [
          {
            w: 2048,
            h: 2048,
            indices: [],
            lzw: packBits([
              [4, 3],
              [0, 3],
              [1, 3],
            ]),
          },
        ],
      });
      expect(code(() => decodeGif(bytes))).toBe('BAD_GIF');
    });

    it('caps the LZW output at the frame size: a stream for 1,000,000 pixels in a 1x1 frame', () => {
      const bytes = buildGif({
        width: 1,
        height: 1,
        palette: PALETTE,
        frames: [{ w: 1, h: 1, indices: [], lzw: lzwEncode(fill(1_000_000, 1), 2) }],
      });
      const gif = decodeGif(bytes);
      expect(ascii(frameOf(gif, 0).image)).toEqual(['B']);
    });
  });

  describe('LZW errors', () => {
    const frameWith = (codes: [number, number][], min = 2, w = 4, h = 1) =>
      buildGif({
        width: w,
        height: h,
        palette: PALETTE,
        frames: [{ w, h, indices: [], lzw: packBits(codes), minCodeSize: min }],
      });

    it('refuses a code that is not in the table yet', () => {
      // clear(4), 0, then code 9 (table has 6 entries) at 3 bits cannot be 9; use 7 > next (6)
      expect(
        code(() =>
          decodeGif(
            frameWith([
              [4, 3],
              [0, 3],
              [7, 3],
              [5, 3],
            ]),
          ),
        ),
      ).toBe('BAD_GIF');
    });

    it('refuses a code far beyond the table (511 when the table holds 258 entries)', () => {
      const codes: [number, number][] = [
        [256, 9],
        [0, 9],
      ];
      codes.push([511, 9]);
      expect(code(() => decodeGif(frameWith(codes, 8, 4, 1)))).toBe('BAD_GIF');
    });

    it('refuses an end code before the frame is full', () => {
      expect(
        code(() =>
          decodeGif(
            frameWith([
              [4, 3],
              [0, 3],
              [5, 3],
            ]),
          ),
        ),
      ).toBe('BAD_GIF');
    });

    it('refuses a first code that is not a colour index', () => {
      expect(
        code(() =>
          decodeGif(
            frameWith([
              [4, 3],
              [6, 3],
              [0, 3],
              [0, 3],
              [0, 3],
              [5, 3],
            ]),
          ),
        ),
      ).toBe('BAD_GIF');
    });

    it('accepts the KwKwK code (equal to the next free entry) right after a clear', () => {
      // clear, 1, 6 (= next, string "1 1"), 1 -> 1 1 1 1
      const gif = decodeGif(
        frameWith([
          [4, 3],
          [1, 3],
          [6, 3],
          [1, 3],
          [5, 3],
        ]),
      );
      expect(ascii(frameOf(gif, 0).image)).toEqual(['BBBB']);
    });

    it('runs out of data without an end code', () => {
      expect(
        code(() =>
          decodeGif(
            frameWith([
              [4, 3],
              [1, 3],
            ]),
          ),
        ),
      ).toBe('BAD_GIF');
    });

    it('refuses minimum code sizes outside 2..8', () => {
      for (const min of [0, 1, 9, 12, 255]) {
        expect(
          code(() =>
            decodeGif(
              frameWith(
                [
                  [4, 3],
                  [1, 3],
                  [5, 3],
                ],
                min,
                1,
                1,
              ),
            ),
          ),
          `min ${String(min)}`,
        ).toBe('BAD_GIF');
      }
    });
  });

  describe('block structure', () => {
    const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());
    const header = [
      ...Buffer.from('GIF89a', 'latin1'),
      2,
      0,
      2,
      0,
      0x80,
      0,
      0,
      0,
      0,
      0,
      255,
      255,
      255,
    ];
    const image = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];

    it('accepts the minimal hand-written file (control)', () => {
      const gif = decodeGif(bytes(header, image, [0x3b]));
      expect(gif.frames).toHaveLength(1);
      expect(Array.from(frameOf(gif, 0).image.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    });

    it('refuses an unknown block introducer', () => {
      expect(code(() => decodeGif(bytes(header, [0x99], image, [0x3b])))).toBe('BAD_GIF');
    });

    it('refuses a GCE whose size is not 4', () => {
      expect(
        code(() => decodeGif(bytes(header, [0x21, 0xf9, 5, 0, 0, 0, 0, 0, 0], image, [0x3b]))),
      ).toBe('BAD_GIF');
    });

    it('refuses a sub-block that runs past the end of the file', () => {
      expect(code(() => decodeGif(bytes(header, [0x21, 0xfe, 200, 1, 2, 3])))).toBe('BAD_GIF');
    });

    it('refuses an extension without its terminator', () => {
      expect(code(() => decodeGif(bytes(header, [0x21, 0xfe, 2, 1, 2])))).toBe('BAD_GIF');
    });

    it('refuses a frame with no colour table at all', () => {
      const noTable = [...Buffer.from('GIF89a', 'latin1'), 2, 0, 2, 0, 0, 0, 0];
      expect(code(() => decodeGif(bytes(noTable, image, [0x3b])))).toBe('BAD_GIF');
    });

    it('refuses a colour table cut short', () => {
      expect(code(() => decodeGif(bytes(header.slice(0, header.length - 2))))).toBe('BAD_GIF');
    });

    it('refuses a file with no frames', () => {
      expect(code(() => decodeGif(bytes(header, [0x3b])))).toBe('BAD_GIF');
    });

    it('stops at the trailer: bytes after it are ignored', () => {
      const gif = decodeGif(bytes(header, image, [0x3b], [1, 2, 3, 4]));
      expect(gif.frames).toHaveLength(1);
    });

    it('refuses an image descriptor cut short', () => {
      expect(code(() => decodeGif(bytes(header, [0x2c, 0, 0, 0])))).toBe('BAD_GIF');
    });
  });
});
