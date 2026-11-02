import { RasterError } from '../errors.js';
import { TiledImage } from '../image.js';
import type { IndexedImage, SparseImage } from '../image.js';
import { N4, N8, opaqueFn } from './shared.js';

/** Options of {@link removeOrphans}; the defaults match the animation schema's empty `removeOrphans` object. */
export interface RemoveOrphansOptions {
  /** Minimum number of opaque neighbours a pixel needs to survive; integer 0..8 (default 1). */
  minNeighbours?: number;
  /** Which neighbours count: 4 (edge) or 8 (edge and diagonal). Default 8. */
  connectivity?: 4 | 8;
}

/**
 * Removes "orphan" pixels. A pixel is opaque when its alpha is not 0 (RGBA) or its index is not the
 * image's `transparentIndex`. An opaque pixel is removed when the number of opaque pixels among its 4 or
 * 8 neighbours (outside the image counts as empty) is below `minNeighbours`.
 *
 * Single pass: every count is taken on the INPUT, so removals never cascade (a 3-pixel line with
 * `minNeighbours: 2` loses both end pixels, but the surviving middle pixel is not re-tested). The input is
 * not modified; the result is a clone with the orphans set to transparent. `removed` is the pixel count.
 * `minNeighbours: 0` removes nothing.
 */
export function removeOrphans<T extends TiledImage | IndexedImage>(
  img: T,
  opts: RemoveOrphansOptions = {},
): { img: T; removed: number } {
  const min = opts.minNeighbours ?? 1;
  const conn: number = opts.connectivity ?? 8;
  if (!Number.isInteger(min) || min < 0 || min > 8) {
    throw new RasterError('BAD_VALUE', `minNeighbours must be an integer 0..8, got ${String(min)}`);
  }
  if (conn !== 4 && conn !== 8) {
    throw new RasterError('BAD_VALUE', `connectivity must be 4 or 8, got ${String(conn)}`);
  }
  const out = img.clone() as T;
  const target: TiledImage | IndexedImage = out;
  const b = (img as SparseImage as TiledImage).bounds();
  if (min === 0 || b === undefined) return { img: out, removed: 0 };
  const opaque = opaqueFn(img);
  const offs = conn === 4 ? N4 : N8;
  const doomed: [number, number][] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      if (!opaque(x, y)) continue;
      let n = 0;
      for (const [dx, dy] of offs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < img.width && ny < img.height && opaque(nx, ny)) n++;
      }
      if (n < min) doomed.push([x, y]);
    }
  }
  for (const [x, y] of doomed) {
    if (target instanceof TiledImage) target.set(x, y, [0, 0, 0, 0]);
    else target.set(x, y, target.transparentIndex);
  }
  return { img: out, removed: doomed.length };
}
