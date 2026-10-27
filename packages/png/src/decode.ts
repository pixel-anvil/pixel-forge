import { unzlibSync } from 'fflate';
import { crc32 } from './crc32.js';
import { PngError } from './errors.js';
import type { DecodedRgba, PngImage } from './types.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Upper bound on width*height, to refuse decompression bombs (about 268 megapixels). */
const MAX_PIXELS = 1 << 28;

interface Ihdr {
  width: number;
  height: number;
  depth: number;
  colorType: number;
}

/** Samples per pixel for each colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Allowed bit depths for each colour type. */
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

interface Parsed {
  ihdr: Ihdr;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  idat: Uint8Array;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );
}

function parse(bytes: Uint8Array): Parsed {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new PngError('BAD_SIGNATURE', 'not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let ihdr: Ihdr | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];
  let sawIend = false;
  let first = true;

  while (!sawIend) {
    if (pos + 8 > bytes.length) throw new PngError('TRUNCATED', 'file ends before IEND');
    const len = view.getUint32(pos);
    const type = ascii(bytes, pos + 4);
    if (len > 0x7fffffff || pos + 12 + len > bytes.length) {
      throw new PngError('TRUNCATED', `chunk ${type} extends past end of file`);
    }
    const bodyStart = pos + 8;
    const bodyEnd = bodyStart + len;
    if (crc32(bytes, pos + 4, bodyEnd) !== view.getUint32(bodyEnd)) {
      throw new PngError('BAD_CRC', `chunk ${type} fails its CRC-32 check`);
    }
    const body = bytes.subarray(bodyStart, bodyEnd);

    if (first && type !== 'IHDR') throw new PngError('BAD_IHDR', 'IHDR is not the first chunk');
    first = false;

    switch (type) {
      case 'IHDR': {
        if (ihdr) throw new PngError('BAD_IHDR', 'duplicate IHDR');
        if (len !== 13) throw new PngError('BAD_IHDR', `IHDR length ${String(len)}, expected 13`);
        const depth = body[8] ?? 0;
        const colorType = body[9] ?? 0;
        if (!(colorType in CHANNELS) || !(DEPTHS[colorType] ?? []).includes(depth)) {
          throw new PngError(
            'BAD_IHDR',
            `invalid colour type ${String(colorType)} / depth ${String(depth)}`,
          );
        }
        if (body[10] !== 0 || body[11] !== 0) {
          throw new PngError('BAD_IHDR', 'unknown compression or filter method');
        }
        const interlace = body[12] ?? 0;
        if (interlace === 1) {
          throw new PngError('UNSUPPORTED_INTERLACE', 'Adam7 interlaced PNGs are not supported');
        }
        if (interlace !== 0)
          throw new PngError('BAD_IHDR', `unknown interlace method ${String(interlace)}`);
        const width = view.getUint32(bodyStart);
        const height = view.getUint32(bodyStart + 4);
        if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) {
          throw new PngError('BAD_IHDR', `invalid size ${String(width)}x${String(height)}`);
        }
        if (width * height > MAX_PIXELS) {
          throw new PngError(
            'IMAGE_TOO_LARGE',
            `${String(width)}x${String(height)} exceeds ${String(MAX_PIXELS)} pixels`,
          );
        }
        if (depth === 16)
          throw new PngError('UNSUPPORTED_FORMAT', '16-bit samples are not supported');
        ihdr = { width, height, depth, colorType };
        break;
      }
      case 'PLTE':
        if (len === 0 || len % 3 !== 0 || len > 768) {
          throw new PngError(
            'BAD_PALETTE',
            `PLTE length ${String(len)} is not a multiple of 3 in 3..768`,
          );
        }
        plte = body;
        break;
      case 'tRNS':
        trns = body;
        break;
      case 'IDAT':
        idats.push(body);
        break;
      case 'IEND':
        sawIend = true;
        break;
      default:
        break; // ancillary / unknown chunks are ignored
    }
    pos = bodyEnd + 4;
  }

  if (!ihdr) throw new PngError('BAD_IHDR', 'missing IHDR');
  if (idats.length === 0) throw new PngError('MISSING_IDAT', 'no IDAT chunk');
  if (ihdr.colorType === 3 && !plte) throw new PngError('BAD_PALETTE', 'palette image has no PLTE');

  // Validate tRNS shape for the colour type.
  if (trns) {
    const ct = ihdr.colorType;
    if (ct === 4 || ct === 6) {
      trns = null; // forbidden for types with their own alpha; libpng ignores it
    } else if (ct === 0 && trns.length !== 2) {
      throw new PngError('BAD_TRNS', 'tRNS for greyscale must be 2 bytes');
    } else if (ct === 2 && trns.length !== 6) {
      throw new PngError('BAD_TRNS', 'tRNS for truecolour must be 6 bytes');
    } else if (ct === 3 && trns.length > (plte ? plte.length / 3 : 0)) {
      throw new PngError('BAD_TRNS', 'tRNS has more entries than the palette');
    }
  }

  let total = 0;
  for (const c of idats) total += c.length;
  const idat = new Uint8Array(total);
  let o = 0;
  for (const c of idats) {
    idat.set(c, o);
    o += c.length;
  }
  return { ihdr, plte, trns, idat };
}

/** Adler-32 checksum (zlib trailer). */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(i + 5552, bytes.length); // largest block that cannot overflow 2^32
    for (; i < end; i++) {
      a += bytes[i] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Reverses the per-scanline filters; returns tightly packed rows without filter bytes. */
function unfilter(inflated: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * (rowBytes + 1);
    const filter = inflated[src] ?? 0;
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = inflated[src + 1 + i] ?? 0;
      const a = i >= bpp ? (out[row + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prev + i] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const c = y > 0 && i >= bpp ? (out[prev + i - bpp] ?? 0) : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new PngError(
            'BAD_FILTER',
            `scanline ${String(y)} uses filter type ${String(filter)}`,
          );
      }
      out[row + i] = v & 0xff;
    }
  }
  return out;
}

/** Reads sample `x` of a packed row at bit depth 1, 2, 4 or 8. */
function sampleAt(raw: Uint8Array, rowStart: number, x: number, depth: number): number {
  if (depth === 8) return raw[rowStart + x] ?? 0;
  const perByte = 8 / depth;
  const byte = raw[rowStart + Math.floor(x / perByte)] ?? 0;
  const shift = 8 - depth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/**
 * Decodes a PNG, keeping 8-bit greyscale as `'gray8'` (needed for indexed cels).
 *
 * Returns `kind: 'gray8'` (1 byte per pixel, the stored sample values untouched) only when the
 * file is colour type 0 at bit depth 8 with no `tRNS` chunk. Every other supported input is
 * returned as `kind: 'rgba'` (straight alpha): greyscale of 1, 2 or 4 bits is scaled to 8 bits
 * (x255, x85, x17), palette images are expanded through `PLTE` and `tRNS`, and a `tRNS` colour key
 * on greyscale or truecolour images becomes alpha 0 on matching pixels.
 *
 * Supported: colour types 0, 2, 3, 4, 6; bit depth 8 for all, and 1/2/4 for types 0 and 3; all
 * five filter types; any number of `IDAT` chunks; CRC-32 of every chunk is verified. Unknown
 * chunks are ignored. Not supported: Adam7 interlace and 16-bit samples.
 *
 * @param bytes - the PNG file
 * @returns the decoded image
 * @throws {PngError} on malformed or unsupported input (see {@link PngErrorCode})
 */
export function decodePngRaw(bytes: Uint8Array): PngImage {
  const { ihdr, plte, trns, idat } = parse(bytes);
  const { width, height, depth, colorType } = ihdr;
  const channels = CHANNELS[colorType] ?? 1;
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = (rowBytes + 1) * height;

  let inflated: Uint8Array;
  try {
    inflated = unzlibSync(idat);
  } catch (e) {
    throw new PngError('DECOMPRESS_FAILED', e instanceof Error ? e.message : 'corrupt zlib stream');
  }
  // fflate does not verify the zlib trailer, so check Adler-32 here.
  const tail = idat.length >= 4 ? idat.subarray(idat.length - 4) : new Uint8Array(0);
  const stored = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  if (tail.length < 4 || stored.getUint32(0) !== adler32(inflated)) {
    throw new PngError('DECOMPRESS_FAILED', 'zlib Adler-32 mismatch or missing trailer');
  }
  if (inflated.length !== expected) {
    throw new PngError(
      'BAD_DATA_SIZE',
      `inflated ${String(inflated.length)} bytes, IHDR implies ${String(expected)}`,
    );
  }
  const raw = unfilter(inflated, rowBytes, height, bpp);

  if (colorType === 6) return { width, height, data: raw, kind: 'rgba' };
  if (colorType === 0 && depth === 8 && !trns) return { width, height, data: raw, kind: 'gray8' };

  const out = new Uint8Array(width * height * 4);
  const maxSample = (1 << depth) - 1;
  const scale = depth === 8 ? 1 : 255 / maxSample; // 255, 85 or 17: exact integers
  const tv = trns ?? new Uint8Array(0);
  const keyGray = tv.length >= 2 ? ((tv[0] ?? 0) << 8) | (tv[1] ?? 0) : -1;
  const keyR = tv.length >= 6 ? ((tv[0] ?? 0) << 8) | (tv[1] ?? 0) : -1;
  const keyG = tv.length >= 6 ? ((tv[2] ?? 0) << 8) | (tv[3] ?? 0) : -1;
  const keyB = tv.length >= 6 ? ((tv[4] ?? 0) << 8) | (tv[5] ?? 0) : -1;
  const paletteSize = plte ? plte.length / 3 : 0;

  for (let y = 0; y < height; y++) {
    const rs = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 0: {
          const s = sampleAt(raw, rs, x, depth);
          const g = s * scale;
          out[o] = g;
          out[o + 1] = g;
          out[o + 2] = g;
          out[o + 3] = s === keyGray ? 0 : 255;
          break;
        }
        case 2: {
          const i = rs + x * 3;
          const r = raw[i] ?? 0;
          const g = raw[i + 1] ?? 0;
          const b = raw[i + 2] ?? 0;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
          break;
        }
        case 3: {
          const idx = sampleAt(raw, rs, x, depth);
          if (idx >= paletteSize) {
            throw new PngError(
              'BAD_PALETTE',
              `index ${String(idx)} outside ${String(paletteSize)}-entry palette`,
            );
          }
          out[o] = plte?.[idx * 3] ?? 0;
          out[o + 1] = plte?.[idx * 3 + 1] ?? 0;
          out[o + 2] = plte?.[idx * 3 + 2] ?? 0;
          out[o + 3] = idx < tv.length ? (tv[idx] ?? 255) : 255;
          break;
        }
        default: {
          // colour type 4: grey + alpha, 8-bit
          const i = rs + x * 2;
          const g = raw[i] ?? 0;
          out[o] = g;
          out[o + 1] = g;
          out[o + 2] = g;
          out[o + 3] = raw[i + 1] ?? 0;
          break;
        }
      }
    }
  }
  return { width, height, data: out, kind: 'rgba' };
}

/**
 * Decodes a PNG to RGBA8 regardless of its source colour type (greyscale becomes R=G=B=value,
 * alpha 255). See {@link decodePngRaw} for the supported subset and error behaviour.
 *
 * @param bytes - the PNG file
 * @returns the decoded RGBA8 image
 * @throws {PngError} on malformed or unsupported input
 */
export function decodePng(bytes: Uint8Array): DecodedRgba {
  const img = decodePngRaw(bytes);
  if (img.kind === 'rgba')
    return { width: img.width, height: img.height, data: img.data, kind: 'rgba' };
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    const g = img.data[i] ?? 0;
    out[i * 4] = g;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = g;
    out[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out, kind: 'rgba' };
}
