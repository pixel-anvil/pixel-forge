/**
 * Test-side GIF writer for card E6.1: a small, independent encoder (its own LZW, written from the GIF89a
 * specification, Appendix F) that can also write deliberately broken files. It shares no code with the
 * decoder under test.
 */

export type Rgb = readonly [number, number, number];

export interface FrameSpec {
  x?: number;
  y?: number;
  w: number;
  h: number;
  /** Colour index per pixel, row-major, in image row order (the writer interlaces when asked). */
  indices: ArrayLike<number>;
  /** Local colour table. */
  palette?: readonly Rgb[];
  interlace?: boolean;
  /** When set, a Graphic Control Extension is written. */
  gce?: { disposal?: number; delayCs?: number; transparent?: number };
  /** LZW minimum code size; default: the smallest that holds the palette (at least 2). */
  minCodeSize?: number;
  /** Replaces the LZW bytes (they are still cut into sub-blocks). */
  lzw?: Uint8Array;
}

export interface GifSpec {
  width: number;
  height: number;
  palette?: readonly Rgb[];
  /** NETSCAPE2.0 loop count; missing: no extension. */
  loop?: number;
  frames: readonly FrameSpec[];
  version?: '87a' | '89a';
  /** Default true. */
  trailer?: boolean;
  /** Extra bytes written before the first frame (comment, unknown extensions, ...). */
  prelude?: readonly number[];
}

/** Packs `(value, width)` pairs LSB-first into bytes: the GIF code stream layout. */
export function packBits(items: readonly (readonly [number, number])[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const [value, width] of items) {
    acc |= value << n;
    n += width;
    while (n >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      n -= 8;
    }
  }
  if (n > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

/** LZW-encodes colour indices (GIF89a Appendix F): clear code first, widths 3..12 bits, clear when full. */
export function lzwEncode(indices: ArrayLike<number>, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const items: [number, number][] = [];
  let size = minCodeSize + 1;
  let next = end + 1;
  let table = new Map<number, number>();
  items.push([clear, size]);
  if (indices.length === 0) {
    items.push([end, size]);
    return packBits(items);
  }
  let w = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i] ?? 0;
    const key = w * 256 + c;
    const hit = table.get(key);
    if (hit !== undefined) {
      w = hit;
      continue;
    }
    items.push([w, size]);
    if (next < 4096) {
      table.set(key, next);
      if (next === 1 << size && size < 12) size++;
      next++;
    } else {
      items.push([clear, size]);
      table = new Map();
      size = minCodeSize + 1;
      next = end + 1;
    }
    w = c;
  }
  items.push([w, size], [end, size]);
  return packBits(items);
}

function tableBytes(palette: readonly Rgb[]): { bytes: number[]; bits: number } {
  let bits = 0;
  while (1 << (bits + 1) < palette.length) bits++;
  const count = 1 << (bits + 1);
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) bytes.push(...(palette[i] ?? [0, 0, 0]));
  return { bytes, bits };
}

function subBlocks(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];

/** Row order of an interlaced frame: the image row stored at position `s`. */
export function interlaceOrder(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

export function buildGif(spec: GifSpec): Uint8Array {
  const out: number[] = [...Buffer.from(`GIF${spec.version ?? '89a'}`, 'latin1')];
  const g = spec.palette ? tableBytes(spec.palette) : undefined;
  out.push(...u16(spec.width), ...u16(spec.height));
  out.push((g ? 0x80 | (g.bits << 4) | g.bits : 0x70) & 255, 0, 0);
  if (g) out.push(...g.bytes);
  if (spec.loop !== undefined) {
    out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, ...u16(spec.loop), 0);
  }
  if (spec.prelude) out.push(...spec.prelude);
  for (const f of spec.frames) {
    if (f.gce) {
      const t = f.gce.transparent;
      const packed = ((f.gce.disposal ?? 0) << 2) | (t === undefined ? 0 : 1);
      out.push(0x21, 0xf9, 4, packed, ...u16(f.gce.delayCs ?? 0), t ?? 0, 0);
    }
    const l = f.palette ? tableBytes(f.palette) : undefined;
    out.push(0x2c, ...u16(f.x ?? 0), ...u16(f.y ?? 0), ...u16(f.w), ...u16(f.h));
    out.push((l ? 0x80 | l.bits : 0) | (f.interlace ? 0x40 : 0));
    if (l) out.push(...l.bytes);
    const used = f.palette?.length ?? spec.palette?.length ?? 2;
    let min = 2;
    while (1 << min < used) min++;
    const minCodeSize = f.minCodeSize ?? min;
    out.push(minCodeSize);
    let indices = f.indices;
    if (f.interlace) {
      const order = interlaceOrder(f.h);
      const stored: number[] = [];
      for (const y of order) for (let x = 0; x < f.w; x++) stored.push(indices[y * f.w + x] ?? 0);
      indices = stored;
    }
    out.push(...subBlocks(f.lzw ?? lzwEncode(indices, minCodeSize)));
  }
  if (spec.trailer !== false) out.push(0x3b);
  return Uint8Array.from(out);
}

/** A tiny walker for the assertions on fixture files: the GCE disposal and the interlace flag of every frame. */
export function scanFrames(bytes: Uint8Array): { disposal: number; interlaced: boolean }[] {
  const out: { disposal: number; interlaced: boolean }[] = [];
  let p = 6 + 4;
  const screen = bytes[p] ?? 0;
  p += 3;
  if (screen & 0x80) p += 3 * (1 << ((screen & 7) + 1));
  let disposal = 0;
  const skip = (): void => {
    for (;;) {
      const n = bytes[p++] ?? 0;
      if (n === 0) return;
      p += n;
    }
  };
  while (p < bytes.length) {
    const b = bytes[p++];
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) disposal = ((bytes[p + 1] ?? 0) >> 2) & 7;
      skip();
    } else if (b === 0x2c) {
      const packed = bytes[p + 8] ?? 0;
      p += 9;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      p++;
      skip();
      out.push({ disposal, interlaced: (packed & 0x40) !== 0 });
      disposal = 0;
    } else break;
  }
  return out;
}
