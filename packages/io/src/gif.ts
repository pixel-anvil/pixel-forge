/**
 * GIF decoder (FR-DOC-05, card E6.1): GIF87a and GIF89a to composed full-canvas RGBA frames.
 *
 * Clean-room implementation from the published "Graphics Interchange Format, Version 89a"
 * specification (CompuServe, 1990): header and logical screen descriptor (section 17-18), global and
 * local colour tables (19, 20), image descriptor and interlacing (20, Appendix E), Graphic Control
 * Extension (23), application extension (26; `NETSCAPE2.0` loop count as documented by Netscape), and the
 * variable-code-width LZW of Appendix F. No code was copied or ported from another decoder.
 *
 * Handling that the specification leaves open (each is a choice, documented here):
 * - Frame delay: centiseconds times 10 gives ms. A delay of 0 means "as fast as possible" in the spec;
 *   browsers play it at 100 ms, so 0 becomes {@link GifOptions.zeroDelayMs} (default 100). Other
 *   values, including 1 (10 ms), are kept as written.
 * - Disposal: 0 and 1 keep the frame, 2 clears the frame rectangle to transparent (the background colour
 *   index is ignored, as in browsers), 3 restores the canvas as it was before the frame was drawn.
 *   The reserved values 4 to 7 are treated as 0.
 * - A pixel index that is outside the colour table draws nothing (as a transparent pixel).
 * - A frame rectangle larger than the logical screen is refused; one that only starts too far right or
 *   down is clipped to the screen.
 * - A file with no `NETSCAPE2.0` extension plays once ({@link DecodedGif.loopCount} is `undefined`).
 * - The trailer byte (0x3B) is required: a file that ends earlier is treated as truncated.
 *
 * Hostile input (NFR-06): every size comes from the file, so none is trusted. Canvas size, frame count and
 * total composed pixels are capped ({@link GifLimits}); the LZW output of a frame is capped by its
 * rectangle (at most the canvas), and a longer stream is ignored past that point; the code table has 4096
 * entries and cannot grow; each loop step consumes input or emits at least one pixel, so the time is
 * linear in the input plus the capped output. All failures are {@link IoError}s: `BAD_GIF` (malformed or
 * truncated), `TOO_LARGE` (over a limit).
 * @packageDocumentation
 */
import type { RgbaImage } from '@pixel-forge/raster';
import { IoError } from './errors.js';

/** Caps on what a GIF may ask the decoder to allocate. All are checked before the memory is used. */
export interface GifLimits {
  /** Largest logical screen, in pixels (`width * height`). Default 4,194,304 (2048 x 2048). */
  maxCanvasPixels: number;
  /** Most frames. Default 1000. */
  maxFrames: number;
  /** Most composed pixels over all frames (`frames * width * height`); 4 bytes each. Default 33,554,432. */
  maxTotalPixels: number;
}

/** The default {@link GifLimits}. */
export const DEFAULT_GIF_LIMITS: Readonly<GifLimits> = {
  maxCanvasPixels: 1 << 22,
  maxFrames: 1000,
  maxTotalPixels: 1 << 25,
};

/** Options of {@link decodeGif}. */
export interface GifOptions {
  /** Limits; missing fields keep their default. */
  limits?: Partial<GifLimits>;
  /** Duration in ms of a frame whose delay is 0. Integer >= 1. Default 100. */
  zeroDelayMs?: number;
}

/** One decoded frame. */
export interface GifFrame {
  /** The whole canvas after this frame was drawn (before its disposal), straight RGBA. */
  readonly image: RgbaImage;
  /** Display time in ms (delay in centiseconds times 10; see the module notes for 0). */
  readonly durationMs: number;
  /** Disposal method 0..3 (4..7 are reported as 0). */
  readonly disposal: 0 | 1 | 2 | 3;
  /** The rectangle this frame drew, clipped to the canvas. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** Result of {@link decodeGif}. */
export interface DecodedGif {
  /** Logical screen width. */
  readonly width: number;
  /** Logical screen height. */
  readonly height: number;
  /** At least one frame, all `width x height`. */
  readonly frames: readonly GifFrame[];
  /**
   * The `NETSCAPE2.0` loop count: 0 means forever, `n` means n repeats. `undefined`: the file has no
   * such extension and plays once.
   */
  readonly loopCount: number | undefined;
  /** Frames whose delay was 0 and got {@link GifOptions.zeroDelayMs}. */
  readonly zeroDelayFrames: number;
}

/** True if `bytes` start with the `GIF87a` or `GIF89a` signature. */
export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

const bad = (message: string): IoError =>
  new IoError('BAD_GIF', `the GIF is malformed: ${message}`);
const tooLarge = (message: string): IoError =>
  new IoError('TOO_LARGE', `the GIF is too large: ${message}`);

/** Interlace passes of Appendix E: first row and row step. */
const PASSES: readonly (readonly [number, number])[] = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
];

/** Row of the image that the `i`-th stored row of an interlaced frame of height `h` belongs to. */
function interlacedRows(h: number): Int32Array {
  const rows = new Int32Array(h);
  let i = 0;
  for (const [start, step] of PASSES) {
    for (let y = start; y < h; y += step) rows[i++] = y;
  }
  return rows;
}

/** Cursor over the file with bounds-checked reads: reading past the end is a truncation error. */
class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  need(n: number, what: string): void {
    if (this.pos + n > this.bytes.length) throw bad(`truncated in ${what}`);
  }

  u8(what: string): number {
    this.need(1, what);
    return this.bytes[this.pos++] ?? 0;
  }

  u16(what: string): number {
    this.need(2, what);
    const v = (this.bytes[this.pos] ?? 0) | ((this.bytes[this.pos + 1] ?? 0) << 8);
    this.pos += 2;
    return v;
  }

  take(n: number, what: string): Uint8Array {
    this.need(n, what);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * Reads a chain of data sub-blocks (length byte, data, ... , 0) and returns the blocks. Bounded by the
   * file: every block consumes at least one byte.
   */
  subBlocks(what: string): Uint8Array[] {
    const blocks: Uint8Array[] = [];
    for (;;) {
      const n = this.u8(what);
      if (n === 0) return blocks;
      blocks.push(this.take(n, what));
    }
  }
}

function concat(blocks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function readTable(r: Reader, sizeBits: number, what: string): Uint8Array {
  return r.take(3 * (1 << (sizeBits + 1)), what);
}

/**
 * LZW decoder of Appendix F: codes start `minCodeSize + 1` bits wide, LSB first, and widen up to 12 bits as
 * the table fills; a clear code resets the table. Fills `out` (exactly the frame's pixel count) and stops
 * as soon as it is full, so extra data is ignored and `out.length` is the hard cap on the output. When the
 * table is full (4096 entries) no entry is added and decoding goes on with the codes it has.
 * @throws IoError `BAD_GIF` for a code that is not in the table, a bad first code, or a stream that ends
 *   (end code or end of data) before `out` is full.
 */
function lzwDecode(data: Uint8Array, minCodeSize: number, out: Uint8Array): void {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  const total = out.length;
  let size = minCodeSize + 1;
  let next = end + 1;
  let prev = -1;
  let pos = 0;
  let bits = 0;
  let nbits = 0;
  let at = 0;
  while (pos < total) {
    while (nbits < size) {
      if (at >= data.length) throw bad('truncated image data (ran out before the frame was full)');
      bits |= (data[at++] ?? 0) << nbits;
      nbits += 8;
    }
    const code = bits & ((1 << size) - 1);
    bits >>>= size;
    nbits -= size;
    if (code === clear) {
      size = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) throw bad('image data ended (end code) before the frame was full');
    if (prev === -1) {
      if (code > clear) throw bad(`first code ${String(code)} is not a colour index`);
    } else {
      if (code > next)
        throw bad(`code ${String(code)} is not in the code table (size ${String(next)})`);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = code === next ? (first[prev] ?? 0) : (first[code] ?? 0);
        first[next] = first[prev] ?? 0;
        length[next] = (length[prev] ?? 0) + 1;
        next++;
        if (next === 1 << size && size < 12) size++;
      }
    }
    // Emit the string of `code` back to front; positions at or past `total` are dropped.
    const len = length[code] ?? 0;
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      if (pos + i < total) out[pos + i] = suffix[c] ?? 0;
      c = prefix[c] ?? 0;
    }
    pos += len;
    prev = code;
  }
}

interface Gce {
  disposal: 0 | 1 | 2 | 3;
  delayCs: number;
  transparent: number; // -1 when none
}

/**
 * Decodes a GIF87a or GIF89a file into composed frames.
 * @param bytes - the file contents
 * @param options - limits and the zero-delay duration
 * @returns the canvas size, the composed frames and the loop count
 * @throws IoError `BAD_GIF` for a file that is not a GIF, is truncated or has bad blocks, a bad code, a
 *   missing colour table or no frames; `TOO_LARGE` when a limit of {@link GifLimits} is exceeded
 */
export function decodeGif(bytes: Uint8Array, options: GifOptions = {}): DecodedGif {
  const limits = { ...DEFAULT_GIF_LIMITS, ...options.limits };
  const zeroMs = options.zeroDelayMs ?? 100;
  if (!Number.isInteger(zeroMs) || zeroMs < 1) {
    throw new IoError('BAD_INPUT', `zeroDelayMs must be an integer >= 1, got ${String(zeroMs)}`);
  }
  if (!isGif(bytes)) throw bad('missing GIF87a/GIF89a signature');
  const r = new Reader(bytes);
  r.pos = 6;

  // Logical screen descriptor (section 18).
  const width = r.u16('logical screen descriptor');
  const height = r.u16('logical screen descriptor');
  const screenPacked = r.u8('logical screen descriptor');
  r.u8('logical screen descriptor'); // background colour index: ignored
  r.u8('logical screen descriptor'); // pixel aspect ratio: ignored
  if (width === 0 || height === 0) throw bad('the logical screen has a zero side');
  if (width * height > limits.maxCanvasPixels) {
    throw tooLarge(
      `${String(width)}x${String(height)} is over ${String(limits.maxCanvasPixels)} pixels`,
    );
  }
  const globalTable =
    (screenPacked & 0x80) !== 0 ? readTable(r, screenPacked & 7, 'global colour table') : undefined;

  const frames: GifFrame[] = [];
  let loopCount: number | undefined;
  let zeroDelayFrames = 0;
  let gce: Gce | undefined;
  const canvas = new Uint8Array(width * height * 4);

  for (;;) {
    const introducer = r.u8('block');
    if (introducer === 0x3b) break; // trailer
    if (introducer === 0x21) {
      const label = r.u8('extension');
      if (label === 0xf9) {
        const blocks = r.subBlocks('graphic control extension');
        const b = blocks[0];
        if (b?.length !== 4) throw bad('graphic control extension is not 4 bytes');
        const packed = b[0] ?? 0;
        const d = (packed >> 2) & 7;
        gce = {
          disposal: d === 2 || d === 3 ? d : 0,
          delayCs: (b[1] ?? 0) | ((b[2] ?? 0) << 8),
          transparent: (packed & 1) !== 0 ? (b[3] ?? 0) : -1,
        };
      } else if (label === 0xff) {
        const blocks = r.subBlocks('application extension');
        const id = blocks[0];
        const sub = blocks[1];
        const netscape = id?.length === 11 && String.fromCharCode(...id) === 'NETSCAPE2.0';
        if (netscape && sub !== undefined && sub.length >= 3 && sub[0] === 1) {
          loopCount = (sub[1] ?? 0) | ((sub[2] ?? 0) << 8);
        }
      } else {
        r.subBlocks('extension'); // comment, plain text, anything else: skipped
      }
      continue;
    }
    if (introducer !== 0x2c) {
      throw bad(`unknown block 0x${introducer.toString(16)} at byte ${String(r.pos - 1)}`);
    }

    // Image descriptor (section 20).
    if (frames.length >= limits.maxFrames) {
      throw tooLarge(`more than ${String(limits.maxFrames)} frames`);
    }
    if ((frames.length + 1) * width * height > limits.maxTotalPixels) {
      throw tooLarge(`more than ${String(limits.maxTotalPixels)} decoded pixels in total`);
    }
    const left = r.u16('image descriptor');
    const top = r.u16('image descriptor');
    const fw = r.u16('image descriptor');
    const fh = r.u16('image descriptor');
    const packed = r.u8('image descriptor');
    if (fw === 0 || fh === 0) throw bad('a frame has a zero side');
    if (fw > width || fh > height) {
      throw bad(
        `a ${String(fw)}x${String(fh)} frame is larger than the ${String(width)}x${String(height)} screen`,
      );
    }
    const interlaced = (packed & 0x40) !== 0;
    const table =
      (packed & 0x80) !== 0 ? readTable(r, packed & 7, 'local colour table') : globalTable;
    if (table === undefined) throw bad('a frame has no colour table (no global and no local one)');
    const minCodeSize = r.u8('LZW code size');
    if (minCodeSize < 2 || minCodeSize > 8) {
      throw bad(`LZW minimum code size ${String(minCodeSize)} is not 2..8`);
    }
    const data = concat(r.subBlocks('image data'));
    const indices = new Uint8Array(fw * fh);
    lzwDecode(data, minCodeSize, indices);

    const g = gce;
    gce = undefined;
    const disposal = g?.disposal ?? 0;
    const transparent = g?.transparent ?? -1;
    const colours = table.length / 3;

    // Region of the canvas this frame covers, clipped to the screen.
    const x1 = Math.min(left + fw, width);
    const y1 = Math.min(top + fh, height);
    const rx = Math.min(left, width);
    const ry = Math.min(top, height);
    const rw = x1 - rx;
    const rh = y1 - ry;
    let saved: Uint8Array | undefined;
    if (disposal === 3 && rw > 0 && rh > 0) {
      saved = new Uint8Array(rw * rh * 4);
      for (let y = 0; y < rh; y++) {
        const from = ((ry + y) * width + rx) * 4;
        saved.set(canvas.subarray(from, from + rw * 4), y * rw * 4);
      }
    }

    const rows = interlaced ? interlacedRows(fh) : undefined;
    for (let sy = 0; sy < fh; sy++) {
      const y = top + (rows === undefined ? sy : (rows[sy] ?? 0));
      if (y >= height) continue;
      for (let sx = 0; sx < fw; sx++) {
        const x = left + sx;
        if (x >= width) break;
        const index = indices[sy * fw + sx] ?? 0;
        if (index === transparent || index >= colours) continue;
        const o = (y * width + x) * 4;
        canvas[o] = table[index * 3] ?? 0;
        canvas[o + 1] = table[index * 3 + 1] ?? 0;
        canvas[o + 2] = table[index * 3 + 2] ?? 0;
        canvas[o + 3] = 255;
      }
    }

    const delayCs = g?.delayCs ?? 0;
    if (delayCs === 0) zeroDelayFrames++;
    frames.push({
      image: { width, height, data: canvas.slice() },
      durationMs: delayCs === 0 ? zeroMs : delayCs * 10,
      disposal,
      rect: { x: rx, y: ry, w: rw, h: rh },
    });

    if (disposal === 2) {
      for (let y = 0; y < rh; y++) {
        const from = ((ry + y) * width + rx) * 4;
        canvas.fill(0, from, from + rw * 4);
      }
    } else if (saved !== undefined) {
      for (let y = 0; y < rh; y++) {
        const from = ((ry + y) * width + rx) * 4;
        canvas.set(saved.subarray(y * rw * 4, (y + 1) * rw * 4), from);
      }
    }
  }

  if (frames.length === 0) throw bad('the file has no frames');
  return { width, height, frames, loopCount, zeroDelayFrames };
}
