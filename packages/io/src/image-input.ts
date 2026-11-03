import { decodePng } from '@pixel-forge/png';
import type { RgbaImage } from '@pixel-forge/raster';
import { IoError } from './errors.js';
import { isGif } from './gif.js';

/** Names the image format of `bytes` from its magic bytes, or `undefined` if not recognised. */
function sniff(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | undefined {
  if (isGif(bytes)) return 'gif';
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  // "RIFF" size "WEBP"
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  ) {
    return 'webp';
  }
  return undefined;
}

/**
 * Decodes an input image for the converter (FR-CONV-01). M1b reads **PNG only** (decision E4.0):
 * JPEG, WebP and GIF are refused by their magic bytes with a message that says what to do instead.
 * (A GIF is read by `decodeGif` and imported as an animation; the converter takes one still image.)
 * @param bytes - the file contents
 * @returns the decoded RGBA image
 * @throws IoError `UNSUPPORTED_IMAGE` for JPEG, WebP, GIF or any other non-PNG data; `BAD_INPUT` if the PNG
 *   cannot be decoded (`cause` is the PNG error)
 */
export function decodeImageFile(bytes: Uint8Array): RgbaImage {
  const kind = sniff(bytes);
  if (kind === 'gif') {
    throw new IoError(
      'UNSUPPORTED_IMAGE',
      'GIF input is not supported by the converter, which accepts PNG only: import the GIF with import_file (one frame per GIF frame), or save a frame as PNG and convert that',
    );
  }
  if (kind === 'jpeg' || kind === 'webp') {
    throw new IoError(
      'UNSUPPORTED_IMAGE',
      `${kind === 'jpeg' ? 'JPEG' : 'WebP'} input is not supported yet: convert the image to PNG first and import the PNG`,
    );
  }
  if (kind !== 'png') {
    throw new IoError(
      'UNSUPPORTED_IMAGE',
      'unrecognised image format: only PNG input is supported',
    );
  }
  try {
    return decodePng(bytes);
  } catch (cause) {
    throw new IoError('BAD_INPUT', 'the PNG cannot be decoded', { cause });
  }
}
