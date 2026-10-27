/** Machine-readable reason of a {@link RasterError}. */
export type RasterErrorCode =
  | 'BAD_SIZE' // width/height not a positive integer within MAX_DIMENSION
  | 'NON_INTEGER' // a coordinate, offset, factor or rect field is not an integer
  | 'BAD_VALUE' // a channel, index or opacity is outside 0..255
  | 'BAD_DATA' // a raw buffer has the wrong length
  | 'BAD_TILE' // tile coordinates outside the image grid, or tile data of the wrong length
  | 'MISMATCH' // two images of different kinds (RGBA vs indexed, or different transparent index)
  | 'SAME_IMAGE'; // composite/blit of an image onto itself

/** Typed error thrown for every programmer error in `@pixel-forge/raster` (never for plain out-of-bounds access). */
export class RasterError extends Error {
  readonly code: RasterErrorCode;
  constructor(code: RasterErrorCode, message: string) {
    super(message);
    this.name = 'RasterError';
    this.code = code;
  }
}
