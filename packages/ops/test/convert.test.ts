// convert.imageToSprite and convert.apply: success, refusals, undo, variants, palette handling.
import { documentHash, validate } from '@pixel-forge/core';
import { MemoryFileSystem, fixedClock } from '@pixel-forge/io';
import { encodePng } from '@pixel-forge/png';
import { TiledImage } from '@pixel-forge/raster';
import type { DocId, FrameId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { createMemoryHost, registry } from '../src/index.js';
import type { OpHost, RunOptions } from '../src/index.js';
import { openFlat } from './grid-fixtures.js';
import { need, rejection, stepLabels } from './helpers.js';

const RED = [255, 0, 0, 255] as const;
const GREEN = [0, 255, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;
const WHITE = [255, 255, 255, 255] as const;

/** Hand-written 4x4 art: R G / B W quadrant blocks of 2x2 are not used; one symbol per pixel. */
const ART = ['RGGB', 'RWWB', 'GWWR', 'BRGG'];
const COLOUR = { R: RED, G: GREEN, B: BLUE, W: WHITE } as const;

/** PNG of `ART` upscaled `k` times, a white border of `pad` pixels around it. */
function artPng(k: number, pad = 0): Uint8Array {
  const size = 4 * k + 2 * pad;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ax = Math.floor((x - pad) / k);
      const ay = Math.floor((y - pad) / k);
      const inside = x >= pad && y >= pad && x < size - pad && y < size - pad;
      const c = inside ? COLOUR[(ART[ay] ?? '')[ax] as keyof typeof COLOUR] : WHITE;
      data.set(c, (y * size + x) * 4);
    }
  }
  return encodePng({ width: size, height: size, data, kind: 'rgba' });
}

function convertHost(): { host: OpHost; fs: MemoryFileSystem; run: RunOptions } {
  const fs = new MemoryFileSystem();
  const host = createMemoryHost({
    fs,
    clock: fixedClock('2026-11-01T00:00:00Z'),
    roots: ['/work'],
  });
  return { host, fs, run: { host } };
}

interface SpriteOut {
  doc: DocId;
  canvas: { w: number; h: number };
  layers: string[];
  palette?: { name: string; colors: number };
  steps: string[];
  grid?: string;
}

/** The id of frame 0 of the first animation. */
function firstFrame(d: { readonly animations: readonly object[] }): FrameId {
  const a = d.animations[0] as { frames?: readonly { id: string }[] } | undefined;
  return need(a?.frames?.[0]).id as FrameId;
}

/** The RGBA of a layer's cel at frame 0 of the new document, as rows of `[r,g,b,a]`. */
function layerPixels(host: OpHost, doc: DocId, layerName: string): number[][][] {
  const hosted = need(host.get(doc));
  const d = hosted.store.doc;
  const layer = need(d.layers.find((l) => l.name === layerName));
  if (layer.kind !== 'pixel') throw new Error('not a pixel layer');
  const frameId = firstFrame(d);
  const cel = layer.cels[frameId];
  if (cel === undefined || 'linkTo' in cel) throw new Error('no cel');
  const img = need(hosted.store.image(cel.imageId));
  if (!(img instanceof TiledImage)) throw new Error('not RGBA');
  const rows: number[][][] = [];
  for (let y = 0; y < d.meta.canvas.h; y++) {
    const row: number[][] = [];
    for (let x = 0; x < d.meta.canvas.w; x++) {
      row.push([...img.get(x - cel.offset.x, y - cel.offset.y)]);
    }
    rows.push(row);
  }
  return rows;
}

describe('convert.imageToSprite', () => {
  it('finds the grid of upscaled art and opens a 4x4 document with the exact pixels', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(6, 0));
    const out = (await registry.execute(
      'convert.imageToSprite',
      { file: '/work/art.png', grid: 'auto' },
      run,
    )) as SpriteOut;
    expect(out.canvas).toEqual({ w: 4, h: 4 });
    expect(out.layers).toEqual(['sprite']);
    expect(out.grid).toBe('6x6');
    expect(out.steps).toEqual(['downscale 4x4', 'cleanup 4x4']);
    const px = layerPixels(host, out.doc, 'sprite');
    ART.forEach((row, y) => {
      row.split('').forEach((c, x) => {
        expect(px[y]?.[x], `${String(x)},${String(y)}`).toEqual([
          ...COLOUR[c as keyof typeof COLOUR],
        ]);
      });
    });
    // A valid document, named after the file, ready for the other tools.
    const hosted = need(host.get(out.doc));
    expect(hosted.store.doc.meta.name).toBe('art');
    expect(validate(hosted.store).filter((f) => f.severity === 'error')).toEqual([]);
    expect(hosted.path).toBeUndefined();
    const summary = await registry.execute('doc.summary', { doc: out.doc }, run);
    expect(summary).toBeTruthy();
  });

  it('removes a flood background, quantises to a given palette and adopts it', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(5, 3));
    const out = (await registry.execute(
      'convert.imageToSprite',
      {
        file: '/work/art.png',
        grid: 'auto',
        background: 'flood',
        palette: ['#ff0000', '#00ff00', '#0000ff'],
        name: 'sprite one',
      },
      run,
    )) as SpriteOut;
    // The white border is flood-removed; the white inside the art is enclosed by colours and stays
    // (but white is not in the palette, so it snaps to the nearest palette colour).
    const px = layerPixels(host, out.doc, 'sprite');
    expect(out.canvas).toEqual({ w: 6, h: 6 });
    expect(px[0]?.[0]?.[3]).toBe(0);
    expect(px[5]?.[5]?.[3]).toBe(0);
    expect(px[1]?.[1]).toEqual([...RED]);
    expect(out.palette).toEqual({ name: 'custom', colors: 3 });
    const doc = need(host.get(out.doc)).store.doc;
    expect(doc.meta.name).toBe('sprite one');
    const active = doc.palettes.find((p) => p.id === doc.activePaletteId);
    expect(active?.colors).toEqual([[...RED], [...GREEN], [...BLUE]]);
  });

  it('makes a palette from the image when only "colors" is given', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(4, 0));
    const out = (await registry.execute(
      'convert.imageToSprite',
      { file: '/work/art.png', grid: 'auto', colors: 4 },
      run,
    )) as SpriteOut;
    expect(out.palette).toEqual({ name: 'generated', colors: 4 });
    // The art has exactly these four colours, so nothing changes.
    const px = layerPixels(host, out.doc, 'sprite');
    expect(px[0]?.[0]).toEqual([...RED]);
    expect(px[1]?.[1]).toEqual([...WHITE]);
  });

  it('with variants: one layer per combination, the first visible, labels as names', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(4, 0));
    const out = (await registry.execute(
      'convert.imageToSprite',
      {
        file: '/work/art.png',
        width: 2,
        variants: { method: ['box', 'mode'], dither: ['none', 'bayer4'] },
        palette: 'pico-8',
      },
      run,
    )) as SpriteOut;
    expect(out.layers).toEqual([
      'method-box_dither-none',
      'method-box_dither-bayer4',
      'method-mode_dither-none',
      'method-mode_dither-bayer4',
    ]);
    const doc = need(host.get(out.doc)).store.doc;
    expect(doc.layers.map((l) => l.visible)).toEqual([true, false, false, false]);
    expect(doc.animations).toHaveLength(1);
    expect(validate(need(host.get(out.doc)).store).filter((f) => f.severity === 'error')).toEqual(
      [],
    );
  });

  it('refuses JPEG and WebP with the "convert to PNG first" message, and keeps no document', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/a.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]));
    fs.seed('/work/a.webp', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '));
    for (const [file, name] of [
      ['/work/a.jpg', 'JPEG'],
      ['/work/a.webp', 'WebP'],
    ] as const) {
      const e = await rejection(
        registry.execute('convert.imageToSprite', { file, height: 8 }, run),
      );
      expect(e.code).toBe('REFUSED');
      expect(e.message).toContain(name);
      expect(e.message).toContain('convert the image to PNG first');
    }
    expect(host.list()).toHaveLength(0);
  });

  it('refuses a path outside the roots, a missing file and a file that is not an image', async () => {
    const { fs, run } = convertHost();
    fs.seed('/work/note.txt', new TextEncoder().encode('hello'));
    const outside = await rejection(
      registry.execute('convert.imageToSprite', { file: '/etc/art.png', height: 8 }, run),
    );
    expect(outside.code).toBe('NOT_ALLOWED');
    const missing = await rejection(
      registry.execute('convert.imageToSprite', { file: '/work/none.png', height: 8 }, run),
    );
    expect(missing.code).toBe('IO_FAILED');
    const text = await rejection(
      registry.execute('convert.imageToSprite', { file: '/work/note.txt', height: 8 }, run),
    );
    expect(text.code).toBe('REFUSED');
  });

  it('reports bad input in terms of the fields', async () => {
    const { fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(4, 0));
    const call = (input: Record<string, unknown>): Promise<{ code: string; message: string }> =>
      rejection(
        registry.execute('convert.imageToSprite', { file: '/work/art.png', ...input }, run),
      );
    expect((await call({ recipe: { version: 1 }, width: 2 })).code).toBe('BAD_INPUT');
    expect((await call({ grid: 'auto', width: 2 })).code).toBe('BAD_INPUT');
    expect((await call({ method: 'box' })).code).toBe('BAD_INPUT');
    const preset = await call({ width: 2, palette: 'nope' });
    expect(preset.code).toBe('BAD_INPUT');
    expect(preset.message).toContain('pico-8');
    expect((await call({ recipe: { version: 2 } })).code).toBe('BAD_INPUT');
    expect((await call({ crop: [0, 0, 99, 99] })).code).toBe('BAD_INPUT');
    // an enlargement is refused by the downscale step
    expect((await call({ width: 99 })).code).toBe('BAD_INPUT');
  });

  it('refuses a missing grid with a REFUSED that says what to do', async () => {
    const { fs, run } = convertHost();
    // a smooth gradient has no pixel grid
    const data = new Uint8Array(24 * 24 * 4);
    for (let i = 0; i < 24 * 24; i++)
      data.set([(i % 24) * 10, ((i / 24) | 0) * 10, 90, 255], i * 4);
    fs.seed('/work/grad.png', encodePng({ width: 24, height: 24, data, kind: 'rgba' }));
    const e = await rejection(
      registry.execute('convert.imageToSprite', { file: '/work/grad.png', grid: 'auto' }, run),
    );
    expect(e.code).toBe('REFUSED');
    expect(e.message).toContain('size target');
  });

  it('accepts a full recipe', async () => {
    const { host, fs, run } = convertHost();
    fs.seed('/work/art.png', artPng(6, 0));
    const out = (await registry.execute(
      'convert.imageToSprite',
      {
        file: '/work/art.png',
        recipe: { version: 1, downscale: { method: 'nearest', width: 2, height: 2 } },
      },
      run,
    )) as SpriteOut;
    expect(out.canvas).toEqual({ w: 2, h: 2 });
    expect(host.list()).toHaveLength(1);
  });
});

describe('convert.apply', () => {
  const FRAME = { animation: { group: 'idle' }, frame: 0, layer: 'bg' } as const;

  /** An 8x6 cel: a red 4x3 block top-left and a green 2x2 block, rest transparent. */
  const paint = (img: TiledImage): void => {
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) img.set(x, y, [...RED]);
    for (let y = 4; y < 6; y++) for (let x = 5; x < 7; x++) img.set(x, y, [...GREEN]);
    img.set(7, 0, [250, 10, 10, 255]);
  };

  it('replaces the cel (same size) in one undo step, and undo restores it', async () => {
    const { hosted, run } = await openFlat({ paint });
    const before = documentHash(hosted.store);
    const out = (await registry.execute(
      'convert.apply',
      {
        doc: hosted.id,
        ...FRAME,
        palette: ['#ff0000', '#0000ff'],
        clean: false,
      },
      run,
    )) as { layer: string; size: { w: number; h: number }; palette: { colors: number } };
    expect(out).toMatchObject({ layer: 'bg', size: { w: 8, h: 6 }, palette: { colors: 2 } });
    expect(stepLabels(hosted)).toEqual(['AI: convert.apply']);
    const cel = need(hosted.store.doc.layers[0]);
    if (cel.kind !== 'pixel') throw new Error('layer kind');
    const link = need(cel.cels[firstFrame(hosted.store.doc)]);
    if ('linkTo' in link) throw new Error('link');
    const img = need(hosted.store.image(link.imageId)) as TiledImage;
    // green is not in the palette: it snaps to the nearer of red and blue (OKLab distance green-red 0.51, green-blue 0.68: red)
    expect([...img.get(0, 0)]).toEqual([...RED]);
    expect([...img.get(5, 4)]).toEqual([...RED]);
    expect([...img.get(3, 5)]).toEqual([0, 0, 0, 0]);
    // the near-red pixel snapped to the palette red
    expect([...img.get(7, 0)]).toEqual([...RED]);
    const result = await registry.execute('doc.undo', { doc: hosted.id }, run);
    expect(result).toBeTruthy();
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('uses the active palette of the document by default', async () => {
    const { hosted, run } = await openFlat({ paint, paletteLocked: true });
    const out = (await registry.execute(
      'convert.apply',
      { doc: hosted.id, ...FRAME, dither: 'none' },
      run,
    )) as { palette: { name: string; colors: number } };
    expect(out.palette).toEqual({ name: 'Base', colors: 4 });
  });

  it('adds a layer for a smaller result, aligned to the origin; undo removes it', async () => {
    const { hosted, run } = await openFlat({ paint });
    const before = documentHash(hosted.store);
    const out = (await registry.execute(
      'convert.apply',
      { doc: hosted.id, ...FRAME, width: 4, method: 'nearest', newLayer: 'small' },
      run,
    )) as { layer: string; size: { w: number; h: number } };
    expect(out).toMatchObject({ layer: 'small', size: { w: 4, h: 3 } });
    const doc = hosted.store.doc;
    expect(doc.layers.map((l) => l.name)).toEqual(['bg', 'small']);
    const small = need(doc.layers[1]);
    if (small.kind !== 'pixel') throw new Error('layer kind');
    const cel = need(small.cels[firstFrame(doc)]);
    if ('linkTo' in cel) throw new Error('link');
    // bottom-centre of the 4x3 result on the origin (0, 5): x = 0 - 2, y = 5 - 2
    expect(cel.offset).toEqual({ x: -2, y: 3 });
    expect(stepLabels(hosted)).toEqual(['AI: convert.apply']);
    await registry.execute('doc.undo', { doc: hosted.id }, run);
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('refuses a result of another size when replacing, and a layer name in use', async () => {
    const { hosted, run } = await openFlat({ paint });
    const before = documentHash(hosted.store);
    const size = await rejection(
      registry.execute('convert.apply', { doc: hosted.id, ...FRAME, width: 4 }, run),
    );
    expect(size.code).toBe('REFUSED');
    expect(size.details.reason).toBe('size-mismatch');
    const grow = await rejection(
      registry.execute(
        'convert.apply',
        { doc: hosted.id, ...FRAME, outline: true, newLayer: 'o' },
        run,
      ),
    );
    expect(grow.details.reason).toBe('larger-than-canvas');
    const used = await rejection(
      registry.execute(
        'convert.apply',
        { doc: hosted.id, ...FRAME, width: 4, newLayer: 'bg' },
        run,
      ),
    );
    expect(used.details.reason).toBe('layer-exists');
    expect(documentHash(hosted.store)).toBe(before);
    expect(stepLabels(hosted)).toEqual([]);
  });

  it('refuses colours outside a locked palette, and indexed documents', async () => {
    const locked = await openFlat({ paint, paletteLocked: true });
    const off = await rejection(
      registry.execute(
        'convert.apply',
        { doc: locked.hosted.id, ...FRAME, palette: ['#123456'] },
        locked.run,
      ),
    );
    expect(off.details.reason).toBe('off-palette');
    const indexed = await openFlat({ indexed: true });
    const e = await rejection(
      registry.execute('convert.apply', { doc: indexed.hosted.id, ...FRAME }, indexed.run),
    );
    expect(e.details.reason).toBe('indexed-document');
  });

  it('refuses a linked cel, an unknown layer and a recipe mixed with shortcuts', async () => {
    const { hosted, run } = await openFlat({ paint });
    const linked = await rejection(
      registry.execute(
        'convert.apply',
        { doc: hosted.id, animation: { group: 'idle' }, frame: 1, layer: 'bg' },
        run,
      ),
    );
    expect(linked.details.reason).toBe('linked-cel');
    const none = await rejection(
      registry.execute('convert.apply', { doc: hosted.id, ...FRAME, layer: 'nope' }, run),
    );
    expect(none.code).toBe('NOT_FOUND');
    const mixed = await rejection(
      registry.execute(
        'convert.apply',
        { doc: hosted.id, ...FRAME, recipe: { version: 1 }, dither: 'bayer4' },
        run,
      ),
    );
    expect(mixed.code).toBe('BAD_INPUT');
  });

  it('variants: a contact sheet in a NEW document, labels and tiles returned, source untouched', async () => {
    const { host, hosted, run } = await openFlat({ paint });
    const before = documentHash(hosted.store);
    const out = (await registry.execute(
      'convert.apply',
      {
        doc: hosted.id,
        ...FRAME,
        palette: ['#ff0000', '#00ff00', '#0000ff'],
        variants: { dither: ['none', 'bayer2', 'bayer4'] },
      },
      run,
    )) as {
      sheetDoc: DocId;
      size: { w: number; h: number };
      tiles: { label: string; x: number; y: number; w: number; h: number }[];
    };
    expect(out.tiles.map((t) => t.label)).toEqual([
      'dither=none',
      'dither=bayer2',
      'dither=bayer4',
    ]);
    for (const t of out.tiles) expect([t.w, t.h]).toEqual([8, 6]);
    // 3 tiles: 2 columns x 2 rows, gap 2
    expect(out.size).toEqual({ w: 2 + 2 * (8 + 2), h: 2 + 2 * (6 + 2) });
    expect(documentHash(hosted.store)).toBe(before);
    expect(stepLabels(hosted)).toEqual([]);
    const sheet = need(host.get(out.sheetDoc));
    expect(sheet.store.doc.layers.map((l) => l.name)).toEqual(['variants']);
    // the first tile holds the "none" result: the red block is at its position on the sheet
    const px = layerPixels(host, out.sheetDoc, 'variants');
    const t0 = need(out.tiles[0]);
    expect(px[t0.y]?.[t0.x]).toEqual([...RED]);
  });

  it('caps the number of variants', async () => {
    const { hosted, run } = await openFlat({ paint });
    const e = await rejection(
      registry.execute(
        'convert.apply',
        {
          doc: hosted.id,
          ...FRAME,
          width: 4,
          variants: {
            method: ['box', 'kcentroid', 'nearest', 'mode'],
            dither: ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'],
            palette: [
              'pico-8',
              'nintendo-entertainment-system',
              'nintendo-gameboy-bgb',
              'endesga-32',
              'resurrect-64',
              'aap-64',
              'sweetie-16',
            ],
          },
        },
        run,
      ),
    );
    expect(e.code).toBe('REFUSED');
  });
});
