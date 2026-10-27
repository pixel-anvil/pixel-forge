import { createHash } from 'node:crypto';

/**
 * Image shape used by all testkit helpers: the `PngImage` shape of `@pixel-forge/png` without `kind`.
 * `data` is RGBA8, row-major, top-left origin, straight alpha, length `width * height * 4`.
 * Any `PngImage` / `DecodedRgba` with `kind: 'rgba'` is assignable.
 */
export interface TestImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A pixel as `[r, g, b, a]`, each 0..255. */
export type Rgba = readonly [number, number, number, number];

/** Create a fully transparent image. */
export function createImage(width: number, height: number): TestImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Throw if `img` is not a valid RGBA8 image (positive integer size, matching data length). */
export function assertImage(img: TestImage): void {
  if (
    !Number.isInteger(img.width) ||
    !Number.isInteger(img.height) ||
    img.width < 1 ||
    img.height < 1
  ) {
    throw new Error(`invalid image size ${String(img.width)}x${String(img.height)}`);
  }
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(
      `image data length ${String(img.data.length)} != ${String(img.width)}*${String(img.height)}*4`,
    );
  }
}

/**
 * SHA-256 (lowercase hex) of an RGBA image. Exact byte layout hashed:
 * `width` as uint32 big-endian (4 bytes), `height` as uint32 big-endian (4 bytes), then the raw
 * RGBA8 `data` bytes (row-major, `width * height * 4` bytes). Nothing else (no PNG container bytes).
 */
export function hashRGBA(img: TestImage): string {
  assertImage(img);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  return createHash('sha256').update(header).update(img.data).digest('hex');
}
