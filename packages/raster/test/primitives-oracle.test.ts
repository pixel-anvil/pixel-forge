import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ellipse, line, TiledImage } from '../src/index.js';

/**
 * Oracle: PNGs drawn by Aseprite itself through `app.useTool` (`oracle/aseprite-primitives.lua`, regenerate with
 * `aseprite -b --script aseprite-primitives.lua` from that directory). The cases and coordinates below must match
 * the Lua file. Lines are given left-to-right: pixel-forge canonicalises line direction (symmetry), Aseprite
 * does not, so only the canonical direction is guaranteed identical (see README, "Primitives"). The ellipse is
 * Zingl's plotEllipseRect, implemented independently of Aseprite; all ellipse cases below happen to be
 * pixel-identical. Other sizes may differ from Aseprite (intentional, see README).
 */

/** Minimal PNG reader for what Aseprite writes: 8-bit RGBA, non-interlaced. Returns the opaque-pixel set. */
function readOpaque(file: string): { width: number; height: number; set: Set<string> } {
  const buf = readFileSync(new URL(`./oracle/${file}.png`, import.meta.url));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect([buf[24], buf[25], buf[28]]).toEqual([8, 6, 0]); // bit depth, colour type RGBA, not interlaced
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT')
      idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (px[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 4 ? (px[(y - 1) * stride + i - 4] ?? 0) : 0;
      let v: number;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + i] = v & 255;
    }
  }
  const set = new Set<string>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[y * stride + x * 4 + 3] !== 0) set.add(`${String(x)},${String(y)}`);
    }
  }
  return { width, height, set };
}

function opaque(img: TiledImage): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++)
      if (img.get(x, y)[3] !== 0) out.add(`${String(x)},${String(y)}`);
  }
  return out;
}

function render(f: (img: TiledImage) => void): Set<string> {
  const img = new TiledImage(24, 24);
  f(img);
  return opaque(img);
}

type Pt = readonly [number, number];
const cases: [string, 'line' | 'ellipse' | 'fellipse', Pt, Pt][] = [
  ['line-shallow', 'line', [1, 2], [20, 9]],
  ['line-steep', 'line', [3, 1], [9, 21]],
  ['line-up', 'line', [2, 20], [21, 4]],
  ['line-diagonal', 'line', [2, 3], [17, 18]],
  ['line-tie', 'line', [0, 0], [10, 5]],
  ['ellipse-5x5', 'ellipse', [2, 2], [6, 6]],
  ['ellipse-8x6', 'ellipse', [1, 1], [8, 6]],
  ['ellipse-12x7', 'ellipse', [2, 3], [13, 9]],
  ['ellipse-9x14', 'ellipse', [4, 2], [12, 15]],
  ['ellipse-4x3', 'ellipse', [5, 5], [8, 7]],
  ['fellipse-8x6', 'fellipse', [1, 1], [8, 6]],
  ['fellipse-11x9', 'fellipse', [2, 2], [12, 10]],
];

describe('primitives vs Aseprite (app.useTool oracle)', () => {
  it.each(cases)('%s', (name, kind, [x0, y0], [x1, y1]) => {
    const oracle = readOpaque(name);
    expect(oracle.set.size).toBeGreaterThan(0);
    const mine = render((img) => {
      if (kind === 'line') line(img, x0, y0, x1, y1, [255, 0, 0, 255]);
      else ellipse(img, x0, y0, x1, y1, [255, 0, 0, 255], { fill: kind === 'fellipse' });
    });
    expect([...mine].sort()).toEqual([...oracle.set].sort());
  });
});
