import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from '@pixel-forge/core';
import { TiledImage, hashRGBA } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import {
  createDocumentFromGif,
  createEmptyDocumentStore,
  gifLoopMode,
  importGifTx,
} from '../src/index.js';
import { buildGif } from './gif-builder.js';
import type { Rgb } from './gif-builder.js';
import { ioCode, need } from './helpers.js';

const dir = fileURLToPath(new URL('../../../fixtures/gif/', import.meta.url));
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(dir + name));
const expected = JSON.parse(readFileSync(dir + 'pil_expected.json', 'utf8')) as Record<
  string,
  { hashes: string[]; durationsMs: number[] }
>;

const A: Rgb = [200, 10, 10];
const B: Rgb = [10, 200, 10];

describe('createDocumentFromGif', () => {
  it('makes a canvas of the GIF size and one frame per GIF frame with the delays kept', () => {
    const { store, result } = createDocumentFromGif({
      gif: file('imageio_anim.gif'),
      group: 'spin',
    });
    const doc = store.doc;
    expect(doc.meta.canvas).toEqual({ w: 20, h: 16 });
    expect(doc.meta.origin).toEqual({ x: 10, y: 15 });
    expect(result).toMatchObject({ frames: 4, imageCels: 4, size: { w: 20, h: 16 }, warnings: [] });
    const anim = doc.animations[0];
    expect(anim?.group).toBe('spin');
    expect(anim && 'frames' in anim ? anim.frames.map((f) => f.durationMs) : []).toEqual([
      100, 200, 50, 500,
    ]);
    expect(anim).toMatchObject({ loop: 'loop' }); // NETSCAPE2.0 count 0: forever
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('stores the composed frames as the cel images (pinned hashes from the generator scene)', () => {
    const { store } = createDocumentFromGif({ gif: file('pil_sprite_disposal2.gif') });
    const layer = store.doc.layers[0];
    const anim = store.doc.animations[0];
    if (layer?.kind !== 'pixel' || !anim || !('frames' in anim)) throw new Error('shape');
    const hashes = anim.frames.map((f) => {
      const cel = layer.cels[f.id];
      if (!cel || !('imageId' in cel)) throw new Error('no image cel');
      expect(cel.offset).toEqual({ x: 0, y: 0 }); // GIF size = canvas: bottom-centre on the origin
      const img = store.image(cel.imageId);
      if (!(img instanceof TiledImage)) throw new Error('not an RGBA image');
      return hashRGBA(img.toRGBA());
    });
    expect(hashes).toEqual(expected.pil_sprite_disposal2?.hashes);
  });

  it('is one undoable step "Import GIF"', () => {
    const { store } = createDocumentFromGif({ gif: file('pil_opaque.gif') });
    expect(store.historyInfo().entries.map((e) => e.label)).toEqual(['Import GIF']);
    store.undo();
    expect(store.doc.animations).toEqual([]);
  });

  it('a GIF that plays once becomes loop mode "once"; an explicit loop wins', () => {
    expect(gifLoopMode(undefined)).toBe('once');
    expect(gifLoopMode(0)).toBe('loop');
    const once = createDocumentFromGif({ gif: file('sips_static.gif') });
    expect(once.store.doc.animations[0]).toMatchObject({ loop: 'once' });
    const forced = createDocumentFromGif({ gif: file('sips_static.gif'), loop: 'pingpong' });
    expect(forced.store.doc.animations[0]).toMatchObject({ loop: 'pingpong' });
  });

  it('warns about a finite repeat count and about delay 0', () => {
    const gif = buildGif({
      width: 2,
      height: 1,
      palette: [A, B],
      loop: 3,
      frames: [
        { w: 2, h: 1, indices: [0, 1], gce: { delayCs: 0 } },
        { w: 2, h: 1, indices: [1, 0], gce: { delayCs: 4 } },
      ],
    });
    const { store, result } = createDocumentFromGif({ gif, zeroDelayMs: 50 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('repeats 3 times');
    expect(result.warnings[1]).toContain('1 frame(s) had delay 0; they got 50 ms');
    const anim = store.doc.animations[0];
    expect(anim && 'frames' in anim ? anim.frames.map((f) => f.durationMs) : []).toEqual([50, 40]);
  });

  it('a fully transparent frame has no cel and a repeated frame links to the first', () => {
    const gif = buildGif({
      width: 2,
      height: 1,
      palette: [A, B],
      frames: [
        { w: 2, h: 1, indices: [0, 1], gce: { disposal: 2, delayCs: 1 } },
        { w: 2, h: 1, indices: [1, 1], gce: { transparent: 1, delayCs: 1 } }, // all transparent, A cleared
        { w: 2, h: 1, indices: [0, 1], gce: { disposal: 2, delayCs: 1 } },
      ],
    });
    const { store, result } = createDocumentFromGif({ gif });
    expect(result.imageCels).toBe(1);
    const layer = store.doc.layers[0];
    const anim = store.doc.animations[0];
    if (layer?.kind !== 'pixel' || !anim || !('frames' in anim)) throw new Error('shape');
    const ids = anim.frames.map((f) => f.id);
    const cel = (i: number) => layer.cels[need(ids[i])];
    expect(cel(0)).toHaveProperty('imageId');
    expect(cel(1)).toBeUndefined();
    expect(cel(2)).toEqual({ linkTo: ids[0] });
    expect(validate(store).filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('importGifTx', () => {
  it('adds an animation to an existing document: reuses the layer, places by the origin, warns on a size mismatch', () => {
    const store = createEmptyDocumentStore([8, 8], { origin: { x: 4, y: 7 } });
    const gif = buildGif({
      width: 2,
      height: 2,
      palette: [A, B],
      frames: [{ w: 2, h: 2, indices: [0, 1, 1, 0] }],
    });
    const r1 = store.transact('first', (tx) => importGifTx(tx, { gif, group: 'one' }));
    const r2 = store.transact('second', (tx) => importGifTx(tx, { gif, group: 'two' }));
    expect(r1.warnings.join('\n')).toContain('2x2 and the canvas is 8x8');
    expect(r1.layer).toBe(r2.layer);
    expect(store.doc.layers).toHaveLength(1);
    const layer = store.doc.layers[0];
    if (layer?.kind !== 'pixel') throw new Error('shape');
    const cels = Object.values(layer.cels);
    // bottom-centre pixel (floor(2/2), 2-1) = (1, 1) lands on the origin (4, 7): offset (3, 6)
    expect(cels.map((c) => ('offset' in c ? c.offset : null))).toEqual([
      { x: 3, y: 6 },
      { x: 3, y: 6 },
    ]);
  });

  it('refuses bad names, an existing animation and a bad GIF; the document stays as it was', () => {
    const store = createEmptyDocumentStore([2, 2]);
    const gif = buildGif({
      width: 2,
      height: 2,
      palette: [A, B],
      frames: [{ w: 2, h: 2, indices: [0, 1, 1, 0] }],
    });
    store.transact('ok', (tx) => importGifTx(tx, { gif }));
    const steps = store.historyInfo().entries.length;
    const attempt = (input: Parameters<typeof importGifTx>[1]): string | undefined => {
      const tx = store.begin('x');
      try {
        return ioCode(() => importGifTx(tx, input));
      } finally {
        tx.cancel();
      }
    };
    expect(attempt({ gif })).toBe('DUPLICATE_ANIMATION');
    expect(attempt({ gif, group: 'Bad Name' })).toBe('BAD_INPUT');
    expect(attempt({ gif, group: 'ok', layerName: 'No Good' })).toBe('BAD_INPUT');
    expect(attempt({ gif: gif.subarray(0, 20), group: 'ok' })).toBe('BAD_GIF');
    expect(attempt({ gif, group: 'ok', limits: { maxFrames: 0 } })).toBe('TOO_LARGE');
    expect(store.historyInfo().entries).toHaveLength(steps);
    expect(store.doc.animations).toHaveLength(1);
  });

  it('createDocumentFromGif leaves nothing behind when the GIF is bad', () => {
    expect(ioCode(() => createDocumentFromGif({ gif: new Uint8Array(3) }))).toBe('BAD_GIF');
  });
});
