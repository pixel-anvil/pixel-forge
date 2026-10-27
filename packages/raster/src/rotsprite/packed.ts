/**
 * @internal Dense "one u32 per pixel" views of sparse images, used by the rotation kernels.
 *
 * RGBA pixels pack as `r | g << 8 | b << 16 | a << 24` (computed arithmetically, so independent of
 * platform endianness); any pixel with alpha 0 becomes the canonical empty value 0. Indexed pixels are
 * their index; the empty value is the image's `transparentIndex`. Two pixels are "the same colour"
 * exactly when their packed values are equal (exact RGBA / index equality, as Scale2x needs).
 */

import { RasterError } from '../errors.js';
import { IndexedImage, TiledImage } from '../image.js';
import type { Rect } from '../store.js';

/** The image kinds the rotation code accepts. */
export type RotatableImage = TiledImage | IndexedImage;

/** @internal A dense packed pixel block. */
export interface Packed {
  readonly w: number;
  readonly h: number;
  readonly p: Uint32Array;
}

/** @internal Kind information needed to read and rebuild an image. */
export interface PixelKind {
  readonly indexed: boolean;
  /** Packed value of an empty pixel: 0 for RGBA, `transparentIndex` for indexed. */
  readonly empty: number;
}

/** @internal Kind of `img`; throws `RasterError('MISMATCH')` for anything but the two image classes. */
export function kindOf(img: RotatableImage): PixelKind {
  if (img instanceof TiledImage) return { indexed: false, empty: 0 };
  if (img instanceof IndexedImage) return { indexed: true, empty: img.transparentIndex };
  throw new RasterError('MISMATCH', 'expected a TiledImage or IndexedImage');
}

/** @internal Packs the pixels of `img` inside `rect` (which must lie inside the image) densely. */
export function packRect(img: RotatableImage, kind: PixelKind, rect: Rect): Packed {
  const { x: rx, y: ry, w, h } = rect;
  const p = new Uint32Array(w * h);
  if (kind.empty !== 0) p.fill(kind.empty);
  if (kind.indexed) {
    img.store.forEachStored((x, y, buf, off) => {
      const lx = x - rx;
      const ly = y - ry;
      if (lx >= 0 && ly >= 0 && lx < w && ly < h) p[ly * w + lx] = buf[off] ?? 0;
    });
  } else {
    img.store.forEachStored((x, y, buf, off) => {
      const lx = x - rx;
      const ly = y - ry;
      const a = buf[off + 3] ?? 0;
      if (a === 0 || lx < 0 || ly < 0 || lx >= w || ly >= h) return;
      p[ly * w + lx] =
        ((buf[off] ?? 0) | ((buf[off + 1] ?? 0) << 8) | ((buf[off + 2] ?? 0) << 16) | (a << 24)) >>>
        0;
    });
  }
  return { w, h, p };
}

/**
 * @internal Builds an image of the given kind from the dense window `[x0, x0 + w) × [y0, y0 + h)` of
 * `src` (row stride `stride`). Only tiles holding a non-empty pixel are allocated.
 */
export function unpackWindow(
  kind: PixelKind,
  src: Uint32Array,
  stride: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): RotatableImage {
  if (kind.indexed) {
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = (y + y0) * stride + x0;
      for (let x = 0; x < w; x++) data[y * w + x] = src[row + x] ?? 0;
    }
    return IndexedImage.fromIndices(w, h, data, kind.empty);
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (y + y0) * stride + x0;
    for (let x = 0; x < w; x++) {
      const v = src[row + x] ?? 0;
      if (v === 0) continue;
      const o = (y * w + x) * 4;
      data[o] = v & 255;
      data[o + 1] = (v >>> 8) & 255;
      data[o + 2] = (v >>> 16) & 255;
      data[o + 3] = v >>> 24;
    }
  }
  return TiledImage.fromRGBA({ width: w, height: h, data });
}
