// io.import: PNG / spritesheet with cell ranges, .aseprite add and re-import; failures change nothing.
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { expandCells, ioImport, registry } from '../src/index.js';
import {
  HERO_ID,
  fixtureBytes,
  flatHost,
  issues,
  need,
  openHero,
  rejection,
  stepLabels,
} from './helpers.js';

const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');
const sheet = (extra: Record<string, unknown>) => ({
  doc: HERO_ID,
  file: '/work/run.png',
  cell: [64, 64],
  ...extra,
});
const frames = (store: { doc: { animations: readonly object[] } }, group: string): number => {
  const a = store.doc.animations.find((x) => (x as { group: string }).group === group);
  return a !== undefined && 'frames' in a ? (a.frames as unknown[]).length : -1;
};

describe('expandCells', () => {
  it('expands tuples and ranges row-major, ascending or descending', () => {
    expect(expandCells([[1, 2], { row: 4, col: '3-6' }], 'x')).toEqual([
      [1, 2],
      [4, 3],
      [4, 4],
      [4, 5],
      [4, 6],
    ]);
    expect(expandCells([{ row: '0-1', col: '1-0' }], 'x')).toEqual([
      [0, 1],
      [0, 0],
      [1, 1],
      [1, 0],
    ]);
    expect(expandCells([{ row: 2, col: '5-5' }], 'x')).toEqual([[2, 5]]);
  });
});

describe('io.import (spritesheet)', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await flatHost();
    const cases: [Record<string, unknown>, string][] = [
      [{ animations: [{ group: 'a', cells: [] }] }, 'animations.0.cells'],
      [{ animations: [{ group: 'a', cells: [[0, -1]] }] }, 'animations.0.cells'],
      [{ animations: [{ group: 'A', cells: [[0, 0]] }] }, 'animations.0.group'],
      [{ animations: [{ group: 'a', cells: [{ row: 'x', col: 0 }] }] }, 'animations.0.cells'],
      [{ cell: [0, 64], animations: [{ group: 'a', cells: [[0, 0]] }] }, 'cell.0'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(registry.execute('io.import', sheet(extra), run));
      expect(bad.code).toBe('BAD_INPUT');
      expect(issues(bad)[0]?.path.startsWith(path)).toBe(true);
    }
  });

  it('runs its example: cells 0-2 of row 0 become an animation; reuses the body layer; one undo step', async () => {
    const { hosted, store, run } = await flatHost();
    const before = documentHash(store);
    const out = await registry.execute('io.import', need(ioImport.examples[0]).input, run);
    expect(out).toMatchObject({
      format: 'spritesheet',
      animations: ['move_gather'],
      layers: ['body'],
      frames: 3,
      images: 3,
      warnings: [],
    });
    expect(frames(store, 'move_gather')).toBe(3);
    const anim = store.doc.animations.find((a) => a.group === 'move_gather');
    expect(anim !== undefined && 'frames' in anim && anim.frames[0]?.durationMs).toBe(83);
    expect(stepLabels(hosted)).toEqual(['AI: io.import']);
    expect(errors(store)).toEqual([]);
    store.undo();
    expect(documentHash(store)).toBe(before);
  });

  it('expands ranges and repeats: repeated cells link, empty cells make empty frames', async () => {
    const { store, run } = await flatHost();
    const out = (await registry.execute(
      'io.import',
      sheet({
        animations: [
          {
            group: 'a',
            direction: 'side',
            loop: 'pingpong',
            durationMs: 40,
            cells: [{ row: '0-1', col: '0-2' }, [0, 0]],
          },
        ],
      }),
      run,
    )) as { frames: number; images: number };
    expect(out.frames).toBe(7);
    expect(out.images).toBeGreaterThan(0);
    expect(out.images).toBeLessThan(7);
    expect(store.doc.animations.find((a) => a.group === 'a')).toMatchObject({
      direction: 'side',
      loop: 'pingpong',
    });
    expect(errors(store)).toEqual([]);
  });

  it('takes a single image as one cell when cell is omitted, plus an outline layer', async () => {
    const { store, fs, run } = await flatHost();
    fs.seed('/work/idle_outline.png', fixtureBytes('cc0/hero_swordsman/idle.png'));
    const out = (await registry.execute(
      'io.import',
      {
        doc: HERO_ID,
        file: '/work/idle.png',
        outlineFile: '/work/idle_outline.png',
        outlineLayerName: 'line',
        animations: [{ group: 'still', cells: [[0, 0]] }],
      },
      run,
    )) as { layers: string[]; frames: number };
    expect(out).toMatchObject({ layers: ['body', 'line'], frames: 1 });
    expect(store.doc.layers.map((l) => l.name)).toContain('line');
  });

  it('works on a rigged document too (hero) and keeps it valid', async () => {
    const { hero, fs, run } = await openHero();
    fs.seed('/work/run.png', fixtureBytes('cc0/hero_swordsman/run.png'));
    await registry.execute(
      'io.import',
      sheet({
        layerName: 'ref_art',
        animations: [
          {
            group: 'cut',
            cells: [
              [0, 0],
              [0, 1],
            ],
          },
        ],
      }),
      run,
    );
    expect(frames(hero.store, 'cut')).toBe(2);
    expect(errors(hero.store)).toEqual([]);
  });

  it('maps failures and leaves the document untouched', async () => {
    const { hosted, store, fs, run } = await flatHost();
    const hash = documentHash(store);
    const fail = (input: Record<string, unknown>) =>
      rejection(registry.execute('io.import', input, run));
    const cells = [{ group: 'x', cells: [[0, 0]] }];
    expect(await fail(sheet({ animations: [{ group: 'x', cells: [[9, 9]] }] }))).toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(await fail(sheet({ animations: [{ group: 'run', cells: [[0, 0]] }] }))).toMatchObject({
      code: 'REFUSED',
    });
    expect(await fail(sheet({ animations: cells, file: '/work/missing.png' }))).toMatchObject({
      code: 'IO_FAILED',
    });
    expect(await fail(sheet({ animations: cells, file: '/etc/run.png' }))).toMatchObject({
      code: 'NOT_ALLOWED',
    });
    fs.seed('/work/junk.png', new Uint8Array([1, 2, 3]));
    expect(
      await fail(sheet({ cell: undefined, animations: cells, file: '/work/junk.png' })),
    ).toMatchObject({
      code: 'BAD_FILE',
    });
    expect(await fail(sheet({ animations: cells, file: '/work/junk.png' }))).toMatchObject({
      code: 'BAD_FILE',
    });
    expect(
      await fail(sheet({ cell: [32, 32], animations: cells, outlineFile: '/work/idle.png' })),
    ).toMatchObject({
      code: 'REFUSED', // outline sheet of another size
    });
    expect(await fail(sheet({ file: '/work/x.dat', animations: cells }))).toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(await fail({ doc: HERO_ID, file: '/work/run.png' })).toMatchObject({
      code: 'BAD_INPUT',
    });
    const many = await fail(
      sheet({ animations: [{ group: 'x', cells: [{ row: '0-4095', col: '0-1' }] }] }),
    );
    expect(many.code).toBe('BAD_INPUT');
    expect(documentHash(store)).toBe(hash);
    expect(stepLabels(hosted)).toEqual([]);
  });
});

describe('io.import (aseprite)', () => {
  const seed = async (rel = 'aseprite/linked_cels.aseprite') => {
    const f = await flatHost();
    f.fs.seed('/work/linked.aseprite', fixtureBytes(rel));
    const made = (await registry.execute(
      'doc.create',
      { name: 'ase', width: 8, height: 8 },
      f.run,
    )) as { doc: string };
    return { ...f, doc: made.doc, target: f.host.get(made.doc as never) };
  };

  it('adds layers and animations from the file; a re-import of the same file changes nothing', async () => {
    const { doc, target, run } = await seed();
    const out = await registry.execute('io.import', { doc, file: '/work/linked.aseprite' }, run);
    expect(out).toMatchObject({
      format: 'aseprite',
      frames: 4,
      parts: { bound: 0, updated: 0, unbound: 0 },
    });
    expect((out as { animations: string[] }).animations.length).toBeGreaterThan(0);
    const store = need(target).store;
    expect(errors(store)).toEqual([]);
    expect(stepLabels(need(target))).toEqual(['AI: io.import']);
    const again = await registry.call(
      'io.import',
      { doc, file: '/work/linked.aseprite', reimport: true },
      run,
    );
    expect(again).toMatchObject({ ok: true, doc: { undoEntry: null } });
    expect(stepLabels(need(target))).toEqual(['AI: io.import']);
    // adding the same animation twice is refused and changes nothing
    const hash = documentHash(store);
    const dup = await rejection(
      registry.execute('io.import', { doc, file: '/work/linked.aseprite' }, run),
    );
    expect(dup.code).toBe('REFUSED');
    expect(documentHash(store)).toBe(hash);
  });

  it('refuses a canvas of another size, a broken file, and guesses .ase / format overrides', async () => {
    const { doc, fs, run } = await seed();
    const wrong = await rejection(
      registry.execute('io.import', { doc: HERO_ID, file: '/work/linked.aseprite' }, run),
    );
    expect(wrong).toMatchObject({ code: 'REFUSED' }); // the 64x64 flat doc vs an 8x8 file
    fs.seed('/work/bad.ase', new Uint8Array([0, 1, 2, 3]));
    const bad = await rejection(registry.execute('io.import', { doc, file: '/work/bad.ase' }, run));
    expect(bad.code).toBe('BAD_FILE');
    fs.seed('/work/odd.bin', fixtureBytes('aseprite/linked_cels.aseprite'));
    const out = await registry.execute(
      'io.import',
      { doc, file: '/work/odd.bin', format: 'aseprite' },
      run,
    );
    expect(out).toMatchObject({ format: 'aseprite', frames: 4 });
  });
});
