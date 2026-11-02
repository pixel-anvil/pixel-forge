/** Machine-readable reason carried by every {@link PngError}. */
export type PngErrorCode =
  /** Encoder: width or height is not an integer in `1..2^31-1`. */
  | 'INVALID_DIMENSIONS'
  /** Encoder: `data.length` does not equal `width * height * bytesPerPixel`. */
  | 'INVALID_DATA_LENGTH'
  /** Encoder: `kind` is neither `'rgba'` nor `'gray8'`. */
  | 'INVALID_KIND'
  /** Decoder: the first eight bytes are not the PNG signature. */
  | 'BAD_SIGNATURE'
  /** Decoder: the input ends inside a chunk or before `IEND`. */
  | 'TRUNCATED'
  /** Decoder: a chunk's CRC-32 does not match its contents. */
  | 'BAD_CRC'
  /** Decoder: `IHDR` is missing, not first, or malformed (bad size, depth or colour type). */
  | 'BAD_IHDR'
  /** Decoder: the stream is Adam7-interlaced, which is not supported. */
  | 'UNSUPPORTED_INTERLACE'
  /** Decoder: valid PNG feature outside the supported subset (e.g. 16-bit samples). */
  | 'UNSUPPORTED_FORMAT'
  /** Decoder: the image would exceed the decoder's size limit. */
  | 'IMAGE_TOO_LARGE'
  /** Decoder: a palette image has a missing or malformed `PLTE`, or an index outside it. */
  | 'BAD_PALETTE'
  /** Decoder: a malformed `tRNS` chunk. */
  | 'BAD_TRNS'
  /** Decoder: there is no `IDAT` chunk. */
  | 'MISSING_IDAT'
  /** Decoder: the zlib stream is corrupt. */
  | 'DECOMPRESS_FAILED'
  /** Decoder: the inflated size does not match the size implied by `IHDR`. */
  | 'BAD_DATA_SIZE'
  /** Decoder: a scanline uses an unknown filter type (not 0..4). */
  | 'BAD_FILTER';

/** The only error type thrown by this package. Branch on {@link PngError.code}. */
export class PngError extends Error {
  /** Machine-readable reason. */
  readonly code: PngErrorCode;

  /**
   * @param code - machine-readable reason
   * @param message - human-readable detail
   */
  constructor(code: PngErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PngError';
    this.code = code;
  }
}
