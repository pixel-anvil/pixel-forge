import { describe, expect, it } from 'vitest';
import { encodePng } from '@pixel-forge/png';
import { IoError, decodeImageFile } from '../src/index.js';

function ioCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof IoError) return e.code;
    throw e;
  }
  return undefined;
}

describe('decodeImageFile', () => {
  it('decodes a PNG', () => {
    const png = encodePng({
      kind: 'rgba',
      width: 1,
      height: 1,
      data: Uint8Array.of(1, 2, 3, 4),
    });
    const img = decodeImageFile(png);
    expect([img.width, img.height, ...img.data]).toEqual([1, 1, 1, 2, 3, 4]);
  });

  it('refuses JPEG by magic bytes and says to convert to PNG', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46);
    expect(ioCode(() => decodeImageFile(jpeg))).toBe('UNSUPPORTED_IMAGE');
    expect(() => decodeImageFile(jpeg)).toThrow(/JPEG.*convert the image to PNG/);
  });

  it('refuses WebP by magic bytes', () => {
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
    expect(ioCode(() => decodeImageFile(webp))).toBe('UNSUPPORTED_IMAGE');
    expect(() => decodeImageFile(webp)).toThrow(/WebP.*convert the image to PNG/);
  });

  it('refuses unknown and empty data', () => {
    expect(ioCode(() => decodeImageFile(Uint8Array.of(1, 2, 3)))).toBe('UNSUPPORTED_IMAGE');
    expect(ioCode(() => decodeImageFile(new Uint8Array(0)))).toBe('UNSUPPORTED_IMAGE');
  });

  it('wraps a truncated PNG as BAD_INPUT', () => {
    expect(ioCode(() => decodeImageFile(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)))).toBe(
      'BAD_INPUT',
    );
  });
});
