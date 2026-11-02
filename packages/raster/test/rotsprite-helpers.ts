import { asciiToImage } from '@pixel-forge/testkit';
import { IndexedImage, TiledImage } from '../src/index.js';
import type { Pivot, Rgba } from '../src/index.js';
import { kindOf, unpackWindow } from '../src/rotsprite/packed.js';
import type { RotatableImage } from '../src/rotsprite/packed.js';
import type { rotateWindow } from '../src/rotsprite/rotate.js';
import { LEGEND } from './rotsprite-fixtures.js';
import type { Subject } from './rotsprite-fixtures.js';
import { rng } from './util.js';

/** A subject's image. */
export const subjectImage = (s: Subject): TiledImage =>
  TiledImage.fromRGBA(asciiToImage(s.ascii, LEGEND));

/**
 * Non-empty pixels keyed by their offset from `pivot` (`"dx,dy"`), valued by colour (`"r,g,b,a"`) or
 * index. Comparing two maps compares content and pivot placement, independent of the canvas.
 */
export function relMap(img: RotatableImage, pivot: Pivot, flip = false): Map<string, string> {
  const m = new Map<string, string>();
  const w = img.width;
  const key = (x: number, y: number): string =>
    `${String((flip ? -1 : 1) * (x - pivot.x) + 0)},${String(y - pivot.y)}`;
  if (img instanceof IndexedImage) {
    const d = img.toIndices();
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < w; x++) {
        const v = d[y * w + x] ?? 0;
        if (v !== img.transparentIndex) m.set(key(x, y), String(v));
      }
    }
    return m;
  }
  const d = img.toRGBA().data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if ((d[o + 3] ?? 0) === 0) continue;
      m.set(
        key(x, y),
        `${String(d[o])},${String(d[o + 1])},${String(d[o + 2])},${String(d[o + 3])}`,
      );
    }
  }
  return m;
}

/** Mask IoU of two relative maps. */
export function iou(a: Map<string, string>, b: Map<string, string>): number {
  let inter = 0;
  for (const k of a.keys()) if (b.has(k)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 1 : inter / uni;
}

/** Opaque (non-empty) pixel count. */
export function opaqueCount(img: RotatableImage): number {
  return relMap(img, { x: 0, y: 0 }).size;
}

/** The image of an internal rotation window. */
export function windowImage(
  kindSource: RotatableImage,
  win: ReturnType<typeof rotateWindow>,
): RotatableImage {
  return unpackWindow(kindOf(kindSource), win.buf, win.stride, win.x0, win.y0, win.w, win.h);
}

/** Random image whose pixels come from a small palette (so Scale2x finds equal neighbours). */
export function paletteImage(
  w: number,
  h: number,
  seed: number,
  colours: readonly Rgba[],
  density = 0.75,
): TiledImage {
  const r = rng(seed);
  const img = new TiledImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (r() >= density) continue;
      const c = colours[Math.floor(r() * colours.length)];
      if (c !== undefined) img.set(x, y, c);
    }
  }
  return img;
}

/** Random indexed image with indices `1..n` (and `transparentIndex` for empty pixels). */
export function indexedImage(
  w: number,
  h: number,
  seed: number,
  n: number,
  transparentIndex: number,
): IndexedImage {
  const r = rng(seed);
  const img = new IndexedImage(w, h, transparentIndex);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (r() < 0.3) continue;
      img.set(x, y, 1 + Math.floor(r() * n));
    }
  }
  return img;
}

/** Three opaque colours (plus transparency) for the palette images. */
export const TRIO: readonly Rgba[] = [
  [200, 30, 30, 255],
  [30, 200, 30, 255],
  [30, 30, 200, 255],
];
