/**
 * Machine-readable codes of {@link ConvertError}. Additive: later cards may add codes.
 *
 * - `BAD_IMAGE`: the input is not a valid `RgbaImage` (size not a positive integer, or wrong data length).
 * - `BAD_RECT`: a crop rectangle has non-integer fields, a non-positive size, or leaves the image.
 * - `BAD_OPTION`: a step option is invalid (tolerance, threshold or colour out of range).
 * - `BAD_PALETTE`: a palette given to `quantize` is empty, too large (> 256), malformed or has no visible colour.
 * - `BAD_RECIPE`: a `ConvertRecipe` is malformed (unknown key, wrong type, bad version, no downscale target).
 * - `NO_GRID`: a recipe asked for an automatic grid (`grid: 'auto'`, `onNoGrid: 'error'`) and `detectGrid` found none.
 * - `BAD_AXES`: the axes given to `runVariants` are malformed or do not fit the base recipe.
 * - `TOO_MANY_VARIANTS`: the product of the axes is larger than the variant cap.
 */
export type ConvertErrorCode =
  | 'BAD_IMAGE'
  | 'BAD_RECT'
  | 'BAD_OPTION'
  | 'BAD_PALETTE'
  | 'BAD_RECIPE'
  | 'NO_GRID'
  | 'BAD_AXES'
  | 'TOO_MANY_VARIANTS';

/** Typed error thrown by every step of `@pixel-forge/convert`. Branch on `code`. */
export class ConvertError extends Error {
  readonly code: ConvertErrorCode;

  constructor(code: ConvertErrorCode, message: string) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}
