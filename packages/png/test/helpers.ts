// Test-only helpers. node:* imports are allowed here (never in src/).
import { createHash } from 'node:crypto';
import { crc32 } from '../src/crc32.js';

/** Hex SHA-256 of `bytes`. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Small deterministic PRNG (mulberry32) so tests never touch Math.random. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mix of smooth gradient, flat runs and noise, so several filter types get chosen. */
export function makePixels(width: number, height: number, channels: 1 | 4, seed = 1): Uint8Array {
  const rnd = prng(seed);
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const i = (y * width + x) * channels + c;
        const band = y % 4;
        if (band === 0) out[i] = (x * 4 + c * 40) & 255;
        else if (band === 1) out[i] = (y * 3) & 255;
        else if (band === 2) out[i] = Math.floor(rnd() * 256);
        else out[i] = c === 3 ? 255 : (x + y + c) & 255;
      }
    }
  }
  return out;
}

export interface RawChunk {
  type: string;
  data: Uint8Array;
}

/** Splits a well-formed PNG into chunks (no validation). */
export function readChunks(png: Uint8Array): RawChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: RawChunk[] = [];
  let pos = 8;
  while (pos < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    out.push({ type, data: png.slice(pos + 8, pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

/** Assembles a PNG from chunks, computing correct CRCs. */
export function writeChunks(chunks: RawChunk[]): Uint8Array {
  const total = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(out.buffer);
  let pos = 8;
  for (const c of chunks) {
    view.setUint32(pos, c.data.length);
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = c.type.charCodeAt(i);
    out.set(c.data, pos + 8);
    view.setUint32(pos + 8 + c.data.length, crc32(out, pos + 4, pos + 8 + c.data.length));
    pos += 12 + c.data.length;
  }
  return out;
}

/** Rewrites one chunk of `png` (CRCs are recomputed so only the intended defect remains). */
export function mutate(
  png: Uint8Array,
  type: string,
  fn: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  return writeChunks(
    readChunks(png).map((c) => (c.type === type ? { type, data: fn(c.data) } : c)),
  );
}
