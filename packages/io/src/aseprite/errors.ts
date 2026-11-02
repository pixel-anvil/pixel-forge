/** Machine-readable reason carried by every {@link AseError}. */
export type AseErrorCode =
  /** The file does not start with the `.aseprite` header magic (0xA5E0 at offset 4). */
  | 'BAD_MAGIC'
  /** The input ends inside the header, a frame or a chunk, or has fewer frames than the header says. */
  | 'TRUNCATED'
  /** The header is structurally invalid (zero size, colour depth other than 8/16/32, zero frames). */
  | 'BAD_HEADER'
  /** A frame header or chunk is malformed (bad size or magic, body overruns the chunk, bad reference). */
  | 'BAD_CHUNK'
  /** A compressed cel could not be inflated, or inflated to a size other than width*height*bpp. */
  | 'DECOMPRESS_FAILED'
  /** A valid feature outside the supported subset (compressed tilemap pixels, indexed pixels without a palette). */
  | 'UNSUPPORTED'
  /** The canvas, a cel or the total decoded pixel data exceeds the parser's size limits. */
  | 'TOO_LARGE';

/** The only error type thrown by this module. Branch on {@link AseError.code}. */
export class AseError extends Error {
  /** Machine-readable reason. */
  readonly code: AseErrorCode;

  /**
   * @param code - machine-readable reason
   * @param message - human-readable detail
   */
  constructor(code: AseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AseError';
    this.code = code;
  }
}
