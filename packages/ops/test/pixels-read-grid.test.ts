// pixels.readGrid: schema test, example test, legend, rulers, limits.
import type { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import { pixelsReadGrid, registry } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const HERO_FRAME = { doc: HERO_ID, animation: { group: 'default' }, frame: 0 } as const;

describe('pixels.readGrid', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const missing = await rejection(
      registry.execute('pixels.readGrid', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(missing.code).toBe('BAD_INPUT');
    expect(missing.details.issues).toEqual([
      { path: 'frame', message: expect.any(String) as string },
    ]);
    const tooWide = await rejection(
      registry.execute('pixels.readGrid', { ...HERO_FRAME, width: 65 }, run),
    );
    expect(tooWide.details.issues).toEqual([
      { path: 'width', message: expect.any(String) as string },
    ]);
  });

  it('returns its example output (hand-written ASCII of the hero head)', async () => {
    const { run } = await openHero();
    const example = need(pixelsReadGrid.examples[0]);
    expect(await registry.execute('pixels.readGrid', example.input, run)).toEqual(example.output);
  });

  it('reads the whole 48x48 canvas by default and keeps rows rectangular', async () => {
    const { run } = await openHero();
    const out = (await registry.execute('pixels.readGrid', HERO_FRAME, run)) as {
      rows: string[];
      legend: Record<string, string>;
    };
    expect(out.rows).toHaveLength(48);
    expect(new Set(out.rows.map((r) => r.length))).toEqual(new Set([48]));
    // 8 colours in the hero frame, symbols 0-7 in order of first appearance, "." never listed
    expect(Object.keys(out.legend)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(out.rows[47]).toBe('.....................6777777777.................');
  });

  it('adds rulers on request', async () => {
    const { run } = await openHero();
    const out = (await registry.execute(
      'pixels.readGrid',
      { ...HERO_FRAME, x: 8, y: 7, width: 5, height: 3, rulers: true },
      run,
    )) as { ruled: string[] };
    // columns 8..12: a tens digit only above column 10; rows 7..9 numbered, right-aligned
    expect(out.ruled).toEqual(['    1  ', '  89012', '7 .....', '8 .....', '9 .....']);
  });

  it('numbers wide rulers by tens', async () => {
    const { run } = await openFlat({ w: 40, h: 12 });
    const out = (await registry.execute(
      'pixels.readGrid',
      {
        doc: FLAT.doc,
        animation: { group: 'idle' },
        frame: 0,
        x: 8,
        y: 8,
        width: 24,
        height: 2,
        rulers: true,
      },
      run,
    )) as { ruled: string[] };
    expect(out.ruled).toEqual([
      `    1${' '.repeat(9)}2${' '.repeat(9)}3 `,
      '  890123456789012345678901',
      `8 ${'.'.repeat(24)}`,
      `9 ${'.'.repeat(24)}`,
    ]);
  });

  it('refuses a region over 64x64 and one outside the canvas', async () => {
    const { run } = await openFlat({ w: 100, h: 100 });
    const base = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 };
    const big = await rejection(registry.execute('pixels.readGrid', base, run));
    expect(big).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'region-too-large', max: 64 },
    });
    const outside = await rejection(
      registry.execute('pixels.readGrid', { ...base, x: 90, width: 20, height: 4 }, run),
    );
    expect(outside).toMatchObject({ code: 'REFUSED', details: { reason: 'out-of-canvas' } });
    const ok = (await registry.execute(
      'pixels.readGrid',
      { ...base, width: 64, height: 64 },
      run,
    )) as { rows: string[] };
    expect(ok.rows).toHaveLength(64);
  });

  it('holds 62 colours and refuses 63', async () => {
    const paint =
      (n: number) =>
      (img: TiledImage): void => {
        for (let i = 0; i < n; i++) img.set(i % 8, Math.floor(i / 8), [i + 1, 0, 0, 255]);
      };
    const ok = await openFlat({ h: 8, paint: paint(62) });
    const base = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 };
    const out = (await registry.execute('pixels.readGrid', base, ok.run)) as {
      legend: Record<string, string>;
      rows: string[];
    };
    expect(Object.keys(out.legend).join('')).toBe(
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    );
    expect(out.legend.z).toBe('#3e0000');
    expect(out.rows[0]).toBe('01234567');
    const many = await openFlat({ h: 8, paint: paint(63) });
    const err = await rejection(registry.execute('pixels.readGrid', base, many.run));
    expect(err).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'too-many-colors', max: 62 },
    });
  });

  it('lists translucent colours with an alpha suffix and treats alpha 0 as "."', async () => {
    const { run } = await openFlat({
      paint: (img) => {
        img.set(0, 0, [255, 128, 0, 128]);
        img.set(1, 0, [9, 9, 9, 0]);
        img.set(2, 0, [255, 128, 0, 255]);
      },
    });
    const out = await registry.execute(
      'pixels.readGrid',
      { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0, width: 4, height: 1 },
      run,
    );
    expect(out).toMatchObject({
      legend: { '0': '#ff800080', '1': '#ff8000' },
      rows: ['0.1.'],
    });
  });

  it("reads one layer's cel (following a link) and refuses part layers", async () => {
    const { run } = await openFlat({
      paint: (img) => img.set(3, 2, [10, 20, 30, 255]),
    });
    const base = {
      doc: FLAT.doc,
      animation: { group: 'idle' },
      layer: 'bg',
      x: 2,
      y: 1,
      width: 3,
      height: 3,
    };
    const f0 = await registry.execute('pixels.readGrid', { ...base, frame: 0 }, run);
    expect(f0).toMatchObject({
      source: 'cel',
      rows: ['...', '.0.', '...'],
      legend: { '0': '#0a141e' },
    });
    const f1 = await registry.execute('pixels.readGrid', { ...base, frame: 1 }, run);
    expect(f1).toMatchObject({ frameIndex: 1, rows: ['...', '.0.', '...'] });

    const hero = await openHero();
    const part = await rejection(
      registry.execute('pixels.readGrid', { ...HERO_FRAME, layer: 'head' }, hero.run),
    );
    expect(part).toMatchObject({ code: 'REFUSED', details: { reason: 'part-layer' } });
  });

  it('reads an indexed cel through the palette', async () => {
    const { run, hosted } = await openFlat({ indexed: true });
    const tx = hosted.store.begin('paint');
    tx.writeImage(FLAT.imgBg, (img) => {
      (img as IndexedImage).set(1, 1, 3);
    });
    tx.commit();
    for (const layer of [undefined, 'bg']) {
      const out = await registry.execute(
        'pixels.readGrid',
        {
          doc: FLAT.doc,
          animation: { group: 'idle' },
          frame: 0,
          x: 0,
          y: 0,
          width: 3,
          height: 3,
          ...(layer === undefined ? {} : { layer }),
        },
        run,
      );
      expect(out).toMatchObject({ rows: ['...', '.0.', '...'], legend: { '0': '#0000ff' } });
    }
  });
});
