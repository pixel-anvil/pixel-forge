/**
 * Typed errors of the sheet import/export functions.
 * @packageDocumentation
 */

/**
 * Machine-readable codes of {@link IoError}. Additive: later cards may add codes.
 *
 * - `BAD_INPUT`: a malformed argument (cell size, scale, animation spec, sheet JSON).
 * - `CELL_OUT_OF_RANGE`: a `[row, col]` cell lies outside the sheet image.
 * - `SIZE_MISMATCH`: the outline sheet does not have the size of the main sheet.
 * - `DUPLICATE_ANIMATION`: an animation `(group, direction)` appears twice, or already exists.
 * - `TOO_LARGE`: the result cannot be made to fit the requested size limit or the image size limit.
 */
export type IoErrorCode =
  'BAD_INPUT' | 'CELL_OUT_OF_RANGE' | 'SIZE_MISMATCH' | 'DUPLICATE_ANIMATION' | 'TOO_LARGE';

/** The error type thrown by `@pixel-forge/io` sheet functions. Branch on `code`. */
export class IoError extends Error {
  readonly code: IoErrorCode;

  constructor(code: IoErrorCode, message: string) {
    super(message);
    this.name = 'IoError';
    this.code = code;
  }
}
