import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AseError,
  ASE_MAX_DIMENSION,
  aseCelToRgba,
  aseImageToRgba,
  findAseCel,
  parseAseprite,
  resolveAseCel,
} from '../src/index.js';
import type { AseErrorCode, AseImage } from '../src/index.js';
import {
  W,
  chunk,
  file,
  frame,
  layer,
  linkCel,
  newPalette,
  oldPalette,
  rawCel,
  tagsChunk,
  tilemapCel,
  userData,
  zCel,
} from './aseprite-builder.js';

const dir = fileURLToPath(new URL('../../../fixtures/aseprite/', import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`${dir}${name}.aseprite`));

function codeOf(fn: () => unknown): AseErrorCode | 'no error' {
  try {
    fn();
  } catch (e) {
    if (e instanceof AseError) return e.code;
    throw e;
  }
  return 'no error';
}

/** Offsets of the header end, each frame start and each chunk start in a real file. */
function boundaries(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [128];
  let pos = 128;
  const frames = dv.getUint16(6, true);
  for (let f = 0; f < frames; f++) {
    const size = dv.getUint32(pos, true);
    const count = dv.getUint32(pos + 12, true) || dv.getUint16(pos + 6, true);
    let c = pos + 16;
    for (let i = 0; i < count; i++) {
      out.push(c);
      c += dv.getUint32(c, true);
    }
    pos += size;
    out.push(pos);
  }
  return out;
}

describe('corruption', () => {
  const real = fixture('layers_parts');

  it('parses the untouched file', () => {
    expect(codeOf(() => parseAseprite(real))).toBe('no error');
  });

  it('truncation at every chunk and frame boundary is TRUNCATED, and the end is fine', () => {
    const cuts = boundaries(real);
    expect(cuts.length).toBeGreaterThan(20);
    expect(cuts.at(-1)).toBe(real.length);
    for (const cut of cuts.slice(0, -1)) {
      expect(
        codeOf(() => parseAseprite(real.subarray(0, cut))),
        `cut at ${String(cut)}`,
      ).toBe('TRUNCATED');
    }
    expect(codeOf(() => parseAseprite(real.subarray(0, cuts.at(-1))))).toBe('no error');
  });

  it('truncation at every byte is TRUNCATED (never another error, never a crash)', () => {
    for (const name of ['linked_cels', 'tags_overlap', 'indexed_palette']) {
      const bytes = fixture(name);
      for (let cut = 6; cut < bytes.length; cut++) {
        expect(
          codeOf(() => parseAseprite(bytes.subarray(0, cut))),
          `${name} cut ${String(cut)}`,
        ).toBe('TRUNCATED');
      }
    }
  });

  it('empty and tiny inputs are TRUNCATED', () => {
    expect(codeOf(() => parseAseprite(new Uint8Array(0)))).toBe('TRUNCATED');
    expect(codeOf(() => parseAseprite(new Uint8Array(5)))).toBe('TRUNCATED');
  });

  it('bad magic', () => {
    const bad = real.slice();
    bad[4] = 0;
    expect(codeOf(() => parseAseprite(bad))).toBe('BAD_MAGIC');
    expect(codeOf(() => parseAseprite(new Uint8Array(200)))).toBe('BAD_MAGIC');
  });

  it('bad zlib data in a cel', () => {
    const celAt = boundaries(real).find(
      (c) => new DataView(real.buffer, real.byteOffset).getUint16(c + 4, true) === 0x2005,
    );
    expect(celAt).toBeDefined();
    const dataAt = (celAt ?? 0) + 6 + 20 + 4; // chunk header + cel header + width/height
    const header = real.slice();
    header[dataAt] = 0xff; // zlib header byte
    expect(codeOf(() => parseAseprite(header))).toBe('DECOMPRESS_FAILED');
    const body = real.slice();
    for (let i = dataAt + 2; i < dataAt + 8; i++) body[i] = 0xff;
    expect(codeOf(() => parseAseprite(body))).toBe('DECOMPRESS_FAILED');
  });

  it('a cel whose stream inflates to the wrong size is DECOMPRESS_FAILED', () => {
    const small = zCel(2, 2, new Uint8Array(8)); // 8 bytes, but 2x2 RGBA needs 16
    const big = zCel(2, 2, new Uint8Array(40)); // too much
    for (const cel of [small, big]) {
      const bytes = file([frame([layer('a'), cel])], { width: 2, height: 2 });
      expect(codeOf(() => parseAseprite(bytes))).toBe('DECOMPRESS_FAILED');
    }
  });

  it('decompression bomb claims are refused without allocating', () => {
    const lie = chunk(
      0x2005,
      new W()
        .u16(0)
        .i16(0)
        .i16(0)
        .u8(255)
        .u16(2)
        .i16(0)
        .zeros(5)
        .u16(10000)
        .u16(10000)
        .bytes([0x78, 0x9c, 0x03, 0x00, 0, 0, 0, 1]),
    );
    expect(
      codeOf(() =>
        parseAseprite(file([frame([layer('a'), lie])], { width: 10000, height: 10000 })),
      ),
    ).toBe('DECOMPRESS_FAILED');
    const huge = chunk(
      0x2005,
      new W()
        .u16(0)
        .i16(0)
        .i16(0)
        .u8(255)
        .u16(2)
        .i16(0)
        .zeros(5)
        .u16(16384)
        .u16(16384)
        .bytes([0x78]),
    );
    expect(
      codeOf(() =>
        parseAseprite(file([frame([layer('a'), huge])], { width: 16384, height: 16384 })),
      ),
    ).toBe('TOO_LARGE');
  });

  it('oversize or invalid headers', () => {
    const f = (o: Parameters<typeof file>[1]): Uint8Array => file([frame([layer('a')])], o);
    expect(codeOf(() => parseAseprite(f({ width: ASE_MAX_DIMENSION + 1 })))).toBe('TOO_LARGE');
    expect(codeOf(() => parseAseprite(f({ height: ASE_MAX_DIMENSION + 1 })))).toBe('TOO_LARGE');
    expect(
      codeOf(() => parseAseprite(f({ width: ASE_MAX_DIMENSION, height: ASE_MAX_DIMENSION }))),
    ).toBe('no error');
    expect(codeOf(() => parseAseprite(f({ width: 0 })))).toBe('BAD_HEADER');
    expect(codeOf(() => parseAseprite(f({ depth: 24 })))).toBe('BAD_HEADER');
    expect(codeOf(() => parseAseprite(f({ frameCount: 0 })))).toBe('BAD_HEADER');
  });

  it('declared frame count larger than the data is TRUNCATED', () => {
    expect(codeOf(() => parseAseprite(file([frame([layer('a')])], { frameCount: 3 })))).toBe(
      'TRUNCATED',
    );
  });

  it('bad frame magic, tiny frame size, impossible chunk size', () => {
    expect(codeOf(() => parseAseprite(file([frame([layer('a')], { magic: 0x1234 })])))).toBe(
      'BAD_CHUNK',
    );
    const tiny = file([frame([layer('a')])]);
    new DataView(tiny.buffer).setUint32(128, 4, true);
    expect(codeOf(() => parseAseprite(tiny))).toBe('BAD_CHUNK');
    const sizes = file([frame([layer('a')])]);
    new DataView(sizes.buffer).setUint32(128 + 16, 5, true); // chunk size < 6
    expect(codeOf(() => parseAseprite(sizes))).toBe('BAD_CHUNK');
    new DataView(sizes.buffer).setUint32(128 + 16, 99999, true); // chunk runs past its frame
    expect(codeOf(() => parseAseprite(sizes))).toBe('BAD_CHUNK');
  });

  it('declared chunk count larger than the frame holds', () => {
    expect(codeOf(() => parseAseprite(file([frame([layer('a')], { count: 3 })])))).toBe(
      'BAD_CHUNK',
    );
  });

  it('a chunk body shorter than its fields is BAD_CHUNK', () => {
    const short = chunk(0x2004, [1, 0, 0]);
    expect(codeOf(() => parseAseprite(file([frame([short])])))).toBe('BAD_CHUNK');
    const rawShort = chunk(
      0x2005,
      new W().u16(0).i16(0).i16(0).u8(255).u16(0).i16(0).zeros(5).u16(4).u16(4).zeros(10),
    );
    expect(codeOf(() => parseAseprite(file([frame([layer('a'), rawShort])])))).toBe('BAD_CHUNK');
  });

  it('structural errors: layer type, parent, tag direction, tag range, missing layer, bad links', () => {
    const base = (chunks: number[][], o?: Parameters<typeof file>[1]): Uint8Array =>
      file([frame(chunks)], o);
    expect(codeOf(() => parseAseprite(base([layer('a', { type: 7 })])))).toBe('BAD_CHUNK');
    expect(codeOf(() => parseAseprite(base([layer('a', { level: 1 })])))).toBe('BAD_CHUNK'); // no parent
    expect(codeOf(() => parseAseprite(base([layer('a'), layer('b', { level: 1 })])))).toBe(
      'BAD_CHUNK',
    ); // parent not a group
    expect(codeOf(() => parseAseprite(base([layer('a', { level: 300 })])))).toBe('BAD_CHUNK');
    expect(
      codeOf(() =>
        parseAseprite(base([layer('a'), tagsChunk([{ name: 't', from: 0, to: 0, dir: 9 }])])),
      ),
    ).toBe('BAD_CHUNK');
    expect(
      codeOf(() => parseAseprite(base([layer('a'), tagsChunk([{ name: 't', from: 0, to: 1 }])]))),
    ).toBe('BAD_CHUNK');
    expect(
      codeOf(() => parseAseprite(base([layer('a'), tagsChunk([{ name: 't', from: 1, to: 0 }])]))),
    ).toBe('BAD_CHUNK');
    expect(
      codeOf(() => parseAseprite(base([layer('a'), rawCel(1, 1, [0, 0, 0, 0], { layer: 4 })]))),
    ).toBe('BAD_CHUNK');
    expect(
      codeOf(() =>
        parseAseprite(
          base([
            layer('a'),
            chunk(0x2005, new W().u16(0).i16(0).i16(0).u8(255).u16(9).i16(0).zeros(5)),
          ]),
        ),
      ),
    ).toBe('BAD_CHUNK');
    expect(codeOf(() => parseAseprite(base([layer('a'), linkCel(0)])))).toBe('BAD_CHUNK'); // links to itself
    expect(codeOf(() => parseAseprite(base([layer('a'), linkCel(5)])))).toBe('BAD_CHUNK');
    const gap = file([
      frame([layer('a'), rawCel(1, 1, [1, 2, 3, 4])]),
      frame([linkCel(0, { layer: 0 })]),
      frame([linkCel(0, { layer: 3 })]),
    ]);
    expect(codeOf(() => parseAseprite(gap))).toBe('BAD_CHUNK');
  });

  it('palette errors', () => {
    const base = (c: number[]): Uint8Array => file([frame([layer('a'), c])]);
    expect(codeOf(() => parseAseprite(base(newPalette(70000, 0, [{ rgba: [0, 0, 0, 0] }]))))).toBe(
      'TOO_LARGE',
    );
    expect(codeOf(() => parseAseprite(base(newPalette(2, 5, [{ rgba: [0, 0, 0, 0] }]))))).toBe(
      'BAD_CHUNK',
    );
    expect(
      codeOf(() =>
        parseAseprite(
          base(
            oldPalette(0x0004, [
              [
                200,
                [
                  [1, 2, 3],
                  [4, 5, 6],
                  [7, 8, 9],
                ],
              ],
              [60, Array.from({ length: 10 }, () => [0, 0, 0] as [number, number, number])],
            ]),
          ),
        ),
      ),
    ).toBe('BAD_CHUNK');
    expect(codeOf(() => parseAseprite(base(chunk(0x2020, new W().u32(4).u32(2)))))).toBe(
      'BAD_CHUNK',
    );
  });
});

describe('crafted files', () => {
  it('raw (type 0) cels, z-index, negative position and cel extra', () => {
    const extra = chunk(0x2006, new W().u32(1).fixed(1.5).fixed(-2).fixed(3).fixed(4).zeros(16));
    const bytes = file([
      frame([
        layer('a'),
        rawCel(2, 1, [9, 8, 7, 6, 5, 4, 3, 2], { x: -1, y: 2, opacity: 40, z: -3 }),
        extra,
        userData({ text: 'celnote' }),
      ]),
    ]);
    const f = parseAseprite(bytes);
    const cel = f.frames[0]?.cels[0];
    expect(cel).toMatchObject({
      x: -1,
      y: 2,
      opacity: 40,
      zIndex: -3,
      layerIndex: 0,
      frameIndex: 0,
    });
    expect(cel?.content.type === 'image' ? cel.content.encoding : '').toBe('raw');
    expect(cel?.extra).toEqual({ flags: 1, x: 1.5, y: -2, width: 3, height: 4 });
    expect(cel?.userData?.text).toBe('celnote');
    expect(f.header).toMatchObject({
      gridX: -3,
      gridY: 5,
      gridWidth: 8,
      gridHeight: 8,
      pixelWidth: 1,
      pixelHeight: 1,
      paletteEntryCount: 256,
    });
    const rgba = f.frames[0]?.cels[0] && aseCelToRgba(f, f.frames[0].cels[0]);
    expect(Array.from(rgba?.data ?? [])).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('cel extra without a cel is kept as a chunk and attaches nowhere', () => {
    const extra = chunk(0x2006, new W().u32(0).fixed(0).fixed(0).fixed(0).fixed(0).zeros(16));
    const f = parseAseprite(file([frame([layer('a'), extra])]));
    expect(f.frames[0]?.chunks.map((c) => c.kind)).toEqual(['layer', 'celExtra']);
  });

  it('pixel ratio, old frame chunk count, zero duration falls back to header speed', () => {
    const f = parseAseprite(
      file(
        [
          frame([layer('a')], { duration: 0, oldCountOnly: true }),
          frame([layer('b')], { duration: 33 }),
        ],
        {
          speed: 77,
          pixelW: 2,
          pixelH: 1,
        },
      ),
    );
    expect(f.frames.map((x) => x.durationMs)).toEqual([77, 33]);
    expect(f.header).toMatchObject({ pixelWidth: 2, pixelHeight: 1, speedMs: 77 });
    expect(f.layers.map((l) => l.name)).toEqual(['a', 'b']);
  });

  it('layer opacity honours the header flags (1: image layers, 2: groups too)', () => {
    const chunks = [
      layer('img', { opacity: 100, blend: 1 }),
      layer('grp', { type: 1, opacity: 90, blend: 2 }),
      layer('kid', { level: 1, opacity: 80, blend: 99 }),
    ];
    const none = parseAseprite(file([frame(chunks)], { flags: 0 }));
    expect(none.layers.map((l) => l.opacity)).toEqual([255, 255, 255]);
    expect(none.layers.map((l) => l.opacityRaw)).toEqual([100, 90, 80]);
    expect(none.layers.map((l) => l.blendMode)).toEqual(['multiply', 'normal', 'normal']);
    const one = parseAseprite(file([frame(chunks)], { flags: 1 }));
    expect(one.layers.map((l) => l.opacity)).toEqual([100, 255, 80]);
    const both = parseAseprite(file([frame(chunks)], { flags: 3 }));
    expect(both.layers.map((l) => [l.opacity, l.blendMode])).toEqual([
      [100, 'multiply'],
      [90, 'screen'],
      [80, 'normal'],
    ]);
    expect(both.layers[2]).toMatchObject({ blendModeValue: 99, parentIndex: 1, childLevel: 1 });
  });

  it('layer flags, tilemap layer tileset index and UUIDs', () => {
    const all = 1 | 2 | 4 | 8 | 16 | 32 | 64;
    const f = parseAseprite(
      file(
        [
          frame([
            layer('bg', { flags: all, uuid: true }),
            layer('tm', { type: 2, tileset: 3, flags: 0, uuid: true }),
          ]),
        ],
        { flags: 5 },
      ),
    );
    expect(f.layers[0]).toMatchObject({
      visible: true,
      editable: true,
      lockMovement: true,
      background: true,
      preferLinkedCels: true,
      collapsed: true,
      reference: true,
      tilesetIndex: null,
      uuid: '0102030405060708090a0b0c0d0e0f10',
    });
    expect(f.layers[1]).toMatchObject({ type: 'tilemap', tilesetIndex: 3, visible: false });
  });

  it('tilemap cels keep their header and refuse pixels', () => {
    const f = parseAseprite(file([frame([layer('tm', { type: 2 }), tilemapCel()])]));
    const cel = f.frames[0]?.cels[0];
    expect(cel?.content).toMatchObject({
      type: 'tilemap',
      widthTiles: 2,
      heightTiles: 3,
      bitsPerTile: 32,
      tileIdMask: 0x1fffffff,
    });
    expect(codeOf(() => cel && aseCelToRgba(f, cel))).toBe('UNSUPPORTED');
  });

  it('grayscale cels expand to RGBA', () => {
    const f = parseAseprite(
      file([frame([layer('g'), zCel(2, 1, [10, 255, 200, 128])])], { depth: 16 }),
    );
    const cel = f.frames[0]?.cels[0];
    expect(cel && Array.from(aseCelToRgba(f, cel).data)).toEqual([
      10, 10, 10, 255, 200, 200, 200, 128,
    ]);
  });

  it('rgba cels round trip', () => {
    const px = [1, 2, 3, 4, 250, 251, 252, 253];
    const f = parseAseprite(
      file([frame([layer('c'), zCel(2, 1, px, { x: 2, y: 1 })])], { width: 4, height: 2 }),
    );
    const cel = f.frames[0]?.cels[0];
    const out = cel && aseCelToRgba(f, cel);
    expect(out).toMatchObject({ x: 2, y: 1, width: 2, height: 1, opacity: 255 });
    expect(Array.from(out?.data ?? [])).toEqual(px);
  });

  describe('indexed transparency semantics', () => {
    const pal = newPalette(3, 0, [
      { rgba: [9, 9, 9, 255] },
      { rgba: [1, 2, 3, 255] },
      { rgba: [4, 5, 6, 77] },
    ]);
    const mk = (flags: number): ReturnType<typeof parseAseprite> =>
      parseAseprite(
        file([frame([layer('bg', { flags }), pal, zCel(4, 1, [0, 1, 2, 7])])], {
          depth: 8,
          transparent: 0,
          width: 4,
          height: 1,
        }),
      );

    it('transparent index is clear on normal layers; out-of-palette indices are clear', () => {
      const f = mk(3);
      const cel = f.frames[0]?.cels[0];
      expect(cel && Array.from(aseCelToRgba(f, cel).data)).toEqual([
        0, 0, 0, 0, 1, 2, 3, 255, 4, 5, 6, 77, 0, 0, 0, 0,
      ]);
    });

    it('on a background layer the transparent index is an ordinary colour', () => {
      const f = mk(3 | 8);
      const cel = f.frames[0]?.cels[0];
      expect(cel && Array.from(aseCelToRgba(f, cel).data).slice(0, 4)).toEqual([9, 9, 9, 255]);
    });

    it('aseImageToRgba options and the missing-palette error', () => {
      const img: AseImage = { width: 2, height: 1, depth: 8, data: Uint8Array.from([0, 1]) };
      const f = mk(3);
      expect(Array.from(aseImageToRgba(img, f.palette))).toEqual(
        Array.from(aseImageToRgba(img, f.palette, { transparentIndex: null })),
      );
      expect(Array.from(aseImageToRgba(img, f.palette, { transparentIndex: 1 }))).toEqual([
        9, 9, 9, 255, 0, 0, 0, 0,
      ]);
      expect(codeOf(() => aseImageToRgba(img, null))).toBe('UNSUPPORTED');
    });
  });

  it('palette: partial updates, names, per-frame snapshots, new wins over old', () => {
    const f = parseAseprite(
      file([
        frame([
          layer('a'),
          oldPalette(0x0004, [
            [
              0,
              [
                [10, 20, 30],
                [40, 50, 60],
              ],
            ],
          ]),
          newPalette(4, 0, [
            { rgba: [1, 1, 1, 255], name: 'one' },
            { rgba: [2, 2, 2, 255] },
            { rgba: [3, 3, 3, 255] },
            { rgba: [4, 4, 4, 0] },
          ]),
        ]),
        frame([
          newPalette(3, 1, [{ rgba: [9, 9, 9, 255], name: 'nine' }, { rgba: [8, 8, 8, 255] }]),
        ]),
        frame([]),
      ]),
    );
    expect(f.frames[0]?.palette?.source).toBe('new');
    expect(f.frames[0]?.palette?.entries).toHaveLength(4);
    expect(f.frames[0]?.palette?.entries[0]?.name).toBe('one');
    expect(f.frames[1]?.palette?.entries).toEqual([
      { r: 1, g: 1, b: 1, a: 255, name: 'one' },
      { r: 9, g: 9, b: 9, a: 255, name: 'nine' },
      { r: 8, g: 8, b: 8, a: 255 },
    ]);
    expect(f.frames[2]?.palette).toBe(f.frames[1]?.palette);
    expect(f.palette).toBe(f.frames[2]?.palette);
    // Growing a palette pads with opaque black.
    const grown = parseAseprite(file([frame([newPalette(3, 1, [{ rgba: [5, 5, 5, 5] }])])]));
    expect(grown.palette?.entries[0]).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('old palettes: 0x0004 (8-bit) and 0x0011 (6-bit scaled up), packets with skips', () => {
    const f = parseAseprite(
      file([
        frame([
          layer('a'),
          oldPalette(0x0004, [
            [1, [[10, 20, 30]]],
            [2, [[40, 50, 60]]],
          ]),
        ]),
      ]),
    );
    expect(f.palette?.source).toBe('old');
    expect(f.palette?.entries.map((e) => [e.r, e.g, e.b, e.a])).toEqual([
      [0, 0, 0, 255],
      [10, 20, 30, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [40, 50, 60, 255],
    ]);
    const six = parseAseprite(file([frame([oldPalette(0x0011, [[0, [[63, 0, 32]]]])])]));
    expect(six.palette?.entries[0]).toEqual({ r: 255, g: 0, b: 130, a: 255 });
    const full = parseAseprite(
      file([
        frame([
          oldPalette(0x0004, [
            [0, Array.from({ length: 256 }, (_, i) => [i, 0, 0] as [number, number, number])],
          ]),
        ]),
      ]),
    );
    expect(full.palette?.entries).toHaveLength(256);
    expect(full.palette?.entries[255]?.r).toBe(255);
  });

  it('colour profile: sRGB and embedded ICC', () => {
    const srgb = chunk(0x2007, new W().u16(1).u16(1).fixed(2.2).zeros(8));
    const icc = chunk(0x2007, new W().u16(2).u16(0).fixed(1).zeros(8).u32(3).bytes([7, 8, 9]));
    expect(parseAseprite(file([frame([srgb])])).colorProfile).toMatchObject({ type: 1, flags: 1 });
    const f = parseAseprite(file([frame([icc])]));
    expect(Array.from(f.colorProfile?.icc ?? [])).toEqual([7, 8, 9]);
  });

  it('user data: attaches to layer, cel, slice, sprite (after palette), tags in order; extras go nowhere', () => {
    const slice = chunk(
      0x2022,
      new W()
        .u32(2)
        .u32(3)
        .u32(0)
        .str('hit')
        .u32(0)
        .i32(1)
        .i32(2)
        .u32(3)
        .u32(4)
        .i32(1)
        .i32(1)
        .u32(1)
        .u32(1)
        .i32(-1)
        .i32(-2)
        .u32(5)
        .i32(0)
        .i32(0)
        .u32(0)
        .u32(0)
        .i32(0)
        .i32(0)
        .u32(0)
        .u32(0)
        .i32(0)
        .i32(0),
    );
    const f = parseAseprite(
      file([
        frame([
          layer('a'),
          userData({ text: 'layer text', color: [1, 2, 3, 4], props: true }),
          userData({ text: 'second one is dropped' }),
          newPalette(1, 0, [{ rgba: [0, 0, 0, 255] }]),
          userData({ text: 'sprite' }),
          rawCel(1, 1, [0, 0, 0, 0]),
          userData({ text: 'cel' }),
          slice,
          userData({ color: [9, 9, 9, 9] }),
          tagsChunk([
            { name: 'x', from: 0, to: 0 },
            { name: 'y', from: 0, to: 0 },
          ]),
          userData({ text: 'tag x' }),
          userData({ text: 'tag y' }),
          userData({ text: 'overflow' }),
          chunk(0x2023, new W().zeros(8)), // tileset (skipped)
          userData({ text: 'tile data, dropped' }),
        ]),
      ]),
    );
    expect(f.layers[0]?.userData).toMatchObject({
      text: 'layer text',
      color: { r: 1, g: 2, b: 3, a: 4 },
    });
    expect(f.layers[0]?.userData?.properties?.length).toBe(12);
    expect(f.userData?.text).toBe('sprite');
    expect(f.frames[0]?.cels[0]?.userData?.text).toBe('cel');
    expect(f.slices[0]?.userData?.color?.a).toBe(9);
    expect(f.tags.map((t) => t.userData?.text)).toEqual(['tag x', 'tag y']);
    const targets = f.frames[0]?.chunks.flatMap((c) => (c.kind === 'userData' ? [c.target] : []));
    expect(targets).toEqual([
      { kind: 'layer', layerIndex: 0 },
      null,
      { kind: 'sprite' },
      { kind: 'cel', frameIndex: 0, layerIndex: 0 },
      { kind: 'slice', sliceIndex: 0 },
      { kind: 'tag', tagIndex: 0 },
      { kind: 'tag', tagIndex: 1 },
      null,
      null,
    ]);
    expect(f.frames[0]?.chunks.find((c) => c.kind === 'skipped')).toMatchObject({
      chunkType: 0x2023,
      name: 'tileset',
    });
  });

  it('slices parse keys, nine-patch centres and pivots', () => {
    const slice = chunk(
      0x2022,
      new W()
        .u32(2)
        .u32(3)
        .u32(0)
        .str('hit')
        .u32(0)
        .i32(1)
        .i32(2)
        .u32(3)
        .u32(4)
        .i32(1)
        .i32(1)
        .u32(1)
        .u32(1)
        .i32(-1)
        .i32(-2)
        .u32(5)
        .i32(0)
        .i32(0)
        .u32(0)
        .u32(0)
        .i32(0)
        .i32(0)
        .u32(0)
        .u32(0)
        .i32(0)
        .i32(0),
    );
    const plain = chunk(
      0x2022,
      new W().u32(1).u32(0).u32(0).str('p').u32(0).i32(0).i32(0).u32(2).u32(2),
    );
    const f = parseAseprite(file([frame([slice, plain])]));
    expect(f.slices[0]).toMatchObject({ name: 'hit', flags: 3 });
    expect(f.slices[0]?.keys[0]).toEqual({
      frame: 0,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      center: { x: 1, y: 1, width: 1, height: 1 },
      pivot: { x: -1, y: -2 },
    });
    expect(f.slices[0]?.keys[1]?.frame).toBe(5);
    expect(f.slices[1]?.keys[0]).toEqual({ frame: 0, x: 0, y: 0, width: 2, height: 2 });
  });

  it('tags: all directions, repeat, legacy colour; unknown chunks are skipped by size', () => {
    const f = parseAseprite(
      file(
        [
          frame([
            layer('a'),
            tagsChunk([
              { name: 'f', from: 0, to: 0, dir: 0 },
              { name: 'r', from: 0, to: 0, dir: 1, repeat: 3, rgb: [9, 8, 7] },
              { name: 'p', from: 0, to: 0, dir: 2 },
              { name: 'pr', from: 0, to: 0, dir: 3 },
            ]),
            chunk(0x7777, [1, 2, 3, 4, 5]),
            chunk(0x2008, new W().u32(0).zeros(8)),
          ]),
        ],
        {},
      ),
    );
    expect(f.tags.map((t) => t.direction)).toEqual([
      'forward',
      'reverse',
      'pingpong',
      'pingpong_reverse',
    ]);
    expect(f.tags[1]).toMatchObject({ repeat: 3, legacyColor: { r: 9, g: 8, b: 7 } });
    const kinds = f.frames[0]?.chunks.map((c) => c.kind);
    expect(kinds).toEqual(['layer', 'tags', 'unknown', 'skipped']);
    expect(f.frames[0]?.chunks[2]).toEqual({ kind: 'unknown', chunkType: 0x7777, size: 11 });
  });

  it('utf-8 layer names, including malformed bytes', () => {
    const f = parseAseprite(file([frame([layer('héllo ✓ 𝄞')])]));
    expect(f.layers[0]?.name).toBe('héllo ✓ 𝄞');
    const raw = new W()
      .u16(1)
      .u16(0)
      .u16(0)
      .zeros(4)
      .u16(0)
      .u8(255)
      .zeros(3)
      .u16(9)
      .bytes([0x61, 0xc3, 0xe2, 0x82, 0xf0, 0x9f, 0xc0, 0xed, 0xa0]);
    const bad = parseAseprite(file([frame([chunk(0x2004, raw)])]));
    expect(bad.layers[0]?.name).toMatch(/^a\uFFFD+$/u);
  });

  it('linked cels resolve through chains and findAseCel misses cleanly', () => {
    const f = parseAseprite(
      file([
        frame([layer('a'), rawCel(1, 1, [5, 6, 7, 255], { x: 3, y: 1, opacity: 90 })]),
        frame([linkCel(0, { x: 99 })]),
        frame([linkCel(1)]),
      ]),
    );
    const last = f.frames[2]?.cels[0];
    const resolved = last && resolveAseCel(f, last);
    expect(resolved?.cel.frameIndex).toBe(0);
    expect(last && aseCelToRgba(f, last)).toMatchObject({ x: 3, y: 1, opacity: 90 });
    expect(findAseCel(f, 7, 0)).toBeUndefined();
    expect(findAseCel(f, 0, 4)).toBeUndefined();
  });

  it('a link cycle is BAD_CHUNK at resolve time', () => {
    const f = parseAseprite(
      file([frame([layer('a'), rawCel(1, 1, [1, 1, 1, 1])]), frame([linkCel(0)])]),
    );
    const a = f.frames[0]?.cels[0];
    const b = f.frames[1]?.cels[0];
    if (a === undefined || b === undefined) throw new Error('setup');
    // Forge a cycle by pointing the "image" cel back at the link (the parser never produces this).
    const forged = { ...a, content: { type: 'linked', framePosition: 1 } as const };
    const cyc = {
      ...f,
      frames: [{ ...f.frames[0], cels: [forged] }, f.frames[1]],
    } as unknown as typeof f;
    expect(codeOf(() => resolveAseCel(cyc, b))).toBe('BAD_CHUNK');
    const dangling = {
      ...f,
      frames: [{ ...f.frames[0], cels: [] }, f.frames[1]],
    } as unknown as typeof f;
    expect(codeOf(() => resolveAseCel(dangling, b))).toBe('BAD_CHUNK');
  });
});
