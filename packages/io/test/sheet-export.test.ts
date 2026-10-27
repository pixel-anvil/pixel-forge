import { renderFrame } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { createDocumentFromSpritesheet, exportSpritesheet } from '../src/index.js';
import type { AseSheetJson } from '../src/index.js';
import {
  bytesEqual,
  heroDocument,
  ioCode,
  need,
  pngFromRows,
  testFile,
  testJson,
} from './helpers.js';

/**
 * Oracle: Aseprite's own `--sheet --data --format json-hash` output for a 6-frame, 2-tag sprite
 * (`oracle/make-oracle.sh`). The pixel-forge document is built by importing the oracle's own sheet
 * PNG (cell 8x6), so both sides describe the same pixels.
 *
 * Fields that differ by design and are removed from the oracle before comparing:
 * - `meta.app`, `meta.version`: ours identify pixel-forge;
 * - `meta.frameTags[].color`: pixel-forge tags have no colour;
 * - `meta.layers`, `meta.slices`: we do not emit layer or slice lists (only on request in Aseprite).
 */
function fixture(scale: 1 | 2) {
  const suffix = scale === 1 ? '' : '-x2';
  const oracle = testJson(`./oracle/oracle-sheet${suffix}.json`) as AseSheetJson & {
    meta: { layers?: unknown; slices?: unknown; frameTags: { color?: string }[] };
  };
  const oraclePng = decodePng(testFile(`./oracle/oracle-sheet${suffix}.png`));
  return { oracle, oraclePng };
}

function build() {
  const base = decodePngBytes();
  const { store } = createDocumentFromSpritesheet({
    png: testFile('./oracle/oracle-sheet.png'),
    cell: [8, 6],
    animations: [
      {
        group: 'idle',
        direction: 'side',
        frames: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
      },
      {
        group: 'run',
        direction: 'side',
        frames: [
          [1, 0],
          [1, 1],
          [1, 2],
        ],
        loop: 'pingpong',
      },
    ],
  });
  // Durations of the Lua script (ms).
  store.transact('Durations', (tx) => {
    const ms = [100, 120, 140, 60, 80, 90];
    let i = 0;
    tx.update((d) => {
      for (const a of d.animations) {
        if ('frames' in a) for (const f of a.frames) f.durationMs = ms[i++] ?? 1;
      }
    });
  });
  expect(base.width).toBe(24);
  return store;
}

function decodePngBytes() {
  return decodePng(testFile('./oracle/oracle-sheet.png'));
}

function stripByDesign(o: ReturnType<typeof fixture>['oracle']): unknown {
  const meta = { ...o.meta };
  delete meta.layers;
  delete meta.slices;
  return {
    frames: o.frames,
    meta: {
      ...meta,
      app: 'pixel-forge',
      version: '1.0',
      frameTags: o.meta.frameTags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
      })),
    },
  };
}

describe('exportSpritesheet vs Aseprite oracle', () => {
  it.each([1, 2] as const)(
    'scale %i: JSON equals Aseprite json-hash (minus by-design fields)',
    (scale) => {
      const { oracle } = fixture(scale);
      const out = exportSpritesheet(build(), {
        layout: 'rows',
        scale,
        imageName: 'oracle-sheet' + (scale === 1 ? '' : '-x2') + '.png',
      });
      expect(out.json).toEqual(stripByDesign(oracle));
      // Same key order as Aseprite (sheet order).
      expect(Object.keys(out.json.frames)).toEqual(Object.keys(oracle.frames));
    },
  );

  it.each([1, 2] as const)('scale %i: sheet pixels equal the Aseprite sheet', (scale) => {
    const { oraclePng } = fixture(scale);
    const got = decodePng(exportSpritesheet(build(), { layout: 'rows', scale }).png);
    expect(got.width).toBe(oraclePng.width);
    expect(got.height).toBe(oraclePng.height);
    expect(bytesEqual(got.data, oraclePng.data)).toBe(true);
  });
});

describe('exportSpritesheet', () => {
  it('exports selected animations in the given order', () => {
    const out = exportSpritesheet(build(), {
      layout: 'rows',
      animations: [{ group: 'run', direction: 'side' }],
    });
    expect(Object.keys(out.json.frames)).toEqual(['run/side 0', 'run/side 1', 'run/side 2']);
    expect(out.json.meta.frameTags).toEqual([
      { name: 'run/side', from: 0, to: 2, direction: 'pingpong' },
    ]);
    expect(out.json.meta.size).toEqual({ w: 24, h: 6 });
    expect(out.json.meta.image).toBe('spritesheet.png');
  });

  it('packed layout uses a near-square grid in reading order', () => {
    const out = exportSpritesheet(build(), { layout: 'packed' });
    // 6 frames -> ceil(sqrt(6)) = 3 columns, 2 rows
    expect(out.json.meta.size).toEqual({ w: 24, h: 12 });
    expect(out.json.frames['run/side 0']?.frame).toEqual({ x: 0, y: 6, w: 8, h: 6 });
    const hero = exportSpritesheet(heroDocument(), { layout: 'packed' });
    const n = Object.keys(hero.json.frames).length; // 22 frames
    expect(n).toBe(2 + 8 + 4 + 5 + 3);
    expect(hero.json.meta.size).toEqual({ w: 5 * 64, h: Math.ceil(n / 5) * 64 });
    const last = hero.json.frames['slide 2'];
    expect(last?.frame.x).toBe(((n - 1) % 5) * 64);
    expect(last?.frame.y).toBe(Math.floor((n - 1) / 5) * 64);
  });

  it('rows layout of the CC0 hero: one row per animation, pixels equal renderFrame', () => {
    const store = heroDocument();
    const out = exportSpritesheet(store, { layout: 'rows', scale: 1 });
    const png = decodePng(out.png);
    expect(out.json.meta.size).toEqual({ w: 8 * 64, h: 5 * 64 });
    expect(png.width).toBe(512);
    // second animation (run) frame 5 sits at row 1, column 5
    const want = renderFrame(store, { group: 'run' }, 5).toRGBA().data;
    const f = need(out.json.frames['run 5']).frame;
    expect(f).toEqual({ x: 5 * 64, y: 64, w: 64, h: 64 });
    for (let y = 0; y < 64; y++) {
      const a = png.data.subarray(
        ((f.y + y) * png.width + f.x) * 4,
        ((f.y + y) * png.width + f.x + 64) * 4,
      );
      const b = want.subarray(y * 256, y * 256 + 256);
      expect(bytesEqual(a, b)).toBe(true);
    }
    expect(out.json.meta.frameTags.map((t) => [t.name, t.from, t.to])).toEqual([
      ['idle', 0, 1],
      ['run', 2, 9],
      ['jump_and_fall', 10, 13],
      ['attack', 14, 18],
      ['slide', 19, 21],
    ]);
  });

  it('is deterministic', () => {
    const a = exportSpritesheet(build(), { layout: 'rows', scale: 3 });
    const b = exportSpritesheet(build(), { layout: 'rows', scale: 3 });
    expect(bytesEqual(a.png, b.png)).toBe(true);
    expect(a.json).toEqual(b.json);
  });

  it('honours exportOnly and skips hidden export layers', () => {
    const png = pngFromRows(['RR', 'RR'], { R: [255, 0, 0, 255] });
    const { store } = createDocumentFromSpritesheet({
      png,
      cell: [2, 2],
      animations: [{ group: 'a', frames: [[0, 0]] }],
    });
    store.transact('hide export', (tx) => {
      tx.update((d) => {
        const l = d.layers[0];
        if (l) l.export = false;
      });
    });
    const solo = (exportOnly: boolean) =>
      decodePng(exportSpritesheet(store, { layout: 'rows', exportOnly }).png).data.some(
        (v) => v !== 0,
      );
    expect(solo(true)).toBe(false);
    expect(solo(false)).toBe(true);
  });

  it('exports mirror animations with the source durations', () => {
    const store = build();
    store.transact('mirror', (tx) => {
      const src = tx.doc.animations[0];
      if (!src) throw new Error('src');
      const id = tx.newId('animation');
      tx.update((d) => {
        d.animations.push({
          id,
          group: 'idle',
          direction: 'left',
          mirrorOf: src.id,
          overrides: [],
        });
      });
    });
    const out = exportSpritesheet(store, {
      layout: 'rows',
      animations: [{ group: 'idle', direction: 'left' }],
    });
    expect(Object.keys(out.json.frames)).toEqual(['idle/left 0', 'idle/left 1', 'idle/left 2']);
    expect(out.json.frames['idle/left 1']?.duration).toBe(120);
  });

  it('refuses bad input', () => {
    const store = build();
    expect(ioCode(() => exportSpritesheet(store, { layout: 'rows', scale: 0 }))).toBe('BAD_INPUT');
    expect(ioCode(() => exportSpritesheet(store, { layout: 'rows', scale: 17 }))).toBe('BAD_INPUT');
    expect(ioCode(() => exportSpritesheet(store, { layout: 'rows', scale: 1.5 }))).toBe(
      'BAD_INPUT',
    );
    expect(ioCode(() => exportSpritesheet(store, { layout: 'grid' as 'rows' }))).toBe('BAD_INPUT');
    expect(ioCode(() => exportSpritesheet(store, { layout: 'rows', animations: [] }))).toBe(
      'BAD_INPUT',
    );
    expect(
      ioCode(() =>
        exportSpritesheet(store, {
          layout: 'rows',
          animations: [
            { group: 'idle', direction: 'side' },
            { group: 'idle', direction: 'side' },
          ],
        }),
      ),
    ).toBe('DUPLICATE_ANIMATION');
    expect(
      ioCode(() => exportSpritesheet(store, { layout: 'rows', animations: [{ group: 'nope' }] })),
    ).toBe('other'); // CoreError from resolveAnimation
  });
});
