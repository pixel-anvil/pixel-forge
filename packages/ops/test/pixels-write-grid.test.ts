// pixels.writeGrid: schema test, example test, read-then-write no-op, overrides on rig frames
// (hand-written ASCII expectations), flat cel writes, palette checks and refusals.
import { documentHash } from '@pixel-forge/core';
import type { DeepReadonly, DocumentStore } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Override } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { pixelsWriteGrid, registry } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const HERO_FRAME = { doc: HERO_ID, animation: { group: 'default' }, frame: 0 } as const;
const FLAT_FRAME = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 } as const;

/** Legend of the hero's head, as `pixels.readGrid` assigns it for columns 21..28 of rows 3..5. */
const HEAD_LEGEND = { '0': '#462d1e', '1': '#e8be96', '2': '#1e1e28' };

async function read(
  run: RunOptions,
  base: Record<string, unknown>,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<{ rows: string[]; legend: Record<string, string> }> {
  return (await registry.execute('pixels.readGrid', { ...base, x, y, width, height }, run)) as {
    rows: string[];
    legend: Record<string, string>;
  };
}

/** The overrides of the hero's first animation. */
function overridesOf(store: DocumentStore): readonly DeepReadonly<Override>[] {
  return need(store.doc.animations[0]).overrides;
}

/** An image as ASCII: `legend` maps "r,g,b,a" to a symbol; transparent is ".". */
function ascii(img: TiledImage, legend: Record<string, string>): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const c = img.get(x, y);
      row += c[3] === 0 ? '.' : (legend[c.join(',')] ?? '?');
    }
    rows.push(row);
  }
  return rows;
}

describe('pixels.writeGrid: input', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const missing = await rejection(registry.execute('pixels.writeGrid', HERO_FRAME, run));
    expect(missing.code).toBe('BAD_INPUT');
    expect(missing.details.issues).toEqual(
      expect.arrayContaining([{ path: 'rows', message: expect.any(String) as string }]),
    );
    const tall = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: Array.from({ length: 33 }, () => '.'), legend: {} },
        run,
      ),
    );
    expect(tall.details.issues).toEqual([{ path: 'rows', message: expect.any(String) as string }]);
    const wide = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: ['.'.repeat(33)], legend: {} },
        run,
      ),
    );
    expect(wide.details.issues).toEqual([
      { path: 'rows.0', message: expect.any(String) as string },
    ]);
    const badColour = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: ['1'], legend: { '1': 'red' } },
        run,
      ),
    );
    expect(badColour.details.issues).toEqual([
      { path: 'legend.1', message: expect.any(String) as string },
    ]);
  });

  it('reports ragged rows, unknown and reserved symbols', async () => {
    const { run } = await openHero();
    const ragged = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: ['11', '1'], legend: { '1': '#e8be96' } },
        run,
      ),
    );
    expect(ragged.code).toBe('BAD_INPUT');
    expect(ragged.details.issues).toEqual([
      { path: 'rows.1', message: expect.stringContaining('equally long') as string },
    ]);
    const unknown = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: ['1Q'], legend: { '1': '#e8be96' } },
        run,
      ),
    );
    expect(unknown.details.issues).toEqual([
      { path: 'rows.0', message: expect.stringContaining('"Q" at column 1') as string },
    ]);
    const reserved = await rejection(
      registry.execute(
        'pixels.writeGrid',
        {
          ...HERO_FRAME,
          rows: ['1'],
          legend: { '1': '#e8be96', '.': '#000000', _: '#ffffff', ab: '#000000' },
        },
        run,
      ),
    );
    expect(reserved.details.issues).toEqual([
      { path: 'legend..', message: expect.stringContaining('reserved') as string },
      { path: 'legend._', message: expect.stringContaining('reserved') as string },
      { path: 'legend.ab', message: expect.stringContaining('one of') as string },
    ]);
  });

  it('refuses a grid that reaches outside the canvas', async () => {
    const { run, hero } = await openHero();
    const before = documentHash(hero.store);
    const err = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, x: 47, y: 0, rows: ['11'], legend: { '1': '#e8be96' } },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'out-of-canvas' } });
    expect(documentHash(hero.store)).toBe(before);
  });
});

describe('pixels.writeGrid: rig frame (overrides)', () => {
  it('runs its example as one undo step and creates a head part override', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const example = need(pixelsWriteGrid.examples[0]);
    const out = (await registry.execute('pixels.writeGrid', example.input, run)) as {
      overrides: string[];
    };
    expect(out).toEqual({
      animation: 'default',
      frameIndex: 0,
      target: 'overrides',
      changed: 2,
      overrides: [expect.any(String) as string],
      newlyStale: [],
    });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: pixels.writeGrid']);

    // The eye moved one pixel left (hand-written expectation).
    const after = await read(run, HERO_FRAME, 21, 3, 8, 3);
    expect(after.rows).toEqual(['00111111', '00111211', '00111111']);
    expect(after.legend).toEqual(HEAD_LEGEND);

    // One override, on the head part, carrying exactly the two changed pixels: eye then skin.
    const ovr = need(overridesOf(hero.store)[0]);
    expect(overridesOf(hero.store)).toHaveLength(1);
    expect(ovr.id).toBe(out.overrides[0]);
    const headLayer = need(hero.store.doc.layers.find((l) => l.name === 'head'));
    const head = need(hero.store.doc.rig?.parts.find((p) => p.layerId === headLayer.id));
    expect(ovr.target).toEqual({ partId: head.id });
    expect(ovr.erase).toBeUndefined();
    const set = hero.store.image(need(ovr.set));
    expect(set).toBeInstanceOf(TiledImage);
    expect(ascii(set as TiledImage, { '30,30,40,255': 'E', '232,190,150,255': 'S' })).toEqual([
      'ES',
    ]);

    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('reading then writing the same grid is a no-op', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    for (const [x, y, w, h] of [
      [21, 0, 8, 10],
      [0, 0, 48, 48],
      [20, 20, 10, 28],
    ] as const) {
      const grid = await read(run, HERO_FRAME, x, y, w, h);
      const out = await registry.execute(
        'pixels.writeGrid',
        {
          ...HERO_FRAME,
          x,
          y,
          rows: grid.rows.slice(0, 32).map((r) => r.slice(0, 32)),
          legend: grid.legend,
        },
        run,
      );
      expect(out).toMatchObject({ changed: 0, overrides: [], newlyStale: [] });
    }
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.historyInfo().entries).toEqual([]);
  });

  it('keeps pixels marked "_" and counts only real changes', async () => {
    const { hero, run } = await openHero();
    const out = await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 26, y: 4, rows: ['_1'], legend: { '1': '#e8be96' } },
      run,
    );
    expect(out).toMatchObject({ changed: 1, target: 'overrides' });
    expect((await read(run, HERO_FRAME, 25, 4, 4, 1)).rows).toEqual(['0000']); // the eye is gone
    expect(overridesOf(hero.store)).toHaveLength(1);
  });

  it('erases with "." (part override with an erase mask)', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 21, y: 0, rows: ['.'], legend: {} },
      run,
    );
    const after = await read(run, HERO_FRAME, 21, 0, 8, 2);
    expect(after.rows).toEqual(['.0000000', '00000000']);
    const ovr = need(overridesOf(hero.store)[0]);
    expect(ovr.erase).toBeDefined();
    expect(ovr.target).not.toBe('final');
  });

  it('writes a final override for pixels outside every part, and reports the stale ones (RIG-04)', async () => {
    const { hero, run } = await openHero();
    const first = (await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 29, y: 4, rows: ['R'], legend: { R: '#ff0000' } },
      run,
    )) as { overrides: string[]; newlyStale: string[] };
    // skin, the new red pixel, transparent (legend symbols are per call: 0 skin, 1 red)
    expect((await read(run, HERO_FRAME, 28, 4, 3, 1)).rows).toEqual(['01.']);
    expect(need(overridesOf(hero.store)[0]).target).toBe('final');
    expect(first.newlyStale).toEqual([]);
    // A part override right next to it changes the canvas under the final override's region.
    const second = (await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 28, y: 4, rows: ['B'], legend: { B: '#0000ff' } },
      run,
    )) as { overrides: string[]; newlyStale: string[] };
    expect(second.newlyStale).toEqual(first.overrides);
  });

  it('edits a mirror animation with a final override of its own', async () => {
    const { hero, run } = await openHero();
    const source = need(hero.store.doc.animations[0]);
    const tx = hero.store.begin('add mirror');
    const mirrorId = tx.newId('animation');
    tx.update((d) => {
      d.animations.push({
        id: mirrorId,
        group: 'default',
        direction: 'west',
        mirrorOf: source.id,
        overrides: [],
      });
    });
    tx.commit();
    const base = { doc: HERO_ID, animation: { group: 'default', direction: 'west' }, frame: 0 };
    // The eye, mirrored about origin.x = 24: column 27 becomes column 21.
    // columns 20..22 are the source's 28, 27, 26: skin, eye, skin (symbols per call: 0 skin, 1 eye)
    expect((await read(run, base, 20, 4, 3, 1)).rows).toEqual(['010']);
    const out = await registry.execute(
      'pixels.writeGrid',
      { ...base, x: 21, y: 4, rows: ['1'], legend: { '1': '#e8be96' } },
      run,
    );
    expect(out).toMatchObject({ target: 'overrides', changed: 1 });
    const mirror = need(hero.store.doc.animations.find((a) => a.id === mirrorId));
    expect(mirror.overrides).toHaveLength(1);
    expect(need(mirror.overrides[0]).target).toBe('final');
    expect((await read(run, base, 20, 4, 3, 1)).rows).toEqual(['000']);
  });
});

/** Makes the hero palette-locked with exactly its own colours. */
function lockHero(store: DocumentStore): void {
  const tx = store.begin('lock');
  const pal = tx.newId('palette');
  tx.update((d) => {
    d.palettes.push({
      id: pal,
      name: 'Hero',
      colors: [
        [70, 45, 30, 255],
        [232, 190, 150, 255],
        [30, 30, 40, 255],
      ],
      ramps: [],
    });
    d.activePaletteId = pal;
    d.meta.paletteLocked = true;
  });
  tx.commit();
}

describe('pixels.writeGrid: palette lock', () => {
  it('only takes palette colours in a palette-locked RGBA document', async () => {
    const { hero, run } = await openHero();
    lockHero(hero.store);
    const before = documentHash(hero.store);
    const err = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, x: 26, y: 4, rows: ['XY'], legend: { X: '#123456', Y: '#e8be96' } },
        run,
      ),
    );
    expect(err).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'off-palette', colors: ['#123456'], palette: 'Hero' },
    });
    expect(documentHash(hero.store)).toBe(before);
    const ok = await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 26, y: 4, rows: ['1_'], legend: { '1': '#e8be96' } },
      run,
    );
    expect(ok).toMatchObject({ changed: 0 });
    const transparent = await registry.execute(
      'pixels.writeGrid',
      { ...HERO_FRAME, x: 26, y: 4, rows: ['._'], legend: {} },
      run,
    );
    expect(transparent).toMatchObject({ changed: 1, target: 'overrides' });
  });

  it('refuses a locked document without an active palette', async () => {
    const { hero, run } = await openHero();
    const tx = hero.store.begin('lock');
    tx.update((d) => {
      d.meta.paletteLocked = true;
    });
    tx.commit();
    const err = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, rows: ['1'], legend: { '1': '#e8be96' } },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });
});

describe('pixels.writeGrid: flat frame (layer cel)', () => {
  const GRID = { x: 2, y: 1, rows: ['12', '21'], legend: { '1': '#ff0000', '2': '#00ff00' } };

  it('writes the only pixel layer as one undo step and drops the old image', async () => {
    const { hosted, run } = await openFlat();
    const before = documentHash(hosted.store);
    const out = await registry.execute('pixels.writeGrid', { ...FLAT_FRAME, ...GRID }, run);
    expect(out).toEqual({
      animation: 'idle',
      frameIndex: 0,
      target: 'cel',
      layer: 'bg',
      changed: 4,
      overrides: [],
      newlyStale: [],
    });
    expect(hosted.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'AI: pixels.writeGrid',
    ]);
    expect(hosted.store.imageIds()).toHaveLength(1);
    const grid = await read(run, { ...FLAT_FRAME, layer: 'bg' }, 1, 0, 5, 4);
    expect(grid.rows).toEqual(['.....', '.01..', '.10..', '.....']);
    expect(grid.legend).toEqual({ '0': '#ff0000', '1': '#00ff00' });
    // frame 1 links to frame 0, so it changed too
    expect((await read(run, { ...FLAT_FRAME, frame: 1 }, 2, 1, 2, 2)).rows).toEqual(['01', '10']);
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
    expect(hosted.store.imageIds()).toEqual([FLAT.imgBg]);
  });

  it('is a no-op when the pixels already match', async () => {
    const { hosted, run } = await openFlat({
      paint: (img) => {
        img.set(2, 1, [255, 0, 0, 255]);
      },
    });
    const before = documentHash(hosted.store);
    const out = await registry.execute(
      'pixels.writeGrid',
      { ...FLAT_FRAME, x: 1, y: 1, rows: ['.1_'], legend: { '1': '#ff0000' } },
      run,
    );
    expect(out).toMatchObject({ changed: 0, target: 'cel' });
    expect(documentHash(hosted.store)).toBe(before);
    expect(hosted.store.historyInfo().entries).toEqual([]);
  });

  it('refuses a linked cel, an unnamed layer among several, and an unknown layer', async () => {
    const { run } = await openFlat({ twoLayers: true });
    const linked = await rejection(
      registry.execute('pixels.writeGrid', { ...FLAT_FRAME, frame: 1, layer: 'bg', ...GRID }, run),
    );
    expect(linked).toMatchObject({ code: 'REFUSED', details: { reason: 'linked-cel' } });
    const need2 = await rejection(
      registry.execute('pixels.writeGrid', { ...FLAT_FRAME, ...GRID }, run),
    );
    expect(need2).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'layer-required', available: ['bg', 'fg'] },
    });
    const noLayer = await rejection(
      registry.execute('pixels.writeGrid', { ...FLAT_FRAME, layer: 'nope', ...GRID }, run),
    );
    expect(noLayer).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'layer' } });
  });

  it('creates a cel where the layer has none', async () => {
    const { hosted, run } = await openFlat({ twoLayers: true });
    const out = await registry.execute(
      'pixels.writeGrid',
      { ...FLAT_FRAME, frame: 1, layer: 'fg', ...GRID },
      run,
    );
    expect(out).toMatchObject({ target: 'cel', layer: 'fg', frameIndex: 1, changed: 4 });
    expect((await read(run, { ...FLAT_FRAME, frame: 1, layer: 'fg' }, 2, 1, 2, 2)).rows).toEqual([
      '01',
      '10',
    ]);
    // the other layer is untouched
    expect((await read(run, { ...FLAT_FRAME, frame: 1, layer: 'bg' }, 2, 1, 2, 2)).rows).toEqual([
      '..',
      '..',
    ]);
    expect(hosted.store.imageIds()).toHaveLength(3);
  });

  it('keeps the old pixels of a partial write, and erases with "."', async () => {
    const { run } = await openFlat({
      paint: (img) => {
        img.set(0, 0, [1, 2, 3, 255]);
        img.set(1, 0, [4, 5, 6, 255]);
      },
    });
    await registry.execute(
      'pixels.writeGrid',
      { ...FLAT_FRAME, x: 1, y: 0, rows: ['.R'], legend: { R: '#ff0000' } },
      run,
    );
    const out = await read(run, FLAT_FRAME, 0, 0, 3, 1);
    expect(out.rows).toEqual(['0.1']);
    expect(out.legend).toEqual({ '0': '#010203', '1': '#ff0000' });
  });

  it('refuses reference and part layers', async () => {
    const { hosted, run } = await openFlat();
    const tx = hosted.store.begin('ref');
    tx.update((d) => {
      const l = need(d.layers[0]);
      if (l.kind === 'pixel') Reflect.set(l, 'kind', 'reference');
      Reflect.set(l, 'export', false);
    });
    tx.commit();
    const ref = await rejection(
      registry.execute('pixels.writeGrid', { ...FLAT_FRAME, layer: 'bg', ...GRID }, run),
    );
    expect(ref).toMatchObject({ code: 'REFUSED', details: { reason: 'reference-layer' } });
    const hero = await openHero();
    const part = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...HERO_FRAME, layer: 'head', rows: ['1'], legend: { '1': '#e8be96' } },
        hero.run,
      ),
    );
    expect(part).toMatchObject({ code: 'REFUSED', details: { reason: 'part-layer' } });
  });

  it('writes an indexed document through its palette', async () => {
    const { hosted, run } = await openFlat({ indexed: true });
    const bad = await rejection(
      registry.execute(
        'pixels.writeGrid',
        { ...FLAT_FRAME, rows: ['1'], legend: { '1': '#123456' } },
        run,
      ),
    );
    expect(bad).toMatchObject({ code: 'REFUSED', details: { reason: 'off-palette' } });
    const out = await registry.execute(
      'pixels.writeGrid',
      { ...FLAT_FRAME, x: 1, y: 1, rows: ['RB.'], legend: { R: '#ff0000', B: '#0000ff' } },
      run,
    );
    expect(out).toMatchObject({ target: 'cel', changed: 2 });
    const id = need(hosted.store.imageIds()[0]);
    const img = need(hosted.store.image(id)) as IndexedImage;
    expect(img).toBeInstanceOf(IndexedImage);
    expect([img.get(1, 1), img.get(2, 1), img.get(3, 1), img.get(0, 0)]).toEqual([1, 3, 0, 0]);
    // a second write keeps the first one's indices
    await registry.execute(
      'pixels.writeGrid',
      { ...FLAT_FRAME, x: 0, y: 3, rows: ['G'], legend: { G: '#00ff00' } },
      run,
    );
    const again = need(hosted.store.image(need(hosted.store.imageIds()[0]))) as IndexedImage;
    expect([again.get(1, 1), again.get(2, 1), again.get(0, 3)]).toEqual([1, 3, 2]);
  });
});
