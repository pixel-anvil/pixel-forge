import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFrame } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import {
  createDocumentFromSpritesheet,
  decodeGif,
  encodeGif,
  exportGif,
  importGifTx,
  isGif,
} from '../src/index.js';
import type { GifEncodeFrame } from '../src/index.js';
import { ioCode, need, pngFromRows } from './helpers.js';

/** A deterministic pseudo-random byte stream (xorshift32), for noisy frames. */
function noise(seed: number, n: number): number[] {
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out.push((s >>> 0) & 255);
  }
  return out;
}

function frame(
  w: number,
  h: number,
  px: (x: number, y: number) => readonly [number, number, number, number],
  durationMs = 100,
): GifEncodeFrame {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data, durationMs };
}

/** A 12x8 sheet of 4x4 cells: three colours and transparency, a different pattern per cell. */
const SHEET = pngFromRows(
  [
    'RR..GG..B..BRRRR',
    'R...G...B.B.R..R',
    '..GG..RR.B.B....',
    '.GGG.RRR..B.GGGG',
    'BB..R...GGGGB..B',
    'B...RR..G..G.BB.',
    '..RR..GG.G..B..B',
    '.RRR.GGG..GG.BBB',
  ].map((r) => r.slice(0, 12)),
  { R: [220, 40, 40, 255], G: [40, 200, 60, 255], B: [30, 60, 220, 255] },
);

/** idle (loop, 3 frames), run (pingpong, 3 frames), jump (once, 2 frames), on the sheet above. */
function build() {
  const { store } = createDocumentFromSpritesheet({
    png: SHEET,
    cell: [4, 4],
    animations: [
      {
        group: 'idle',
        frames: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
        durationMs: 120,
      },
      {
        group: 'run',
        frames: [
          [1, 0],
          [1, 1],
          [1, 2],
        ],
        durationMs: 70,
        loop: 'pingpong',
      },
      {
        group: 'jump',
        frames: [
          [0, 0],
          [1, 1],
        ],
        durationMs: 50,
        loop: 'once',
      },
    ],
  });
  return store;
}

const rgbaOf = (img: { toRGBA(): { data: Uint8Array } }) => img.toRGBA().data;

/** Transparent pixels compare as 0,0,0,0 (a GIF keeps no colour for them). */
function normalise(data: Uint8Array): number[] {
  const out = [...data];
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) out.fill(0, i, i + 4);
  }
  return out;
}

describe('encodeGif', () => {
  it('writes the exact bytes of a tiny two-colour opaque loop (hand-assembled from the spec)', () => {
    const red = [255, 0, 0, 255] as const;
    const blue = [0, 0, 255, 255] as const;
    const out = encodeGif([frame(2, 1, (x) => (x === 0 ? red : blue), 100)]);
    const b = [...out.bytes];
    // Header, logical screen (2x1, global table of 2, 8-bit resolution), colour table.
    expect(b.slice(0, 13)).toEqual(
      Array.from('GIF89a', (c) => c.charCodeAt(0)).concat([2, 0, 1, 0, 0xf0, 0, 0]),
    );
    expect(b.slice(13, 19)).toEqual([255, 0, 0, 0, 0, 255]);
    // NETSCAPE2.0 forever.
    expect(b.slice(19, 19 + 19)).toEqual([
      0x21,
      0xff,
      11,
      ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)),
      3,
      1,
      0,
      0,
      0,
    ]);
    // GCE: disposal 1, no transparency, 10 cs. Image descriptor 2x1. Min code size 2.
    expect(b.slice(38, 46)).toEqual([0x21, 0xf9, 4, 0x04, 10, 0, 0, 0]);
    expect(b.slice(46, 56)).toEqual([0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0]);
    // LZW: min code size 2; codes clear(4) 0 1 eoi(5) at 3 bits each, LSB first: 0x44 0x0a; terminator; trailer.
    expect(b.slice(56)).toEqual([2, 2, 0x44, 0x0a, 0, 0x3b]);
    expect(out.colors).toBe(2);
    expect(out.transparent).toBe(false);
  });

  it('is deterministic and decodes to the same pixels (transparency, 3 colours)', () => {
    const f = (t: number) =>
      frame(5, 4, (x, y) => {
        if ((x + y + t) % 3 === 0) return [0, 0, 0, 0];
        return (x + t) % 2 === 0 ? [10, 20, 30, 255] : [200, 100, 50, 255];
      });
    const frames = [f(0), f(1), f(2)];
    const a = encodeGif(frames);
    expect(a.bytes).toEqual(encodeGif(frames).bytes);
    expect(isGif(a.bytes)).toBe(true);
    expect(a.transparent).toBe(true);
    const dec = decodeGif(a.bytes);
    expect(dec.loopCount).toBe(0);
    expect(dec.frames.map((x) => x.durationMs)).toEqual([100, 100, 100]);
    dec.frames.forEach((g, i) => {
      expect(normalise(g.image.data)).toEqual(normalise(need(frames[i]).data));
      expect(g.disposal).toBe(2);
    });
  });

  it.each([2, 3, 4, 17, 64, 200, 256])(
    'round-trips noisy frames with %i colours (LZW table resets)',
    (n) => {
      const colors: [number, number, number][] = Array.from({ length: n }, (_, i) => [
        i,
        255 - i,
        (i * 7) & 255,
      ]);
      const w = 90;
      const h = 70; // 6300 pixels of noise: more than 4096 codes, so the table is cleared
      const picks = (seed: number) => noise(seed, w * h);
      const mk = (seed: number) => {
        const p = picks(seed);
        return frame(w, h, (x, y) => {
          // Make sure all n colours appear in frame 0, whatever the noise.
          const i = y * w + x;
          const c = colors[(seed === 1 && i < n ? i : (p[i] ?? 0)) % n] ?? [0, 0, 0];
          return [c[0], c[1], c[2], 255];
        });
      };
      const frames = [mk(1), mk(2)];
      const enc = encodeGif(frames, { loop: 'once' });
      expect(enc.colors).toBe(n);
      const dec = decodeGif(enc.bytes);
      expect(dec.loopCount).toBeUndefined();
      dec.frames.forEach((g, i) => {
        expect([...g.image.data]).toEqual([...need(frames[i]).data]);
      });
    },
  );

  it('holds 255 colours plus transparency, and refuses 256 plus transparency', () => {
    const mk = (n: number) => frame(n + 1, 1, (x) => (x === n ? [0, 0, 0, 0] : [x, 1, 2, 255]));
    const ok = encodeGif([mk(255)]);
    expect(ok.colors).toBe(255);
    expect(decodeGif(ok.bytes).frames).toHaveLength(1);
    expect(ioCode(() => encodeGif([mk(256)]))).toBe('PALETTE_TOO_LARGE');
    // 256 opaque colours alone is fine.
    expect(encodeGif([frame(256, 1, (x) => [x, 0, 0, 255])]).colors).toBe(256);
    expect(ioCode(() => encodeGif([frame(257, 1, (x) => [x & 255, x >> 8, 0, 255])]))).toBe(
      'PALETTE_TOO_LARGE',
    );
  });

  it('counts colours over all frames, not per frame', () => {
    const a = frame(200, 1, (x) => [x, 0, 0, 255]);
    const b = frame(200, 1, (x) => [x, 9, 0, 255]);
    expect(ioCode(() => encodeGif([a, b]))).toBe('PALETTE_TOO_LARGE');
  });

  it('refuses partial alpha, bad sizes, durations and no frames', () => {
    expect(ioCode(() => encodeGif([frame(1, 1, () => [1, 2, 3, 128])]))).toBe('BAD_INPUT');
    expect(ioCode(() => encodeGif([]))).toBe('BAD_INPUT');
    expect(ioCode(() => encodeGif([frame(1, 1, () => [1, 2, 3, 255], 0)]))).toBe('BAD_INPUT');
    expect(ioCode(() => encodeGif([frame(1, 1, () => [1, 2, 3, 255], 1.5)]))).toBe('BAD_INPUT');
    expect(
      ioCode(() =>
        encodeGif([frame(1, 1, () => [1, 2, 3, 255]), frame(2, 1, () => [1, 2, 3, 255])]),
      ),
    ).toBe('BAD_INPUT');
  });

  it('rounds delays to centiseconds with a floor of 1', () => {
    const px = () => [1, 2, 3, 255] as const;
    const enc = encodeGif([frame(1, 1, px, 4), frame(1, 1, px, 126), frame(1, 1, px, 999_999)]);
    expect(decodeGif(enc.bytes).frames.map((f) => f.durationMs)).toEqual([10, 130, 655_350]);
  });

  it('encodes a single colour (table of 2, min code size 2) and a one-pixel image', () => {
    const enc = encodeGif([frame(1, 1, () => [9, 8, 7, 255])]);
    expect([...need(decodeGif(enc.bytes).frames[0]).image.data]).toEqual([9, 8, 7, 255]);
    const clear = encodeGif([frame(3, 2, () => [0, 0, 0, 0])]);
    expect(clear.colors).toBe(0);
    expect(need(decodeGif(clear.bytes).frames[0]).image.data.every((v) => v === 0)).toBe(true);
  });

  it('file import of our own output gives back the animation (durations, loop, pixels)', () => {
    const store = build();
    const out = exportGif(store, { animation: { group: 'idle' }, scale: 1 });
    const { store: s2 } = createDocumentFromSpritesheet({
      png: SHEET,
      cell: [4, 4],
      animations: [{ group: 'idle', frames: [[0, 0]] }],
    });
    s2.transact('gif', (tx) => importGifTx(tx, { gif: out.gif, group: 'back' }));
    const back = s2.doc.animations.find((a) => 'frames' in a && a.group === 'back');
    expect(back && 'frames' in back && back.frames.map((f) => f.durationMs)).toEqual([
      120, 120, 120,
    ]);
    expect(back && 'loop' in back && back.loop).toBe('loop');
  });
});

describe('exportGif', () => {
  it('matches renderFrame frame by frame, keeps durations and the loop flag', () => {
    const store = build();
    const out = exportGif(store, { animation: { group: 'idle' } });
    expect(out).toMatchObject({ animation: 'idle', frames: 3, size: { w: 4, h: 4 } });
    const dec = decodeGif(out.gif);
    expect(dec.loopCount).toBe(0);
    expect(dec.frames.map((f) => f.durationMs)).toEqual([120, 120, 120]);
    dec.frames.forEach((g, i) => {
      const want = rgbaOf(renderFrame(store, { group: 'idle' }, i, { exportOnly: true }));
      expect(normalise(g.image.data)).toEqual(normalise(want));
    });
  });

  it('plays once for a once animation and writes the way back for pingpong', () => {
    const store = build();
    expect(
      decodeGif(exportGif(store, { animation: { group: 'jump' } }).gif).loopCount,
    ).toBeUndefined();
    const pp = exportGif(store, { animation: { group: 'run' } });
    expect(pp.frames).toBe(4); // 0 1 2 1
    const dec = decodeGif(pp.gif);
    expect(dec.loopCount).toBe(0);
    const want = [0, 1, 2, 1].map((i) =>
      normalise(rgbaOf(renderFrame(store, { group: 'run' }, i, { exportOnly: true }))),
    );
    expect(dec.frames.map((f) => normalise(f.image.data))).toEqual(want);
  });

  it('scales by an integer factor', () => {
    const store = build();
    const out = exportGif(store, { animation: { group: 'jump' }, scale: 3 });
    expect(out.size).toEqual({ w: 12, h: 12 });
    expect(decodeGif(out.gif).width).toBe(12);
    expect(ioCode(() => exportGif(store, { animation: { group: 'jump' }, scale: 17 }))).toBe(
      'BAD_INPUT',
    );
  });

  it('needs a named animation when the document has several', () => {
    expect(ioCode(() => exportGif(build()))).toBe('BAD_INPUT');
  });

  // Oracle outside this repository: macOS ImageIO through `sips` (Aseprite is not installed).
  it.runIf(process.platform === 'darwin')(
    'is read by macOS sips (size, first frame pixels)',
    () => {
      const store = build();
      const out = exportGif(store, { animation: { group: 'idle' }, scale: 2 });
      const dir = mkdtempSync(join(tmpdir(), 'pf-gif-'));
      try {
        const gifPath = join(dir, 'a.gif');
        const pngPath = join(dir, 'a.png');
        writeFileSync(gifPath, out.gif);
        const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', gifPath], {
          encoding: 'utf8',
        });
        expect(info).toMatch(/pixelWidth: 8/);
        expect(info).toMatch(/pixelHeight: 8/);
        execFileSync('sips', ['-s', 'format', 'png', gifPath, '--out', pngPath], {
          stdio: 'ignore',
        });
        const png = decodePng(new Uint8Array(readFileSync(pngPath)));
        const first = exportGif(store, { animation: { group: 'idle' }, scale: 2 });
        const mine = need(decodeGif(first.gif).frames[0]).image.data;
        expect(normalise(png.data)).toEqual(normalise(mine));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
