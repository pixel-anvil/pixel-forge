import { RasterError } from './errors.js';
import type { SparseImage } from './image.js';
import { checkInts } from './store.js';
import type { Rect } from './store.js';

/** Integer affine map `x' = a*x + b*y + c`, `y' = d*x + e*y + f`. */
type Affine = readonly [number, number, number, number, number, number];

/**
 * Applies a bijective integer map to every stored (non-empty) pixel of `src`, producing an image of size
 * `w2 x h2` of the same kind. Sparsity is preserved (only tiles that receive a pixel are allocated).
 */
function mapPixels<T extends SparseImage>(src: T, w2: number, h2: number, m: Affine): T {
  const out = src.emptyLike(w2, h2);
  const [a, b, c, d, e, f] = m;
  const os = out.store;
  src.store.forEachStored((x, y, buf, off) => {
    os.setRaw(a * x + b * y + c, d * x + e * y + f, buf, off);
  });
  os.markPristine();
  return out;
}

/** Mirrors left to right. A new image; the input is untouched. */
export function flipH<T extends SparseImage>(img: T): T {
  return mapPixels(img, img.width, img.height, [-1, 0, img.width - 1, 0, 1, 0]);
}

/** Mirrors top to bottom. */
export function flipV<T extends SparseImage>(img: T): T {
  return mapPixels(img, img.width, img.height, [1, 0, 0, 0, -1, img.height - 1]);
}

/** Rotates 90 degrees clockwise (y down): the result is `height x width`; `(x, y)` goes to `(h-1-y, x)`. */
export function rot90<T extends SparseImage>(img: T): T {
  return mapPixels(img, img.height, img.width, [0, -1, img.height - 1, 1, 0, 0]);
}

/** Rotates 180 degrees. */
export function rot180<T extends SparseImage>(img: T): T {
  return mapPixels(img, img.width, img.height, [-1, 0, img.width - 1, 0, -1, img.height - 1]);
}

/** Rotates 270 degrees clockwise (= 90 counter-clockwise): the result is `height x width`; `(x, y)` goes to `(y, w-1-x)`. */
export function rot270<T extends SparseImage>(img: T): T {
  return mapPixels(img, img.height, img.width, [0, 1, 0, -1, 0, img.width - 1]);
}

/**
 * Integer nearest-neighbour upscale by `k >= 1`: every pixel becomes a `k x k` block.
 * Throws `RasterError` when `k` is not a positive integer or the result exceeds `MAX_DIMENSION`.
 */
export function scaleInt<T extends SparseImage>(img: T, k: number): T {
  checkInts('scale factor', k);
  if (k < 1) throw new RasterError('BAD_SIZE', `scale factor must be >= 1, got ${String(k)}`);
  const out = img.emptyLike(img.width * k, img.height * k); // validates the size
  const os = out.store;
  img.store.forEachStored((x, y, buf, off) => {
    for (let j = 0; j < k; j++)
      for (let i = 0; i < k; i++) os.setRaw(x * k + i, y * k + j, buf, off);
  });
  os.markPristine();
  return out;
}

/**
 * Copies the rectangle `rect` into a new `rect.w x rect.h` image. Parts of `rect` outside `img` are empty.
 * `rect.x`/`rect.y` are integers (may be negative); `w`/`h` are positive integers.
 */
export function crop<T extends SparseImage>(img: T, rect: Rect): T {
  checkInts('rect', rect.x, rect.y, rect.w, rect.h);
  const out = img.emptyLike(rect.w, rect.h);
  const os = out.store;
  img.store.forEachStored((x, y, buf, off) => {
    const nx = x - rect.x;
    const ny = y - rect.y;
    if (nx >= 0 && ny >= 0 && nx < rect.w && ny < rect.h) os.setRaw(nx, ny, buf, off);
  });
  os.markPristine();
  return out;
}

/**
 * Moves the content by `(dx, dy)` into a new image of the same size; pixels pushed outside are lost and the
 * uncovered area is empty.
 */
export function translate<T extends SparseImage>(img: T, dx: number, dy: number): T {
  checkInts('translation', dx, dy);
  return crop(img, { x: -dx, y: -dy, w: img.width, h: img.height });
}
