import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocumentStore, renderFrame } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { Document, RenderIndex } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import {
  IoError,
  PIXEL_FORGE_VERSION,
  buildPxf,
  canonicalPretty,
  createDocumentFromSpritesheet,
  fixedClock,
  pxfStore,
  pxfView,
  readPxf,
  steppedClock,
  writePxf,
} from '../src/index.js';
import { bytesEqual, heroDocument, ioCode, need, pngFromRows } from './helpers.js';
import { fakeRig, frozenStore, frozenText, opts } from './pxf-helpers.js';

const T0 = '2026-10-27T10:00:00Z';

describe('canonical JSON', () => {
  it('reproduces the frozen v1 fixture text exactly', () => {
    const doc = Document.parse(JSON.parse(frozenText()));
    expect(canonicalPretty(doc)).toBe(frozenText());
  });

  it('sorts keys (including integer-like ones) and rejects non-JSON', () => {
    expect(canonicalPretty({ b: 1, a: [], c: {}, 10: 1, 2: 2, u: undefined })).toBe(
      '{\n  "10": 1,\n  "2": 2,\n  "a": [],\n  "b": 1,\n  "c": {}\n}\n',
    );
    expect(ioCode(() => canonicalPretty({ a: Infinity }))).toBe('BAD_INPUT');
    expect(ioCode(() => canonicalPretty({ a: () => 1 }))).toBe('BAD_INPUT');
  });
});

describe('package version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(PIXEL_FORGE_VERSION).toBe(pkg.version);
  });
});

describe('read -> write is byte-identical (NFR-03)', () => {
  for (const renderCache of [false, true]) {
    it(`frozen v1 fixture document, renderCache ${String(renderCache)}`, () => {
      const store = frozenStore();
      const bytes = writePxf(store, opts({ renderCache }));
      const file = readPxf(bytes);
      expect(file.warnings).toEqual([]);
      expect(file.renderIndex !== undefined).toBe(renderCache);
      const store2 = pxfStore(file);
      // With `previous` (the normal save of an opened file) ...
      expect(bytesEqual(writePxf(store2, opts({ renderCache, previous: file })), bytes)).toBe(true);
      // ... and from scratch with the same clock reading.
      expect(bytesEqual(writePxf(store2, opts({ renderCache })), bytes)).toBe(true);
      expect(bytesEqual(writePxf(store, opts({ renderCache })), bytes)).toBe(true);
    });
  }

  it('reads back the frozen document and the images', () => {
    const store = frozenStore();
    const file = readPxf(writePxf(store, opts({ renderCache: false })));
    expect(file.doc).toEqual(store.doc);
    expect([...file.images.keys()]).toEqual([...store.imageIds()]);
    for (const id of store.imageIds()) {
      const a = file.images.get(id);
      const b = store.image(id);
      expect(a).toBeInstanceOf(IndexedImage);
      expect(a instanceof IndexedImage && b instanceof IndexedImage && a.toIndices()).toEqual(
        b instanceof IndexedImage && b.toIndices(),
      );
    }
  });

  it('CC0 hero document (spritesheet import), with the full render cache', () => {
    const store = heroDocument();
    const { bytes, file, renderedFrames } = buildPxf(store, { clock: fixedClock(T0) });
    expect(renderedFrames).toBeGreaterThan(0);
    const read = readPxf(bytes);
    expect(read.doc).toEqual(store.doc);
    const again = writePxf(pxfStore(read), { clock: fixedClock(T0), previous: read });
    expect(bytesEqual(again, bytes)).toBe(true);
    expect(bytesEqual(writePxf(pxfStore(read), { clock: fixedClock(T0) }), bytes)).toBe(true);
    expect(file.renderPngs.size).toBe(read.renderPngs.size);
  });

  it('RGBA images round trip pixel for pixel', () => {
    const { store } = createDocumentFromSpritesheet({
      png: pngFromRows(['rg..', '..bg'], {
        r: [255, 0, 0, 255],
        g: [0, 255, 0, 128],
        b: [0, 0, 255, 255],
      }),
      cell: [2, 2],
      animations: [
        {
          group: 'a',
          frames: [
            [0, 0],
            [0, 1],
          ],
        },
      ],
    });
    const file = readPxf(writePxf(store, opts({ renderCache: false })));
    for (const id of store.imageIds()) {
      const a = file.images.get(id);
      const b = store.image(id);
      expect(a).toBeInstanceOf(TiledImage);
      expect(a instanceof TiledImage && a.toRGBA()).toEqual(b instanceof TiledImage && b.toRGBA());
    }
  });
});

describe('manifest: created / modified', () => {
  it('first save stamps both with the clock (UTC, Z, whole seconds)', () => {
    const file = readPxf(
      writePxf(heroDocument(), {
        clock: fixedClock('2026-10-27T10:00:00.789Z'),
        renderCache: false,
      }),
    );
    expect(file.manifest.created).toBe(T0);
    expect(file.manifest.modified).toBe(T0);
    expect(file.manifest.app).toBe(`pixel-forge ${PIXEL_FORGE_VERSION}`);
  });

  it('a no-op save keeps modified; a content change updates it; created stays', () => {
    const clock = steppedClock('2026-01-01T00:00:00Z', 60_000);
    const store = heroDocument();
    const first = buildPxf(store, { clock, renderCache: false });
    expect(first.changed).toBe(true);
    expect(first.file.manifest.created).toBe('2026-01-01T00:00:00Z');

    const noop = buildPxf(store, { clock, renderCache: false, previous: first.file });
    expect(noop.changed).toBe(false);
    expect(noop.file.manifest.modified).toBe('2026-01-01T00:00:00Z');
    expect(bytesEqual(noop.bytes, first.bytes)).toBe(true);

    // Opened from disk: the same.
    const opened = readPxf(first.bytes);
    const noop2 = buildPxf(pxfStore(opened), { clock, renderCache: false, previous: opened });
    expect(noop2.changed).toBe(false);
    expect(bytesEqual(noop2.bytes, first.bytes)).toBe(true);

    store.transact('Rename', (tx) => {
      tx.update((d) => {
        d.meta.name = 'renamed';
      });
    });
    const edited = buildPxf(store, { clock, renderCache: false, previous: first.file });
    expect(edited.changed).toBe(true);
    expect(edited.file.manifest.created).toBe('2026-01-01T00:00:00Z');
    expect(edited.file.manifest.modified).toBe('2026-01-01T00:01:00Z');

    // A pixel-only change counts too.
    const id = need(store.imageIds()[0]);
    store.transact('Paint', (tx) => {
      tx.writeImage(id, (img) => {
        if (img instanceof TiledImage) img.set(0, 0, [1, 2, 3, 255]);
      });
    });
    const painted = buildPxf(store, { clock, renderCache: false, previous: edited.file });
    expect(painted.changed).toBe(true);
    expect(painted.file.manifest.modified).toBe('2026-01-01T00:02:00Z');
  });

  it('toggling the render cache alone does not touch modified', () => {
    const store = heroDocument();
    const clock = steppedClock('2026-01-01T00:00:00Z', 60_000);
    const a = buildPxf(store, { clock, renderCache: false });
    const b = buildPxf(store, { clock, renderCache: true, previous: a.file });
    expect(b.file.manifest.modified).toBe(a.file.manifest.modified);
    expect(b.file.renderIndex).toBeDefined();
  });

  it('rejects a clock that returns an invalid date', () => {
    expect(() =>
      writePxf(heroDocument(), { clock: { now: () => new Date(NaN) }, renderCache: false }),
    ).toThrow(RangeError);
  });
});

describe('render cache', () => {
  function decodeCache(file: ReturnType<typeof readPxf>, skin: string, image: string) {
    return decodePng(need(file.renderPngs.get(`${skin}/${image}`)));
  }

  it('equals renderFrame for every frame, direction and skin (CC0 hero)', () => {
    const store = heroDocument();
    const file = readPxf(writePxf(store, opts()));
    const index = RenderIndex.parse(file.renderIndex);
    expect(index.skins).toEqual(['base']);
    let frames = 0;
    for (const [group, dirs] of Object.entries(index.animations)) {
      for (const [dir, anim] of Object.entries(dirs)) {
        if (!('frames' in anim)) continue;
        const ref = store.doc.animations.find(
          (a) => a.group === group && (a.direction ?? 'default') === dir,
        );
        anim.frames.forEach((f, i) => {
          const png = decodeCache(file, 'base', f.image);
          const want = renderFrame(store, { id: need(ref).id }, i, { exportOnly: true }).toRGBA();
          expect(png.width).toBe(want.width);
          expect(bytesEqual(png.data, want.data)).toBe(true);
          frames++;
        });
      }
    }
    expect(frames).toBeGreaterThan(10);
  });

  it('equals renderFrame for the frozen fixture under base and the "rival" skin (part layers via rig)', () => {
    const store = frozenStore();
    const file = readPxf(writePxf(store, opts()));
    const index = RenderIndex.parse(file.renderIndex);
    expect(index.skins).toEqual(['base', 'rival']);
    expect(index.origin).toEqual({ x: 16, y: 30 });
    expect(index.pixelsPerUnit).toBe(16);
    expect(index.directionFallback).toEqual({ down: ['down', 'right'], up: ['up', 'right'] });
    const right = index.animations.run?.right;
    if (right === undefined || !('frames' in right)) throw new Error('run/right missing');
    expect(right.frames.map((f) => f.id)).toEqual(['frm_01gzt6', 'frm_5x5f6x']);
    expect(right.frames[0]?.markers).toEqual({ ball: { x: 24, y: 22 }, hand_r: { x: 19, y: 20 } });
    expect(right.frames[0]?.rootMotion).toEqual({ dx: 2, dy: 0 });
    expect(right.frames[0]?.events).toEqual(['footstep']);
    expect(right.frames[1]?.durationMs).toBe(150);
    const anim = need(store.doc.animations.find((a) => a.direction === 'right'));
    right.frames.forEach((f, i) => {
      for (const skin of ['base', 'rival']) {
        const png = decodeCache(file, skin, f.image);
        const want = renderFrame(store, { id: anim.id }, i, {
          exportOnly: true,
          skin: skin === 'base' ? 'base' : { name: skin },
          rig: fakeRig,
        }).toRGBA();
        expect(bytesEqual(png.data, want.data)).toBe(true);
      }
    });
    // The skin really changes pixels, so the two PNG sets differ.
    const first = need(right.frames[0]);
    expect(
      bytesEqual(
        need(file.renderPngs.get(`base/${first.image}`)),
        need(file.renderPngs.get(`rival/${first.image}`)),
      ),
    ).toBe(false);
  });

  it('a skins option restricts the skins; unknown names are rejected', () => {
    const store = frozenStore();
    expect(readPxf(writePxf(store, opts({ skins: [] }))).renderIndex?.skins).toEqual(['base']);
    expect(readPxf(writePxf(store, opts({ skins: ['rival', 'base'] }))).renderIndex?.skins).toEqual(
      ['base', 'rival'],
    );
    expect(ioCode(() => writePxf(store, opts({ skins: ['nope'] })))).toBe('BAD_INPUT');
  });

  it('a mirror WITH overrides is a normal entry with mirrored markers; WITHOUT is mirrorOf', () => {
    const store = frozenStore();
    const index = RenderIndex.parse(readPxf(writePxf(store, opts())).renderIndex);
    const left = index.animations.run?.left;
    if (left === undefined || !('frames' in left)) throw new Error('left should be a full entry');
    expect(left.loop).toBe('loop');
    expect(left.frames.map((f) => f.id)).toEqual(['frm_01gzt6', 'frm_5x5f6x']);
    // x' = 2 * origin.x - x = 32 - 24
    expect(left.frames[0]?.markers.ball).toEqual({ x: 8, y: 22 });
    expect(left.frames[0]?.hash).not.toBe(
      (index.animations.run?.right as { frames: { hash: string }[] }).frames[0]?.hash,
    );

    const mirror = need(store.doc.animations.find((a) => 'mirrorOf' in a));
    store.transact('Drop mirror overrides', (tx) => {
      tx.update((d) => {
        const m = d.animations.find((a) => a.id === mirror.id);
        if (m) m.overrides = [];
      });
    });
    const file = readPxf(writePxf(store, opts()));
    expect(file.renderIndex?.animations.run?.left).toEqual({ loop: 'loop', mirrorOf: 'right' });
    expect([...file.renderPngs.keys()].some((k) => k.includes('/left/'))).toBe(false);
  });

  it('frames with equal hashes share one PNG path', () => {
    const { store } = createDocumentFromSpritesheet({
      png: pngFromRows(['aab.', 'a...'], { a: [255, 0, 0, 255], b: [0, 0, 255, 255] }),
      cell: [1, 1],
      animations: [
        {
          group: 'blink',
          frames: [
            [0, 0],
            [0, 1],
            [0, 2],
            [0, 0],
          ],
        },
        { group: 'other', frames: [[0, 0]] },
      ],
    });
    const file = readPxf(writePxf(store, opts()));
    const blink = file.renderIndex?.animations.blink?.default;
    if (blink === undefined || !('frames' in blink)) throw new Error('no blink');
    const images = blink.frames.map((f) => f.image);
    expect(images[1]).toBe(images[0]);
    expect(images[2]).toBe('blink/default/2.png');
    expect(images[3]).toBe(images[0]);
    expect(file.renderIndex?.animations.other?.default).toMatchObject({
      frames: [{ image: images[0] }],
    });
    expect(file.renderPngs.size).toBe(2);
  });

  it('exports only export layers', () => {
    const store = heroDocument();
    const layer = need(store.doc.layers[0]);
    store.transact('Hide from export', (tx) => {
      tx.update((d) => {
        const l = d.layers.find((x) => x.id === layer.id);
        if (l) l.export = false;
      });
    });
    const file = readPxf(writePxf(store, opts()));
    const first = file.renderIndex?.animations;
    const anyAnim = Object.values(need(first))[0];
    const f = Object.values(need(anyAnim))[0];
    if (f === undefined || !('frames' in f)) throw new Error('no frames');
    const png = decodeCache(file, 'base', need(f.frames[0]).image);
    expect(png.data.every((b) => b === 0)).toBe(true);
  });

  it('incremental save reuses unchanged frames and re-renders changed ones', () => {
    const store = heroDocument();
    const first = buildPxf(store, { clock: fixedClock(T0) });
    expect(first.reusedFrames).toBe(0);
    const total = first.renderedFrames;
    expect(total).toBeGreaterThan(10);

    // Nothing changed: everything reused.
    const noop = buildPxf(store, { clock: fixedClock(T0), previous: first.file });
    expect(noop.renderedFrames).toBe(0);
    expect(noop.reusedFrames).toBe(total);
    expect(bytesEqual(noop.bytes, first.bytes)).toBe(true);

    // Poison the previous bytes of one frame: a reused frame must carry the poisoned bytes through,
    // proving the PNG came from `previous` and was not re-rendered.
    const idx = need(first.file.renderIndex);
    const anyAnim = need(Object.values(need(Object.values(idx.animations)[0]))[0]);
    if (!('frames' in anyAnim)) throw new Error('no frames');
    const key = `base/${need(anyAnim.frames[0]).image}`;
    const poisoned = new Map(first.file.renderPngs);
    poisoned.set(key, new Uint8Array([1, 2, 3]));
    const prev = { ...first.file, renderPngs: poisoned };
    const reuse = buildPxf(store, { clock: fixedClock(T0), previous: prev });
    expect(Array.from(need(reuse.file.renderPngs.get(key)))).toEqual([1, 2, 3]);

    // Edit one cel image: only the frames that draw it are re-rendered.
    const animId = need(store.doc.animations[0]).id;
    const body = need(
      store.doc.layers.find((l) => l.kind === 'pixel' && Object.keys(l.cels).length > 0),
    );
    const cel = Object.values(body.kind === 'pixel' ? body.cels : {}).find((c) => 'imageId' in c);
    const imageId = need(cel && 'imageId' in cel ? cel.imageId : undefined);
    store.transact('Paint', (tx) => {
      tx.writeImage(imageId, (img) => {
        if (img instanceof TiledImage) img.set(1, 1, [9, 9, 9, 255]);
      });
    });
    const edited = buildPxf(store, { clock: fixedClock(T0), previous: first.file });
    expect(edited.renderedFrames).toBeGreaterThan(0);
    expect(edited.renderedFrames).toBeLessThan(total);
    expect(edited.renderedFrames + edited.reusedFrames).toBeLessThanOrEqual(total);
    // Still equal to a from-scratch render.
    const scratch = buildPxf(store, { clock: fixedClock(T0) });
    expect(bytesEqual(edited.bytes, scratch.bytes)).toBe(true);
    expect(animId).toBeDefined();
  });

  it('needs a rig renderer for part layers (RIG_REQUIRED) unless the cache is off', () => {
    const store = frozenStore();
    expect(ioCode(() => writePxf(store, { clock: fixedClock(T0) }))).toBe('RIG_REQUIRED');
    expect(() => writePxf(store, { clock: fixedClock(T0), renderCache: false })).not.toThrow();
  });

  it('rejects a mirror whose source is not authored in its group', () => {
    const store = frozenStore();
    const mirror = need(store.doc.animations.find((a) => 'mirrorOf' in a));
    store.transact('Break', (tx) => {
      tx.update((d) => {
        const m = d.animations.find((a) => a.id === mirror.id);
        if (m) m.group = 'walk';
      });
    });
    expect(ioCode(() => writePxf(store, opts()))).toBe('BAD_INPUT');
  });

  it('rejects duplicate (group, direction)', () => {
    const store = frozenStore();
    store.transact('Dup', (tx) => {
      tx.update((d) => {
        const m = d.animations.find((a) => 'mirrorOf' in a);
        if (m) m.direction = 'right';
      });
    });
    expect(ioCode(() => writePxf(store, opts()))).toBe('BAD_INPUT');
  });

  it('a snapshot can be written like a store', () => {
    const store = heroDocument();
    const snap = store.snapshot();
    expect(bytesEqual(writePxf(snap, opts()), writePxf(store, opts()))).toBe(true);
    expect(pxfView(readPxf(writePxf(snap, opts({ renderCache: false })))).imageIds()).toEqual(
      snap.imageIds(),
    );
  });
});

describe('readPxf errors', () => {
  const good = () => writePxf(frozenStore(), opts({ renderCache: false }));

  it('rejects non-ZIP bytes', () => {
    expect(ioCode(() => readPxf(new Uint8Array([1, 2, 3, 4])))).toBe('BAD_PXF');
    expect(ioCode(() => readPxf(new Uint8Array(0)))).toBe('BAD_PXF');
  });

  it('rejects a missing manifest, bad JSON and bad shapes', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const mk = (files: Record<string, string>) =>
      zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    expect(ioCode(() => readPxf(mk({ 'document.json': '{}' })))).toBe('BAD_PXF');
    expect(ioCode(() => readPxf(mk({ 'manifest.json': '{', 'document.json': '{}' })))).toBe(
      'BAD_PXF',
    );
    expect(ioCode(() => readPxf(mk({ 'manifest.json': '[]', 'document.json': '{}' })))).toBe(
      'BAD_PXF',
    );
    expect(
      ioCode(() =>
        readPxf(
          mk({
            'manifest.json': '{"schemaVersion":1}',
            'document.json': '{"meta":{"schemaVersion":2}}',
          }),
        ),
      ),
    ).toBe('BAD_PXF');
    expect(
      ioCode(() =>
        readPxf(mk({ 'manifest.json': '{"schemaVersion":"1"}', 'document.json': '{}' })),
      ),
    ).toBe('BAD_PXF');
  });

  it('reports schema errors with paths', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const files = { ...(await import('fflate')).unzipSync(good()) };
    const doc = JSON.parse(frozenText()) as { meta: { canvas: { w: number } } };
    doc.meta.canvas.w = -1;
    files['document.json'] = strToU8(JSON.stringify(doc));
    try {
      readPxf(zipSync(files));
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(IoError);
      expect((e as IoError).code).toBe('INVALID_DOCUMENT');
      expect((e as IoError).message).toContain('meta.canvas.w');
      expect((e as IoError).cause).toBeDefined();
    }
    const m = JSON.parse(strFrom(files['manifest.json'])) as Record<string, unknown>;
    m.format = 'zip';
    files['manifest.json'] = strToU8(JSON.stringify(m));
    files['document.json'] = strToU8(frozenText());
    expect(ioCode(() => readPxf(zipSync(files)))).toBe('INVALID_DOCUMENT');
  });

  it('rejects a missing, misnamed or corrupt image and unsafe paths', async () => {
    const { zipSync, unzipSync, strToU8 } = await import('fflate');
    const files = unzipSync(good());
    const imgPath = need(Object.keys(files).find((k) => k.startsWith('images/')));
    const { [imgPath]: removed, ...without } = files;
    expect(removed).toBeDefined();
    expect(ioCode(() => readPxf(zipSync(without)))).toBe('BAD_PXF');
    expect(ioCode(() => readPxf(zipSync({ ...files, 'images/readme.txt': strToU8('x') })))).toBe(
      'BAD_PXF',
    );
    expect(ioCode(() => readPxf(zipSync({ ...files, [imgPath]: strToU8('not a png') })))).toBe(
      'BAD_PXF',
    );
    expect(ioCode(() => readPxf(zipSync({ ...files, '../evil': strToU8('x') })))).toBe('BAD_PXF');
  });

  it('ignores unknown top-level entries and drops a broken render cache with a warning', async () => {
    const { zipSync, unzipSync, strToU8 } = await import('fflate');
    const files = unzipSync(writePxf(frozenStore(), opts()));
    const ok = readPxf(zipSync({ ...files, 'extra/notes.txt': strToU8('hi') }));
    expect(ok.renderIndex).toBeDefined();
    const bad = readPxf(zipSync({ ...files, 'render/index.json': strToU8('{"schemaVersion":1}') }));
    expect(bad.renderIndex).toBeUndefined();
    expect(bad.renderPngs.size).toBe(0);
    expect(bad.warnings.join()).toContain('render cache dropped');
    const worse = readPxf(zipSync({ ...files, 'render/index.json': strToU8('{') }));
    expect(worse.renderIndex).toBeUndefined();
    expect(worse.warnings).toHaveLength(1);
  });

  it('pxfStore gives an editable store that does not touch the file', () => {
    const file = readPxf(good());
    const store = pxfStore(file);
    expect(store).toBeInstanceOf(DocumentStore);
    store.transact('x', (tx) => {
      tx.update((d) => {
        d.meta.name = 'other';
      });
    });
    expect(file.doc.meta.name).toBe('hero');
  });
});

function strFrom(b: Uint8Array | undefined): string {
  return new TextDecoder().decode(b);
}
