import { RasterError } from '../errors.js';
import { IndexedImage, TiledImage } from '../image.js';
import type { SparseImage } from '../image.js';

/** Predicate "this pixel is opaque (non-empty)" for either image kind. Coordinates must be inside. */
export function opaqueFn(img: SparseImage): (x: number, y: number) => boolean {
  if (img instanceof TiledImage) return (x, y) => img.get(x, y)[3] !== 0;
  if (img instanceof IndexedImage) {
    const t = img.transparentIndex;
    return (x, y) => img.get(x, y) !== t;
  }
  throw new RasterError('MISMATCH', 'expected a TiledImage or IndexedImage');
}

/** 4-connected neighbour offsets. */
export const N4: readonly (readonly [number, number])[] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];
/** 8-connected neighbour offsets. */
export const N8: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
