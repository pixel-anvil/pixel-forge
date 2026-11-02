/**
 * The output shape of image-returning ops (`render.frame`, `render.contactSheet`; FR-AI-12).
 *
 * Op outputs are plain JSON (zod to JSON Schema), so the PNG travels as base64 text in a top-level
 * `image` field: `{mimeType: 'image/png', data, width, height}`. A transport that has image content
 * (the MCP server, T5.5) sends `{type: 'image', data: image.data, mimeType: image.mimeType}` and drops
 * `data` from the JSON part; the CLI writes the decoded bytes to a file.
 * @packageDocumentation
 */
import { encodePng } from '@pixel-forge/png';
import { z } from 'zod';

/** Longest side of an image an op returns, in pixels (vision-model budget, FR-AI-12). */
export const MAX_IMAGE_EDGE = 1568;

/** The `image` field of an image-returning op's output. */
export const ImageOutput = z.strictObject({
  mimeType: z.literal('image/png').describe('Always "image/png".'),
  data: z.string().describe('The PNG file, base64 (standard alphabet, padded).'),
  width: z.int().describe('Image width, px (at most 1568).'),
  height: z.int().describe('Image height, px (at most 1568).'),
});
/** The `image` field of an image-returning op's output. */
export type ImageOutput = z.output<typeof ImageOutput>;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard padded base64 of `bytes` (no `btoa`/`Buffer`: ops uses no platform globals). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    parts.push(
      (B64[(n >> 18) & 63] ?? '') +
        (B64[(n >> 12) & 63] ?? '') +
        (left > 1 ? (B64[(n >> 6) & 63] ?? '') : '=') +
        (left > 2 ? (B64[n & 63] ?? '') : '='),
    );
  }
  return parts.join('');
}

/** An RGBA8 buffer, row-major, straight alpha. */
export interface RgbaBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Encodes `img` as the `image` field of an op output. */
export function pngOutput(img: RgbaBuffer): ImageOutput {
  const png = encodePng({ width: img.width, height: img.height, data: img.data, kind: 'rgba' });
  return {
    mimeType: 'image/png',
    data: bytesToBase64(png),
    width: img.width,
    height: img.height,
  };
}
