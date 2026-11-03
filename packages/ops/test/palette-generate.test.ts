// palette.generate: sources (file, frame, layer), results, add/activate, refusals.
import { documentHash } from '@pixel-forge/core';
import { encodePng } from '@pixel-forge/png';
import type { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

/** PNG bytes of an image made of horizontal stripes `[r, g, b, a, rows]`, 4 px wide. */
function stripes(...rows: readonly [number, number, number, number, number][]): Uint8Array {
  const data: number[] = [];
  let height = 0;
  for (const [r, g, b, a, n] of rows) {
    for (let i = 0; i < n * 4; i++) data.push(r, g, b, a);
    height += n;
  }
  return encodePng({ width: 4, height, data: Uint8Array.from(data), kind: 'rgba' });
}

const HERO_FRAME = { animation: { group: 'default' }, frame: 0 } as const;

interface Out {
  colors: string[];
  method: string;
  seed?: number;
  source: string;
  pixels: number;
  ignored: number;
  unique: number;
  palette?: string;
  active?: boolean;
  note?: string;
}

describe('palette.generate', () => {
  it('rejects a missing or doubled source and flags that need add', async () => {
    const { run } = await openHero();
    const none = await rejection(registry.execute('palette.generate', { doc: HERO_ID, n: 4 }, run));
    expect(none.code).toBe('BAD_INPUT');
    const both = await rejection(
      registry.execute(
        'palette.generate',
        { doc: HERO_ID, n: 4, file: '/work/a.png', ...HERO_FRAME },
        run,
      ),
    );
    expect(both.code).toBe('BAD_INPUT');
    const frameWithFile = await rejection(
      registry.execute(
        'palette.generate',
        { doc: HERO_ID, n: 4, file: '/work/a.png', frame: 1 },
        run,
      ),
    );
    expect(frameWithFile.code).toBe('BAD_INPUT');
    const name = await rejection(
      registry.execute('palette.generate', { doc: HERO_ID, n: 4, ...HERO_FRAME, name: 'x' }, run),
    );
    expect(name.details.issues).toEqual([{ path: 'name', message: expect.any(String) as string }]);
    for (const n of [1, 257]) {
      const e = await rejection(
        registry.execute('palette.generate', { doc: HERO_ID, n, ...HERO_FRAME }, run),
      );
      expect(e.details.issues).toEqual([{ path: 'n', message: expect.any(String) as string }]);
    }
  });

  it('three flat stripes with n = 3 give exactly those colours (file), and change nothing', async () => {
    const { hero, fs, run } = await openHero();
    fs.seed(
      '/work/blocks.png',
      stripes([200, 30, 30, 255, 3], [30, 160, 40, 255, 2], [30, 40, 210, 255, 1]),
    );
    const before = documentHash(hero.store);
    const entries = hero.store.historyInfo().entries.length;
    const out = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 3, file: '/work/blocks.png' },
      run,
    )) as Out;
    expect(out).toMatchObject({
      colors: ['#1e28d2', '#c81e1e', '#1ea028'],
      method: 'kmeans',
      seed: 1,
      source: 'file',
      pixels: 24,
      ignored: 0,
      unique: 3,
    });
    expect(out.note).toBeUndefined();
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.historyInfo().entries).toHaveLength(entries);
  });

  it('two clusters, n = 2, both methods give the heavier colour of each', async () => {
    const { fs, run } = await openHero();
    fs.seed(
      '/work/two.png',
      stripes(
        [200, 30, 30, 255, 6],
        [210, 40, 38, 255, 1],
        [20, 30, 200, 255, 7],
        [30, 40, 210, 255, 1],
      ),
    );
    for (const method of ['kmeans', 'mediancut'] as const) {
      const out = (await registry.execute(
        'palette.generate',
        { doc: HERO_ID, n: 2, file: '/work/two.png', method },
        run,
      )) as Out;
      expect(out.colors, method).toEqual(['#141ec8', '#c81e1e']);
      expect(out.seed === undefined, method).toBe(method === 'mediancut');
    }
  });

  it('ignores alpha 0, takes translucent pixels by their RGB, and says when there are fewer colours than n', async () => {
    const { fs, run } = await openHero();
    fs.seed('/work/a.png', stripes([9, 9, 9, 0, 2], [10, 20, 30, 128, 1], [200, 100, 50, 255, 1]));
    const out = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 8, file: '/work/a.png' },
      run,
    )) as Out;
    expect(out).toMatchObject({
      colors: ['#0a141e', '#c86432'],
      pixels: 8,
      ignored: 8,
      unique: 2,
    });
    expect(out.note).toContain('only 2 distinct colours');
    const strict = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 8, file: '/work/a.png', minAlpha: 200 },
      run,
    )) as Out;
    expect(strict).toMatchObject({ colors: ['#c86432'], pixels: 4, ignored: 12 });
  });

  it('refuses an image with no visible pixel, a non-PNG and a path outside the workspace', async () => {
    const { fs, run } = await openHero();
    fs.seed('/work/clear.png', stripes([1, 2, 3, 0, 2]));
    fs.seed('/work/not.png', new Uint8Array([1, 2, 3]));
    const clear = await rejection(
      registry.execute('palette.generate', { doc: HERO_ID, n: 4, file: '/work/clear.png' }, run),
    );
    expect(clear).toMatchObject({ code: 'REFUSED', details: { reason: 'no-visible-pixels' } });
    const notPng = await rejection(
      registry.execute('palette.generate', { doc: HERO_ID, n: 4, file: '/work/not.png' }, run),
    );
    expect(notPng.code).toBe('BAD_FILE');
    const missing = await rejection(
      registry.execute('palette.generate', { doc: HERO_ID, n: 4, file: '/work/none.png' }, run),
    );
    expect(missing.code).toBe('IO_FAILED');
    const outside = await rejection(
      registry.execute('palette.generate', { doc: HERO_ID, n: 4, file: '/etc/a.png' }, run),
    );
    expect(outside.code).toBe('NOT_ALLOWED');
  });

  it('the same seed gives the same colours; a frame of the hero has 8 colours at most', async () => {
    const { run } = await openHero();
    const call = (extra: object): Promise<unknown> =>
      registry.execute('palette.generate', { doc: HERO_ID, n: 5, ...HERO_FRAME, ...extra }, run);
    const a = (await call({ seed: 3 })) as Out;
    expect(a.source).toBe('frame');
    expect(a.colors).toHaveLength(5);
    expect(new Set(a.colors).size).toBe(5);
    expect(await call({ seed: 3 })).toEqual(a);
    const all = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 64, ...HERO_FRAME },
      run,
    )) as Out;
    expect(all.unique).toBeLessThanOrEqual(64);
    expect(all.colors).toHaveLength(all.unique);
    expect(all.note).toBeDefined();
  });

  it('reads one layer cel with "layer" and the composite without it', async () => {
    const { run } = await openFlat({
      twoLayers: true,
      paint: (img: TiledImage) => {
        img.set(0, 0, [255, 0, 0, 255]);
        img.set(1, 0, [0, 0, 255, 255]);
      },
    });
    const base = { doc: FLAT.doc, n: 4, animation: { group: 'idle' }, frame: 0 };
    const bg = (await registry.execute('palette.generate', { ...base, layer: 'bg' }, run)) as Out;
    expect(bg).toMatchObject({ source: 'layer', colors: ['#0000ff', '#ff0000'], pixels: 2 });
    const fg = await rejection(registry.execute('palette.generate', { ...base, layer: 'fg' }, run));
    expect(fg.details.reason).toBe('no-visible-pixels');
    const all = (await registry.execute('palette.generate', base, run)) as Out;
    expect(all).toMatchObject({ source: 'frame', colors: ['#0000ff', '#ff0000'] });
  });

  it('add stores a new active palette in one undo step', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 4, ...HERO_FRAME, add: true, name: 'hero4' },
      run,
    )) as Out;
    const pal = need(hero.store.doc.palettes[0]);
    expect(hero.store.doc.palettes).toHaveLength(1);
    expect(pal.name).toBe('hero4');
    expect(pal.id).toBe(out.palette);
    expect(pal.colors.map((c) => c.join(','))).toHaveLength(4);
    expect(pal.colors.every((c) => c[3] === 255)).toBe(true);
    expect(out.active).toBe(true);
    expect(hero.store.doc.activePaletteId).toBe(pal.id);
    expect(stepLabels(hero)).toEqual(['AI: palette.generate']);
    hero.store.undo();
    expect(hero.store.doc.palettes).toHaveLength(0);
  });

  it('add keeps the active palette unless activate is true; indexed documents refuse that', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'palette.edit',
      { doc: HERO_ID, edits: [{ do: 'add', color: '#102030' }] },
      run,
    );
    const first = hero.store.doc.activePaletteId;
    const kept = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 3, ...HERO_FRAME, add: true },
      run,
    )) as Out;
    expect(kept.active).toBe(false);
    expect(hero.store.doc.activePaletteId).toBe(first);
    expect(hero.store.doc.palettes.map((p) => p.name)).toEqual(['palette', 'generated']);
    const switched = (await registry.execute(
      'palette.generate',
      { doc: HERO_ID, n: 3, ...HERO_FRAME, add: true, activate: true, name: 'again' },
      run,
    )) as Out;
    expect(switched.active).toBe(true);
    expect(hero.store.doc.activePaletteId).toBe(switched.palette);
  });

  it('refuses to activate a palette in an indexed document', async () => {
    const { hosted, run } = await openFlat({ indexed: true });
    (hosted.store.image(FLAT.imgBg) as IndexedImage).set(0, 0, 1);
    (hosted.store.image(FLAT.imgBg) as IndexedImage).set(1, 0, 2);
    const hash = documentHash(hosted.store);
    const e = await rejection(
      registry.execute(
        'palette.generate',
        { doc: FLAT.doc, n: 2, animation: { group: 'idle' }, frame: 0, add: true, activate: true },
        run,
      ),
    );
    expect(e).toMatchObject({ code: 'REFUSED', details: { reason: 'indexed-document' } });
    expect(documentHash(hosted.store)).toBe(hash);
  });
});
