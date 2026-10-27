/** Pixel layout of a {@link PngImage}. */
export type PngKind = 'rgba' | 'gray8';

/** An image to encode, or a decoded image whose layout is described by `kind`. */
export interface PngImage {
  /** Width in pixels (>= 1). */
  readonly width: number;
  /** Height in pixels (>= 1). */
  readonly height: number;
  /**
   * Row-major, top-left origin, tightly packed. `'rgba'`: 4 bytes per pixel (R, G, B, A,
   * straight alpha). `'gray8'`: 1 byte per pixel (a palette index for indexed cels).
   */
  readonly data: Uint8Array;
  /** Layout of `data`. */
  readonly kind: PngKind;
}

/** Result of {@link decodePng}: always RGBA8. */
export interface DecodedRgba extends PngImage {
  /** RGBA8, 4 bytes per pixel. */
  readonly data: Uint8Array;
  /** Always `'rgba'`. */
  readonly kind: 'rgba';
}
