import type { Rect, RgbaImage } from '@pixel-forge/raster';
import { ConvertError } from './errors.js';

/** Checks that `img` is a well-formed dense RGBA image. Shared by all steps. */
export function assertImage(img: RgbaImage): void {
  if (
    !Number.isInteger(img.width) ||
    !Number.isInteger(img.height) ||
    img.width < 1 ||
    img.height < 1
  ) {
    throw new ConvertError(
      'BAD_IMAGE',
      `invalid image size ${String(img.width)}x${String(img.height)}`,
    );
  }
  if (img.data.length !== img.width * img.height * 4) {
    throw new ConvertError('BAD_IMAGE', `data length ${String(img.data.length)} != width*height*4`);
  }
}

/** Options of the `crop` step: a rectangle in source pixels (origin top-left). Recipe field later (E4.4). */
export type CropOptions = Rect;

/**
 * Copies the rectangle `rect` of `img` into a new image. Pure; the input is not changed.
 * @param img - source image
 * @param rect - `x`, `y` (>= 0) and `w`, `h` (>= 1), all integers, fully inside the image
 * @returns a new `rect.w x rect.h` image
 * @throws ConvertError `BAD_RECT` if a field is not an integer, the size is not positive, or the
 *   rectangle is not inside the image; `BAD_IMAGE` if `img` is malformed
 */
export function cropImage(img: RgbaImage, rect: CropOptions): RgbaImage {
  assertImage(img);
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((v) => Number.isInteger(v))) {
    throw new ConvertError('BAD_RECT', 'crop rect fields must be integers');
  }
  if (w < 1 || h < 1) throw new ConvertError('BAD_RECT', 'crop rect size must be positive');
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) {
    throw new ConvertError(
      'BAD_RECT',
      `crop rect ${String(x)},${String(y)} ${String(w)}x${String(h)} is outside the ${String(img.width)}x${String(img.height)} image`,
    );
  }
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}
