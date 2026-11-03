/**
 * GIF encoder (FR-DOC-06, card E6.2): RGBA frames to an animated GIF89a. Pure bytes out.
 *
 * Clean-room implementation from the published "Graphics Interchange Format, Version 89a"
 * specification (CompuServe, 1990): header and logical screen descriptor (sections 17-18), global colour
 * table (19), image descriptor (20), Graphic Control Extension (23), application extension (26;
 * the `NETSCAPE2.0` loop block as documented by Netscape), trailer (27) and the variable-code-width LZW of
 * Appendix F. No code was copied or ported from another encoder.
 *
 * Choices the specification leaves open:
 * - One global colour table for the whole animation, in order of first appearance (row-major, frame by
 *   frame), so the output is deterministic. If any pixel is transparent, index 0 is the transparent index
 *   (colour 0,0,0) and the real colours start at index 1.
 * - A pixel must be fully opaque (alpha 255) or fully transparent (alpha 0): GIF has no partial alpha, and
 *   guessing a threshold would change the art silently. Anything else is refused (`BAD_INPUT`).
 * - At most 256 table entries, the transparent index included; more is refused (`PALETTE_TOO_LARGE`).
 *   There is no quantiser here: reduce the colours first (`convert`, `palette_remap`).
 * - Every frame is the whole canvas. Disposal is 2 (restore to background) when the animation has
 *   transparency, so a transparent pixel never shows the frame before it; otherwise 1.
 * - Delay: milliseconds divided by 10, rounded, at least 1 centisecond (a delay of 0 plays at an
 *   implementation-defined speed). Longest delay 655,350 ms.
 * - Loop: `once` writes no `NETSCAPE2.0` block (a viewer plays the file once); `loop` writes the block
 *   with count 0 (forever).
 * - LZW: the table is cleared when it is full (4096 codes); no deferred clear.
 * @packageDocumentation
 */
import { MAX_PALETTE_COLORS } from '@pixel-forge/schema';
import { IoError } from './errors.js';

/** One frame to encode: straight RGBA, all frames the same size. */
export interface GifEncodeFrame {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, straight (non-premultiplied) RGBA. */
  readonly data: Uint8Array;
  /** Display time in ms, a positive integer. */
  readonly durationMs: number;
}

/** Options of {@link encodeGif}. */
export interface GifEncodeOptions {
  /** `loop`: play forever (`NETSCAPE2.0` count 0); `once`: no loop block. Default `loop`. */
  loop?: 'loop' | 'once';
}

/** Result of {@link encodeGif}. */
export interface EncodedGif {
  readonly bytes: Uint8Array;
  /** Colours used, not counting the transparent index. */
  readonly colors: number;
  /** True if the file has a transparent index (index 0). */
  readonly transparent: boolean;
}

/** Largest width or height of a GIF (16-bit fields). */
const MAX_GIF_SIDE = 65535;
const MAX_LZW_CODES = 4096;

/** Collects the opaque colours (first-appearance order) and notes transparency. */
function collectColors(frames: readonly GifEncodeFrame[]): {
  colors: Map<number, number>;
  transparent: boolean;
} {
  const colors = new Map<number, number>();
  let transparent = false;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] ?? 0;
      if (a === 0) {
        transparent = true;
      } else if (a === 255) {
        const key = ((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0);
        if (!colors.has(key)) colors.set(key, colors.size);
      } else {
        const px = i / 4;
        throw new IoError(
          'BAD_INPUT',
          `GIF has no partial transparency: pixel ${String(px % f.width)},${String(Math.floor(px / f.width))} has alpha ${String(a)} (use 0 or 255)`,
        );
      }
    }
  }
  return { colors, transparent };
}

/** LZW (Appendix F) of colour indices: bits packed LSB first, clear code first, end code last. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  let width = minCodeSize + 1;
  const put = (code: number): void => {
    acc |= code << accBits;
    accBits += width;
    while (accBits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let free = eoi + 1;
  // The decoder is one table entry behind the encoder, so the width grows when `free` (counted before
  // the entry for the code just written is added) passes the largest code the current width holds.
  const widen = (): void => {
    if (free > (1 << width) - 1 && width < 12) width += 1;
  };
  put(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i] ?? 0;
    const key = (prefix << 8) | byte;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix);
    widen();
    if (free < MAX_LZW_CODES) {
      dict.set(key, free);
      free += 1;
    } else {
      put(clear);
      dict = new Map();
      free = eoi + 1;
      width = minCodeSize + 1;
    }
    prefix = byte;
  }
  put(prefix);
  widen();
  put(eoi);
  if (accBits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

/**
 * Encodes frames as an animated GIF89a (see the module notes for every choice). Deterministic: the same
 * frames give the same bytes.
 * @throws IoError `BAD_INPUT` (no frames, sizes differ, size over 65535, duration not a positive
 *   integer, partial alpha), `PALETTE_TOO_LARGE` (over 256 table entries)
 */
export function encodeGif(
  frames: readonly GifEncodeFrame[],
  options: GifEncodeOptions = {},
): EncodedGif {
  const first = frames[0];
  if (first === undefined) throw new IoError('BAD_INPUT', 'a GIF needs at least one frame');
  const { width, height } = first;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_GIF_SIDE ||
    height > MAX_GIF_SIDE
  ) {
    throw new IoError(
      'BAD_INPUT',
      `a GIF is 1..${String(MAX_GIF_SIDE)} px per side, got ${String(width)}x${String(height)}`,
    );
  }
  for (const [n, f] of frames.entries()) {
    if (f.width !== width || f.height !== height || f.data.length !== width * height * 4) {
      throw new IoError(
        'BAD_INPUT',
        `frame ${String(n)} does not match the ${String(width)}x${String(height)} canvas`,
      );
    }
    if (!Number.isInteger(f.durationMs) || f.durationMs < 1) {
      throw new IoError('BAD_INPUT', `frame ${String(n)} duration must be a positive integer (ms)`);
    }
  }

  const { colors, transparent } = collectColors(frames);
  const entries = colors.size + (transparent ? 1 : 0);
  if (entries > MAX_PALETTE_COLORS) {
    throw new IoError(
      'PALETTE_TOO_LARGE',
      `a GIF holds ${String(MAX_PALETTE_COLORS)} colours including the transparent one; this animation uses ${String(colors.size)} colours${transparent ? ' plus transparency' : ''}. Reduce the palette first (convert or palette_remap)`,
    );
  }
  let bits = 1;
  while (1 << bits < entries) bits += 1;
  const tableSize = 1 << bits;
  const minCodeSize = Math.max(2, bits);
  const offset = transparent ? 1 : 0;

  const out: number[] = [];
  const u16 = (v: number): void => {
    out.push(v & 255, (v >> 8) & 255);
  };
  const ascii = (s: string): void => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };

  ascii('GIF89a');
  u16(width);
  u16(height);
  out.push(0x80 | (7 << 4) | (bits - 1), 0, 0); // global table, 8-bit colour resolution, unsorted; bg 0; aspect 0
  const table = new Uint8Array(tableSize * 3);
  for (const [key, idx] of colors) {
    const o = (idx + offset) * 3;
    table[o] = (key >> 16) & 255;
    table[o + 1] = (key >> 8) & 255;
    table[o + 2] = key & 255;
  }
  for (const b of table) out.push(b);
  if ((options.loop ?? 'loop') === 'loop') {
    out.push(0x21, 0xff, 11);
    ascii('NETSCAPE2.0');
    out.push(3, 1, 0, 0, 0); // sub-block: id 1, loop count 0 = forever
  }

  const disposal = transparent ? 2 : 1;
  const indices = new Uint8Array(width * height);
  for (const f of frames) {
    const d = f.data;
    for (let p = 0; p < indices.length; p++) {
      const i = p * 4;
      indices[p] =
        (d[i + 3] ?? 0) === 0
          ? 0
          : (colors.get(((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0)) ?? 0) +
            offset;
    }
    // Graphic Control Extension.
    out.push(0x21, 0xf9, 4, (disposal << 2) | (transparent ? 1 : 0));
    u16(Math.min(65535, Math.max(1, Math.round(f.durationMs / 10))));
    out.push(0, 0);
    // Image descriptor: whole canvas, no local table, not interlaced.
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    out.push(0, minCodeSize);
    const lzw = lzwEncode(indices, minCodeSize);
    for (let at = 0; at < lzw.length; at += 255) {
      const chunk = lzw.subarray(at, at + 255);
      out.push(chunk.length);
      for (const b of chunk) out.push(b);
    }
    out.push(0);
  }
  out.push(0x3b);
  return { bytes: Uint8Array.from(out), colors: colors.size, transparent };
}
