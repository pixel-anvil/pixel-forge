import { zlibSync } from 'fflate';

/** Tiny `.aseprite` writer used to build synthetic edge-case files for the parser tests. */
export class W {
  readonly b: number[] = [];
  u8(v: number): this {
    this.b.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(Math.floor(v / 65536));
  }
  i16(v: number): this {
    return this.u16(v & 0xffff);
  }
  i32(v: number): this {
    return this.u32(v >>> 0);
  }
  fixed(v: number): this {
    return this.i32(Math.round(v * 65536));
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.b.push(0);
    return this;
  }
  bytes(v: ArrayLike<number>): this {
    for (const x of Array.from(v)) this.b.push(x);
    return this;
  }
  str(s: string): this {
    const enc = Array.from(Buffer.from(s, 'utf8'));
    return this.u16(enc.length).bytes(enc);
  }
}

/** A chunk: size (incl. header), type, body. */
export function chunk(type: number, body: W | number[]): number[] {
  const bytes = body instanceof W ? body.b : body;
  return new W()
    .u32(bytes.length + 6)
    .u16(type)
    .bytes(bytes).b;
}

export interface FrameOpts {
  duration?: number;
  /** Write only the old chunk count field (new = 0). */
  oldCountOnly?: boolean;
  /** Override the declared chunk count. */
  count?: number;
  magic?: number;
}

export function frame(chunks: number[][], o: FrameOpts = {}): number[] {
  const body = chunks.flat();
  const count = o.count ?? chunks.length;
  return new W()
    .u32(16 + body.length)
    .u16(o.magic ?? 0xf1fa)
    .u16(o.oldCountOnly === true ? count : Math.min(count, 0xffff))
    .u16(o.duration ?? 100)
    .zeros(2)
    .u32(o.oldCountOnly === true ? 0 : count)
    .bytes(body).b;
}

export interface FileOpts {
  width?: number;
  height?: number;
  depth?: number;
  flags?: number;
  speed?: number;
  transparent?: number;
  ncolors?: number;
  frameCount?: number;
  magic?: number;
  pixelW?: number;
  pixelH?: number;
}

export function file(frames: number[][], o: FileOpts = {}): Uint8Array {
  const body = frames.flat();
  const head = new W()
    .u32(128 + body.length)
    .u16(o.magic ?? 0xa5e0)
    .u16(o.frameCount ?? frames.length)
    .u16(o.width ?? 4)
    .u16(o.height ?? 4)
    .u16(o.depth ?? 32)
    .u32(o.flags ?? 1)
    .u16(o.speed ?? 100)
    .zeros(8)
    .u8(o.transparent ?? 0)
    .zeros(3)
    .u16(o.ncolors ?? 0)
    .u8(o.pixelW ?? 0)
    .u8(o.pixelH ?? 0)
    .i16(-3)
    .i16(5)
    .u16(8)
    .u16(8);
  head.zeros(128 - head.b.length);
  return new Uint8Array([...head.b, ...body]);
}

export interface LayerOpts {
  flags?: number;
  type?: number;
  level?: number;
  blend?: number;
  opacity?: number;
  tileset?: number;
  uuid?: boolean;
}

export function layer(name: string, o: LayerOpts = {}): number[] {
  const w = new W()
    .u16(o.flags ?? 3)
    .u16(o.type ?? 0)
    .u16(o.level ?? 0)
    .zeros(4)
    .u16(o.blend ?? 0)
    .u8(o.opacity ?? 255)
    .zeros(3)
    .str(name);
  if (o.type === 2) w.u32(o.tileset ?? 0);
  if (o.uuid === true) w.bytes(Array.from({ length: 16 }, (_, i) => i + 1));
  return chunk(0x2004, w);
}

export interface CelOpts {
  layer?: number;
  x?: number;
  y?: number;
  opacity?: number;
  z?: number;
}

function celHead(type: number, o: CelOpts): W {
  return new W()
    .u16(o.layer ?? 0)
    .i16(o.x ?? 0)
    .i16(o.y ?? 0)
    .u8(o.opacity ?? 255)
    .u16(type)
    .i16(o.z ?? 0)
    .zeros(5);
}

export function rawCel(w: number, h: number, pixels: ArrayLike<number>, o: CelOpts = {}): number[] {
  return chunk(0x2005, celHead(0, o).u16(w).u16(h).bytes(pixels));
}

export function zCel(w: number, h: number, pixels: ArrayLike<number>, o: CelOpts = {}): number[] {
  const z = zlibSync(
    Uint8Array.from(Array.from({ length: pixels.length }, (_, i) => pixels[i] ?? 0)),
  );
  return chunk(0x2005, celHead(2, o).u16(w).u16(h).bytes(z));
}

export function linkCel(frameIndex: number, o: CelOpts = {}): number[] {
  return chunk(0x2005, celHead(1, o).u16(frameIndex));
}

export function tilemapCel(o: CelOpts = {}): number[] {
  return chunk(
    0x2005,
    celHead(3, o)
      .u16(2)
      .u16(3)
      .u16(32)
      .u32(0x1fffffff)
      .u32(0x20000000)
      .u32(0x40000000)
      .u32(0x80000000)
      .zeros(10)
      .bytes(Array.from(zlibSync(new Uint8Array(24)))),
  );
}

export interface PaletteEntrySpec {
  rgba: [number, number, number, number];
  name?: string;
}

export function newPalette(size: number, first: number, entries: PaletteEntrySpec[]): number[] {
  const w = new W()
    .u32(size)
    .u32(first)
    .u32(first + entries.length - 1)
    .zeros(8);
  for (const e of entries) {
    w.u16(e.name === undefined ? 0 : 1).bytes(e.rgba);
    if (e.name !== undefined) w.str(e.name);
  }
  return chunk(0x2019, w);
}

/** Old palette: packets of [skip, colours[]]. */
export function oldPalette(
  type: 0x0004 | 0x0011,
  packets: [number, [number, number, number][]][],
): number[] {
  const w = new W().u16(packets.length);
  for (const [skip, colors] of packets) {
    w.u8(skip).u8(colors.length === 256 ? 0 : colors.length);
    for (const c of colors) w.bytes(c);
  }
  return chunk(type, w);
}

export function tagsChunk(
  tags: {
    name: string;
    from: number;
    to: number;
    dir?: number;
    repeat?: number;
    rgb?: [number, number, number];
  }[],
): number[] {
  const w = new W().u16(tags.length).zeros(8);
  for (const t of tags) {
    w.u16(t.from)
      .u16(t.to)
      .u8(t.dir ?? 0)
      .u16(t.repeat ?? 0)
      .zeros(6)
      .bytes(t.rgb ?? [1, 2, 3])
      .u8(0)
      .str(t.name);
  }
  return chunk(0x2018, w);
}

export function userData(o: {
  text?: string;
  color?: [number, number, number, number];
  props?: boolean;
}): number[] {
  const w = new W().u32(
    (o.text === undefined ? 0 : 1) | (o.color === undefined ? 0 : 2) | (o.props === true ? 4 : 0),
  );
  if (o.text !== undefined) w.str(o.text);
  if (o.color !== undefined) w.bytes(o.color);
  if (o.props === true)
    w.u32(8 + 4)
      .u32(1)
      .u32(0xdeadbeef); // size field + count + payload
  return chunk(0x2020, w);
}
