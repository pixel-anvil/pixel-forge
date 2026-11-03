/**
 * Machine-readable codes of {@link ConvertError}. Additive: later cards may add codes.
 *
 * - `BAD_IMAGE`: the input is not a valid `RgbaImage` (size not a positive integer, or wrong data length).
 * - `BAD_RECT`: a crop rectangle has non-integer fields, a non-positive size, or leaves the image.
 * - `BAD_OPTION`: a step option is invalid (tolerance, threshold or colour out of range).
 */
export type ConvertErrorCode = 'BAD_IMAGE' | 'BAD_RECT' | 'BAD_OPTION';

/** Typed error thrown by every step of `@pixel-forge/convert`. Branch on `code`. */
export class ConvertError extends Error {
  readonly code: ConvertErrorCode;

  constructor(code: ConvertErrorCode, message: string) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}
