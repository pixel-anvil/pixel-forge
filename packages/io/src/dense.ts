/**
 * Dense RGBA helpers shared by the sheet export and the contact sheet.
 * @packageDocumentation
 */
import { MAX_DIMENSION, blendOver } from '@pixel-forge/raster';
import { IoError } from './errors.js';

/** Largest integer scale for export and contact sheets (FR-DOC-06). */
export const MAX_SCALE = 16;

/** Checks that `scale` is an integer in 1..16. */
export function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_SCALE) {
    throw new IoError(
      'BAD_INPUT',
      `scale must be an integer 1..${String(MAX_SCALE)}, got ${String(scale)}`,
    );
  }
}

/** Checks that an output image size is allowed and allocatable. */
export function checkSize(w: number, h: number): void {
  if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) {
    throw new IoError('TOO_LARGE', `image of ${String(w)}x${String(h)} is out of range`);
  }
}

/** A dense RGBA8 buffer. */
export interface Dense {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A transparent dense buffer. */
export function blank(width: number, height: number): Dense {
  checkSize(width, height);
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Fills the rectangle (clipped) with one colour, replacing the pixels. */
export function fillRect(
  dst: Dense,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: readonly [number, number, number, number],
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dst.width, x + w);
  const y1 = Math.min(dst.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      dst.data.set(rgba, (yy * dst.width + xx) * 4);
    }
  }
}

/**
 * Copies (`over = false`) or blends "over" (`over = true`) `src` scaled by the integer `k` into `dst`
 * with its top-left at `(x, y)`; clipped to `dst`.
 */
export function blitScaled(
  dst: Dense,
  src: Dense,
  x: number,
  y: number,
  k: number,
  over: boolean,
): void {
  const px: number[] = [0, 0, 0, 0];
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const so = (sy * src.width + sx) * 4;
      const sr = src.data[so] ?? 0;
      const sg = src.data[so + 1] ?? 0;
      const sb = src.data[so + 2] ?? 0;
      const sa = src.data[so + 3] ?? 0;
      if (over && sa === 0) continue;
      for (let dy = 0; dy < k; dy++) {
        const yy = y + sy * k + dy;
        if (yy < 0 || yy >= dst.height) continue;
        for (let dx = 0; dx < k; dx++) {
          const xx = x + sx * k + dx;
          if (xx < 0 || xx >= dst.width) continue;
          const o = (yy * dst.width + xx) * 4;
          if (over) {
            blendOver(
              sr,
              sg,
              sb,
              sa,
              dst.data[o] ?? 0,
              dst.data[o + 1] ?? 0,
              dst.data[o + 2] ?? 0,
              dst.data[o + 3] ?? 0,
              px,
            );
            dst.data[o] = px[0] ?? 0;
            dst.data[o + 1] = px[1] ?? 0;
            dst.data[o + 2] = px[2] ?? 0;
            dst.data[o + 3] = px[3] ?? 0;
          } else {
            dst.data[o] = sr;
            dst.data[o + 1] = sg;
            dst.data[o + 2] = sb;
            dst.data[o + 3] = sa;
          }
        }
      }
    }
  }
}
