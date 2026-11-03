// palette.remap: known-answer maps (indexed and RGBA), scopes, swap, undo/redo, refusals.
import { documentHash, validate } from '@pixel-forge/core';
import type { DocumentStore } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { ImageId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { paletteRemap } from '../src/ops/palette-remap.js';
import type { RunOptions } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const FRAME = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 } as const;
const LEGEND = { R: '#ff0000', G: '#00ff00', B: '#0000ff' };

/** Paints rows into a flat layer (symbols R, G, B; "." transparent). */
async function paint(run: RunOptions, rows: string[], layer?: string): Promise<void> {
  await registry.execute(
    'pixels.writeGrid',
    { ...FRAME, ...(layer === undefined ? {} : { layer }), rows, legend: LEGEND },
    run,
  );
}

/** The cel image of a layer at frame 0 as text: indexed gives the digits, RGBA gives R G B or "?". */
function rowsOf(store: DocumentStore, layerName: string): string[] {
  const layer = need(store.doc.layers.find((l) => l.name === layerName));
  if (layer.kind !== 'pixel') throw new Error('not a pixel layer');
  const cel = need(layer.cels[FLAT.frame0]);
  if (!('imageId' in cel)) throw new Error('linked cel');
  const img = need(store.image(cel.imageId));
  const rows: string[] = [];
  const names: Record<string, string> = {
    '255,0,0,255': 'R',
    '0,255,0,255': 'G',
    '0,0,255,255': 'B',
  };
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      if (img instanceof IndexedImage) row += String(img.get(x, y));
      else if (img instanceof TiledImage) {
        const c = img.get(x, y);
        row += c[3] === 0 ? '.' : (names[c.join(',')] ?? '?');
      }
    }
    rows.push(row);
  }
  return rows;
}

const top = (rows: string[], n: number): string[] => rows.slice(0, n);

describe('palette.remap: indexed map', () => {
  it('moves indices, keeps the rest and the transparent pixels, reports counts', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.', 'RRG.', '....']);
    expect(rowsOf(hosted.store, 'bg')).toEqual(['1230', '1120', '0000']);
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: 1, to: 3 }] },
      run,
    );
    expect(rowsOf(hosted.store, 'bg')).toEqual(['3230', '3320', '0000']);
    expect(out).toMatchObject({
      mode: 'map',
      changed: 3,
      scanned: 1,
      drawings: [{ where: 'bg @ ' + FLAT.frame0, changed: 3 }],
    });
    expect(hosted.store.historyInfo().entries.at(-1)?.label).toBe('AI: palette.remap');
  });

  it('applies the table at once (1 and 3 swap) and undo/redo round-trips', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.', 'RRG.', '....']);
    const before = documentHash(hosted.store);
    const steps = hosted.store.historyInfo().entries.length;
    await registry.execute(
      'palette.remap',
      {
        doc: FLAT.doc,
        map: [
          { from: 1, to: 3 },
          { from: 3, to: 1 },
        ],
      },
      run,
    );
    expect(rowsOf(hosted.store, 'bg')).toEqual(['3210', '3320', '0000']);
    expect(hosted.store.historyInfo().entries.length).toBe(steps + 1);
    const after = documentHash(hosted.store);
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
    expect(rowsOf(hosted.store, 'bg')).toEqual(['1230', '1120', '0000']);
    hosted.store.redo();
    expect(documentHash(hosted.store)).toBe(after);
  });

  it('changes nothing and records nothing when no pixel uses a listed index', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['R...']);
    const before = documentHash(hosted.store);
    const steps = hosted.store.historyInfo().entries.length;
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: 2, to: 3 }] },
      run,
    );
    expect(out).toMatchObject({ changed: 0, drawings: [] });
    expect(documentHash(hosted.store)).toBe(before);
    expect(hosted.store.historyInfo().entries.length).toBe(steps);
  });

  it('scopes to a layer; a drawing shared with an out-of-scope cel stays for that cel', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3, twoLayers: true });
    await paint(run, ['RG..'], 'bg');
    await paint(run, ['GR..'], 'fg');
    const only = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: 1, to: 3 }], layer: 'fg' },
      run,
    );
    expect(only).toMatchObject({ changed: 1, scanned: 1 });
    expect(top(rowsOf(hosted.store, 'bg'), 1)).toEqual(['1200']);
    expect(top(rowsOf(hosted.store, 'fg'), 1)).toEqual(['2300']);
    // fg frame 1 now shows the same drawing as bg frame 0
    const sharedId = celImage(hosted.store);
    hosted.store.transact('share', (tx) => {
      tx.update((d) => {
        const fg = need(d.layers.find((l) => l.name === 'fg'));
        if (fg.kind !== 'pixel') throw new Error('x');
        fg.cels[FLAT.frame1] = {
          imageId: sharedId,
          offset: { x: 0, y: 0 },
          opacity: 255,
        };
      });
    });
    await registry.execute(
      'palette.remap',
      {
        doc: FLAT.doc,
        map: [{ from: 2, to: 3 }],
        layer: 'fg',
        animation: { group: 'idle' },
        frames: [1],
      },
      run,
    );
    const fg = need(hosted.store.doc.layers.find((l) => l.name === 'fg'));
    const bg = need(hosted.store.doc.layers.find((l) => l.name === 'bg'));
    if (fg.kind !== 'pixel' || bg.kind !== 'pixel') throw new Error('x');
    const fgId = fg.cels[FLAT.frame1] as { imageId: ImageId };
    const bgId = bg.cels[FLAT.frame0] as { imageId: ImageId };
    expect(fgId.imageId).not.toBe(bgId.imageId);
    expect(rowsOf(hosted.store, 'bg')).toEqual(['1200', '0000', '0000']);
    const shared = need(hosted.store.image(fgId.imageId)) as IndexedImage;
    expect(shared.get(1, 0)).toBe(3);
    expect(validate(hosted.store).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('frames select cels that own a drawing; a linked cel follows its source', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['R...']);
    const link = await registry.execute(
      'palette.remap',
      {
        doc: FLAT.doc,
        map: [{ from: 1, to: 2 }],
        animation: { group: 'idle' },
        frames: [1],
      },
      run,
    );
    expect(link).toMatchObject({ changed: 0, scanned: 0 });
    const own = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: 1, to: 2 }], animation: { group: 'idle' }, frames: [0] },
      run,
    );
    expect(own).toMatchObject({ changed: 1 });
    expect(top(rowsOf(hosted.store, 'bg'), 1)).toEqual(['2000']);
  });
});

describe('palette.remap: RGBA map', () => {
  it('maps exact colours, leaves other colours and transparent pixels', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3 });
    await paint(run, ['RGB.', 'RRG.', '....']);
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: '#ff0000', to: '#0000ff' }] },
      run,
    );
    expect(rowsOf(hosted.store, 'bg')).toEqual(['BGB.', 'BBG.', '....']);
    expect(out).toMatchObject({ mode: 'map', changed: 3, drawings: [{ changed: 3 }] });
    hosted.store.undo();
    expect(rowsOf(hosted.store, 'bg')).toEqual(['RGB.', 'RRG.', '....']);
  });

  it('does not match a colour that differs in alpha', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3 });
    await paint(run, ['R...']);
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: '#ff000080', to: '#0000ff' }] },
      run,
    );
    expect(out).toMatchObject({ changed: 0 });
    expect(top(rowsOf(hosted.store, 'bg'), 1)).toEqual(['R...']);
  });

  it('a palette-locked document takes only palette colours as targets', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3, paletteLocked: true });
    await paint(run, ['RG..']);
    const before = documentHash(hosted.store);
    const err = await rejection(
      registry.execute(
        'palette.remap',
        { doc: FLAT.doc, map: [{ from: '#ff0000', to: '#123456' }] },
        run,
      ),
    );
    expect(err).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'off-palette', color: '#123456' },
    });
    expect(documentHash(hosted.store)).toBe(before);
    await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, map: [{ from: '#ff0000', to: '#0000ff' }] },
      run,
    );
    expect(top(rowsOf(hosted.store, 'bg'), 1)).toEqual(['BG..']);
  });

  it('reaches rig part variants in a whole-document map', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'palette.remap',
      { doc: HERO_ID, map: [{ from: '#e8be96', to: '#010203' }] },
      run,
    )) as { changed: number; drawings: { where: string; changed: number }[] };
    expect(out.changed).toBeGreaterThan(0);
    expect(out.drawings.some((d) => d.where.includes('variant'))).toBe(true);
    expect(validate(hero.store).filter((f) => f.severity === 'error')).toEqual([]);
    hero.store.undo();
    const again = (await registry.execute(
      'palette.remap',
      { doc: HERO_ID, map: [{ from: '#e8be96', to: '#010203' }] },
      run,
    )) as { changed: number };
    expect(again.changed).toBe(out.changed);
  });
});

describe('palette.remap: refusals change nothing', () => {
  const indexedCases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['index beyond the palette', { map: [{ from: 1, to: 4 }] }, { code: 'BAD_INPUT' }],
    ['colour in an indexed document', { map: [{ from: '#ff0000', to: 2 }] }, { code: 'BAD_INPUT' }],
    [
      'index twice',
      {
        map: [
          { from: 1, to: 2 },
          { from: 1, to: 3 },
        ],
      },
      { code: 'BAD_INPUT' },
    ],
    [
      'transparent index',
      { map: [{ from: 0, to: 2 }] },
      { code: 'REFUSED', details: { reason: 'transparent' } },
    ],
    [
      'target is the transparent index',
      { map: [{ from: 1, to: 0 }] },
      { code: 'REFUSED', details: { reason: 'transparent' } },
    ],
    [
      'map and swap',
      { map: [{ from: 1, to: 2 }], swap: { colors: ['#000000'] } },
      { code: 'BAD_INPUT' },
    ],
    ['neither', {}, { code: 'BAD_INPUT' }],
    ['frames without animation', { map: [{ from: 1, to: 2 }], frames: [0] }, { code: 'BAD_INPUT' }],
    ['swap with a scope', { swap: { colors: ['#00000000'] }, layer: 'bg' }, { code: 'BAD_INPUT' }],
    ['unknown layer', { map: [{ from: 1, to: 2 }], layer: 'nope' }, { code: 'NOT_FOUND' }],
    ['bad hex', { map: [{ from: 1, to: '#12' }] }, { code: 'BAD_INPUT' }],
  ];
  it.each(indexedCases)('indexed: %s', async (_name, extra, expected) => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.']);
    const before = documentHash(hosted.store);
    const err = await rejection(
      registry.execute('palette.remap', { doc: FLAT.doc, ...extra }, run),
    );
    expect(err).toMatchObject(expected);
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('RGBA: an index, an alpha-0 colour and a repeated colour are refused', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3 });
    await paint(run, ['RGB.']);
    const before = documentHash(hosted.store);
    const idx = await rejection(
      registry.execute('palette.remap', { doc: FLAT.doc, map: [{ from: 1, to: 2 }] }, run),
    );
    expect(idx).toMatchObject({ code: 'BAD_INPUT' });
    const clear = await rejection(
      registry.execute(
        'palette.remap',
        { doc: FLAT.doc, map: [{ from: '#ff0000', to: '#00000000' }] },
        run,
      ),
    );
    expect(clear).toMatchObject({ code: 'REFUSED', details: { reason: 'transparent' } });
    const twice = await rejection(
      registry.execute(
        'palette.remap',
        {
          doc: FLAT.doc,
          map: [
            { from: '#ff0000', to: '#00ff00' },
            { from: '#ff0000', to: '#0000ff' },
          ],
        },
        run,
      ),
    );
    expect(twice).toMatchObject({ code: 'REFUSED' });
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('an indexed document without a palette is refused', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    hosted.store.transact('x', (tx) => {
      tx.update((d) => {
        d.palettes = [];
        delete d.activePaletteId;
      });
    });
    const err = await rejection(
      registry.execute('palette.remap', { doc: FLAT.doc, map: [{ from: 1, to: 2 }] }, run),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });
});

describe('palette.remap: swap', () => {
  const TEAM = ['#00000000', '#aa0000', '#00aa00', '#0000aa'];

  it('indexed: colours change, indices stay, counts per drawing, one undo step', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.', 'RRG.', '....']);
    const before = documentHash(hosted.store);
    const steps = hosted.store.historyInfo().entries.length;
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, swap: { colors: ['#00000000', '#aa0000', '#00ff00', '#0000aa'] } },
      run,
    );
    expect(rowsOf(hosted.store, 'bg')).toEqual(['1230', '1120', '0000']);
    expect(out).toMatchObject({
      mode: 'swap',
      palette: FLAT.pal,
      changed: 4,
      drawings: [{ changed: 4 }],
      colors: ['#00000000', '#aa0000', '#00ff00', '#0000aa'],
    });
    expect(hosted.store.doc.palettes[0]?.colors[1]).toEqual([170, 0, 0, 255]);
    expect(hosted.store.doc.palettes[0]?.id).toBe(FLAT.pal);
    expect(hosted.store.historyInfo().entries.length).toBe(steps + 1);
    expect(hosted.store.historyInfo().entries.at(-1)?.label).toBe('AI: palette.remap');
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('swaps in another palette of the document by id', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.']);
    let other = '';
    hosted.store.transact('other', (tx) => {
      other = tx.newId('palette');
      tx.update((d) => {
        d.palettes.push({
          id: other as (typeof d.palettes)[number]['id'],
          name: 'Team',
          colors: TEAM.map((h) => [
            Number.parseInt(h.slice(1, 3), 16),
            Number.parseInt(h.slice(3, 5), 16),
            Number.parseInt(h.slice(5, 7), 16),
            h.length === 9 ? Number.parseInt(h.slice(7, 9), 16) : 255,
          ]),
          ramps: [],
        });
      });
    });
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, swap: { palette: other } },
      run,
    );
    expect(out).toMatchObject({
      palette: FLAT.pal,
      colors: TEAM.map((h) => (h === '#00000000' ? h : h)),
    });
    expect(hosted.store.doc.activePaletteId).toBe(FLAT.pal);
    expect(hosted.store.doc.palettes[0]?.colors[3]).toEqual([0, 0, 170, 255]);
  });

  it('RGBA: pixels equal to old entry i become new entry i', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3, paletteLocked: true });
    await paint(run, ['RGB.', 'RRG.', '....']);
    const out = await registry.execute(
      'palette.remap',
      { doc: FLAT.doc, swap: { colors: TEAM } },
      run,
    );
    expect(out).toMatchObject({ changed: 6 });
    const img = need(hosted.store.image(celImage(hosted.store))) as TiledImage;
    expect(img.get(0, 0)).toEqual([170, 0, 0, 255]);
    expect(img.get(2, 0)).toEqual([0, 0, 170, 255]);
    expect(img.get(3, 0)).toEqual([0, 0, 0, 0]);
    expect(hosted.store.doc.palettes[0]?.colors[2]).toEqual([0, 170, 0, 255]);
    hosted.store.undo();
    expect(rowsOf(hosted.store, 'bg')).toEqual(['RGB.', 'RRG.', '....']);
  });

  it('refuses a different length, moved transparency, the active palette and an unknown id', async () => {
    const { hosted, run } = await openFlat({ indexed: true, w: 4, h: 3 });
    await paint(run, ['RGB.']);
    const before = documentHash(hosted.store);
    const run1 = (swap: Record<string, unknown>): Promise<unknown> =>
      registry.execute('palette.remap', { doc: FLAT.doc, swap }, run);
    expect(await rejection(run1({ colors: ['#000000'] }))).toMatchObject({ code: 'BAD_INPUT' });
    expect(
      await rejection(run1({ colors: ['#112233', '#aa0000', '#00aa00', '#0000aa'] })),
    ).toMatchObject({ code: 'REFUSED', details: { reason: 'transparency' } });
    expect(await rejection(run1({ palette: FLAT.pal }))).toMatchObject({ code: 'BAD_INPUT' });
    expect(await rejection(run1({ palette: 'pal_zzzzzz' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(run1({}))).toMatchObject({ code: 'BAD_INPUT' });
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('RGBA: refuses a swap that is ambiguous', async () => {
    const { hosted, run } = await openFlat({ w: 4, h: 3, paletteLocked: true });
    hosted.store.transact('dup', (tx) => {
      tx.update((d) => {
        const p = need(d.palettes[0]);
        p.colors[2] = [255, 0, 0, 255];
      });
    });
    const err = await rejection(
      registry.execute('palette.remap', { doc: FLAT.doc, swap: { colors: TEAM } }, run),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'swap' } });
  });

  it('a document without a palette cannot swap', async () => {
    const { run } = await openFlat({ w: 4, h: 3 });
    const err = await rejection(
      registry.execute('palette.remap', { doc: FLAT.doc, swap: { colors: TEAM } }, run),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });
});

/** The image id of the flat "bg" cel at frame 0. */
function celImage(store: DocumentStore): ImageId {
  const layer = need(store.doc.layers[0]);
  if (layer.kind !== 'pixel') throw new Error('x');
  return (need(layer.cels[FLAT.frame0]) as { imageId: ImageId }).imageId;
}

describe('palette.remap: definition', () => {
  it('is in the palette group and its examples validate', () => {
    expect(paletteRemap.group).toBe('palette');
    for (const ex of paletteRemap.examples) {
      expect(paletteRemap.input.safeParse(ex.input).success).toBe(true);
    }
  });
});
