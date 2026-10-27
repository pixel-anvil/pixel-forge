import { zlibSync } from 'fflate';
import { crc32 } from './crc32.js';
import { PngError } from './errors.js';
import type { PngImage } from './types.js';

/** Fixed zlib compression level used for the single `IDAT` stream (fflate level 9). */
export const DEFLATE_LEVEL = 9;
/** Fixed fflate memory level (8 = largest hash table). Pinned so output never depends on input size. */
export const DEFLATE_MEM = 8;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MAX_DIM = 0x7fffffff;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Filters `raw` scanline by scanline. Per row, the filter type (0..4) with the smallest sum of
 * absolute signed residuals is chosen (the classic libpng heuristic); ties go to the lowest type.
 * The choice depends only on the pixel data, so it is deterministic.
 */
function filterRows(raw: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  const zero = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const cur = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const up = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : zero;
    for (let i = 0; i < rowBytes; i++) {
      const x = cur[i] ?? 0;
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const b = up[i] ?? 0;
      const c = i >= bpp ? (up[i - bpp] ?? 0) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      (cand[0] as Uint8Array)[i] = x;
      (cand[1] as Uint8Array)[i] = (x - a) & 0xff;
      (cand[2] as Uint8Array)[i] = (x - b) & 0xff;
      (cand[3] as Uint8Array)[i] = (x - ((a + b) >> 1)) & 0xff;
      (cand[4] as Uint8Array)[i] = (x - paeth) & 0xff;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const row = cand[f] as Uint8Array;
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const v = row[i] ?? 0;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const o = y * (rowBytes + 1);
    out[o] = best;
    out.set(cand[best] as Uint8Array, o + 1);
  }
  return out;
}

/**
 * Encodes an image as a PNG, byte-for-byte deterministically.
 *
 * Output layout: signature, `IHDR` (8-bit, colour type 6 for `'rgba'` or 0 for `'gray8'`,
 * deflate/filter method 0, no interlace), exactly one `IDAT`, `IEND`. No ancillary chunks are
 * written (no `tIME`, `gAMA`, `pHYs`, `tEXt`, ...).
 *
 * Determinism rules (NFR-03): the zlib stream comes from fflate's `zlibSync` at the fixed level
 * {@link DEFLATE_LEVEL} (9) and memory level {@link DEFLATE_MEM} (8), never Node zlib; the filter
 * is chosen per scanline by the minimum-sum-of-absolute-residuals heuristic (ties to the lowest
 * filter type). Identical input therefore yields identical bytes for a given fflate version.
 *
 * @param img - the image; `data` must hold exactly `width * height * (kind === 'rgba' ? 4 : 1)` bytes
 * @returns the PNG file bytes
 * @throws {PngError} `INVALID_DIMENSIONS`, `INVALID_KIND` or `INVALID_DATA_LENGTH`
 */
export function encodePng(img: PngImage): Uint8Array {
  const { width, height, data, kind } = img;
  if ((kind as string) !== 'rgba' && (kind as string) !== 'gray8') {
    throw new PngError('INVALID_KIND', `unknown kind ${kind as string}`);
  }
  for (const [name, v] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > MAX_DIM) {
      throw new PngError(
        'INVALID_DIMENSIONS',
        `${name} must be an integer in 1..${String(MAX_DIM)}, got ${String(v)}`,
      );
    }
  }
  const channels = kind === 'rgba' ? 4 : 1;
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new PngError(
      'INVALID_DATA_LENGTH',
      `expected ${String(expected)} bytes for ${String(width)}x${String(height)} ${kind}, got ${String(data.length)}`,
    );
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = kind === 'rgba' ? 6 : 0; // colour type
  // bytes 10..12: compression 0, filter method 0, interlace 0

  const filtered = filterRows(data, width * channels, height, channels);
  const idat = zlibSync(filtered, { level: DEFLATE_LEVEL, mem: DEFLATE_MEM });

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
