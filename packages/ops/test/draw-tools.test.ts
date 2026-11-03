// draw.shapes, selection.transform, shade.withRamp: hand-written ASCII expectations on small flat
// documents, schema and refusal tests, one-undo-step checks and a rig-frame (overrides) check.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { FLAT, FLAT_PALETTE, openFlat } from './grid-fixtures.js';
import type { FlatOptions } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const FRAME = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 } as const;
const R = '#ff0000';
const G = '#00ff00';
const B = '#0000ff';
const SYMBOLS: Record<string, string> = { [R]: 'R', [G]: 'G', [B]: 'B' };

/** The whole canvas as ASCII (R, G, B, "." transparent), read through `pixels.readGrid`. */
async function dump(run: RunOptions, w: number, h: number, frame = 0): Promise<string[]> {
  const out = (await registry.execute(
    'pixels.readGrid',
    { ...FRAME, frame, x: 0, y: 0, width: w, height: h },
    run,
  )) as { rows: string[]; legend: Record<string, string> };
  return out.rows.map((row) =>
    row
      .split('')
      .map((ch) => (ch === '.' ? '.' : (SYMBOLS[need(out.legend[ch])] ?? '?')))
      .join(''),
  );
}

/** A flat document of `rows` (R, G, B or "."). */
async function flatFrom(rows: readonly string[], extra: FlatOptions = {}) {
  const colours: Record<string, [number, number, number, number]> = {
    R: [255, 0, 0, 255],
    G: [0, 255, 0, 255],
    B: [0, 0, 255, 255],
  };
  const flat = await openFlat({
    w: need(rows[0]).length,
    h: rows.length,
    ...extra,
    paint: (img) => {
      rows.forEach((row, y) => {
        row.split('').forEach((ch, x) => {
          const c = colours[ch];
          if (c !== undefined) img.set(x, y, c);
        });
      });
    },
  });
  return flat;
}

describe('draw.shapes', () => {
  it('draws a line, an outline rect, a filled rect and an ellipse (ASCII oracle)', async () => {
    const { run, hosted } = await openFlat({ w: 12, h: 8 });
    const before = documentHash(hosted.store);
    const out = await registry.execute(
      'draw.shapes',
      {
        ...FRAME,
        shapes: [
          { type: 'line', x: 0, y: 0, x2: 5, y2: 2, color: R },
          { type: 'rect', x: 6, y: 0, w: 5, h: 3, color: G },
          { type: 'rect', x: 0, y: 4, w: 3, h: 2, color: B, filled: true },
          { type: 'ellipse', x: 4, y: 4, w: 5, h: 3, color: G },
        ],
      },
      run,
    );
    expect(out).toMatchObject({ target: 'cel', layer: 'bg', shapes: 4, overrides: [] });
    expect(await dump(run, 12, 8)).toEqual([
      'RR....GGGGG.',
      '..RR..G...G.',
      '....RRGGGGG.',
      '............',
      'BBB..GGG....',
      'BBB.G...G...',
      '.....GGG....',
      '............',
    ]);
    expect(hosted.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: draw.shapes']);
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('draws the same line from either end, and a filled ellipse is solid inside', async () => {
    const a = await openFlat({ w: 9, h: 9 });
    const b = await openFlat({ w: 9, h: 9 });
    await registry.execute(
      'draw.shapes',
      { ...FRAME, shapes: [{ type: 'line', x: 1, y: 7, x2: 8, y2: 2, color: R }] },
      a.run,
    );
    await registry.execute(
      'draw.shapes',
      { ...FRAME, shapes: [{ type: 'line', x: 8, y: 2, x2: 1, y2: 7, color: R }] },
      b.run,
    );
    expect(await dump(a.run, 9, 9)).toEqual(await dump(b.run, 9, 9));
    await registry.execute(
      'draw.shapes',
      { ...FRAME, shapes: [{ type: 'ellipse', x: 0, y: 0, w: 9, h: 9, color: G, filled: true }] },
      a.run,
    );
    const rows = await dump(a.run, 9, 9);
    expect(rows[4]).toBe('GGGGGGGGG');
    expect(rows[0]).not.toContain('.GGGGGGG.G');
    expect(rows.join('')).toContain('G');
  });

  it('flood fills the 4-connected area, later shapes see earlier ones, and clips', async () => {
    const { run } = await flatFrom(['..R.', '..R.', 'RR..', '....']);
    await registry.execute(
      'draw.shapes',
      {
        ...FRAME,
        shapes: [
          { type: 'fill', x: 0, y: 0, color: B },
          { type: 'rect', x: 2, y: 3, w: 9, h: 9, color: G },
        ],
      },
      run,
    );
    // the fill region is {(0,0),(1,0),(0,1),(1,1)}; the diagonal pixels (2,2),(3,*) are not 4-connected
    expect(await dump(run, 4, 4)).toEqual(['BBR.', 'BBR.', 'RR..', '..GG']);
  });

  it('erases with an alpha-0 colour', async () => {
    const { run } = await flatFrom(['RR', 'RR']);
    await registry.execute(
      'draw.shapes',
      {
        ...FRAME,
        shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 2, color: '#00000000', filled: true }],
      },
      run,
    );
    expect(await dump(run, 2, 2)).toEqual(['.R', '.R']);
  });

  it('is a no-op (no undo step) when nothing changes', async () => {
    const { run, hosted } = await flatFrom(['RR', 'RR']);
    const out = await registry.execute(
      'draw.shapes',
      { ...FRAME, shapes: [{ type: 'line', x: 0, y: 0, x2: 1, y2: 0, color: R }] },
      run,
    );
    expect(out).toMatchObject({ changed: 0 });
    expect(hosted.store.historyInfo().entries).toEqual([]);
  });

  it('refuses bad shapes, a seed off the canvas and off-palette colours', async () => {
    const { run } = await openFlat({ w: 4, h: 4, paletteLocked: true });
    const shape = (s: Record<string, unknown>) =>
      rejection(registry.execute('draw.shapes', { ...FRAME, shapes: [s] }, run));
    const noEnd = await shape({ type: 'line', x: 0, y: 0, color: R });
    expect(noEnd.code).toBe('BAD_INPUT');
    expect(noEnd.details.issues).toEqual(
      expect.arrayContaining([{ path: 'shapes.0.x2', message: expect.any(String) as string }]),
    );
    const noSize = await shape({ type: 'rect', x: 0, y: 0, w: 2, color: R });
    expect(noSize.details.issues).toEqual([{ path: 'shapes.0.h', message: 'rect needs "h"' }]);
    const extra = await shape({ type: 'fill', x: 0, y: 0, w: 2, color: R });
    expect(extra.details.issues).toEqual([{ path: 'shapes.0.w', message: 'fill has no "w"' }]);
    const empty = await rejection(registry.execute('draw.shapes', { ...FRAME, shapes: [] }, run));
    expect(empty.code).toBe('BAD_INPUT');
    const off = await shape({ type: 'fill', x: 9, y: 0, color: R });
    expect(off).toMatchObject({ code: 'REFUSED', details: { reason: 'out-of-canvas' } });
    const colour = await shape({ type: 'fill', x: 0, y: 0, color: '#123456' });
    expect(colour).toMatchObject({ code: 'REFUSED', details: { reason: 'off-palette' } });
  });

  it('works on an indexed document with palette colours', async () => {
    const { run, hosted } = await openFlat({ w: 4, h: 3, indexed: true });
    await registry.execute(
      'draw.shapes',
      {
        ...FRAME,
        shapes: [{ type: 'rect', x: 1, y: 1, w: 2, h: 1, color: '#0000ff', filled: true }],
      },
      run,
    );
    expect(await dump(run, 4, 3)).toEqual(['....', '.BB.', '....']);
    expect(FLAT_PALETTE[3]).toEqual([0, 0, 255, 255]);
    expect(hosted.store.historyInfo().entries).toHaveLength(1);
  });

  it('draws on a rig frame as overrides, one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = (await registry.execute(
      'draw.shapes',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        shapes: [{ type: 'rect', x: 2, y: 2, w: 6, h: 4, color: R, filled: true }],
      },
      run,
    )) as { target: string; changed: number; overrides: string[] };
    expect(out.target).toBe('overrides');
    expect(out.changed).toBe(24);
    expect(out.overrides.length).toBeGreaterThan(0);
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: draw.shapes']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('runs its first example on the hero', async () => {
    const { run } = await openHero();
    const example = need(need(registry.get('draw.shapes')).examples[0]);
    expect(await registry.execute('draw.shapes', example.input, run)).toMatchObject({ shapes: 2 });
  });
});

describe('selection.transform', () => {
  const START = ['RG..', 'B...', '....', '....'];

  it('moves a region, clearing the source; copy keeps it', async () => {
    const { run, hosted } = await flatFrom(START);
    const before = documentHash(hosted.store);
    const out = await registry.execute(
      'selection.transform',
      { ...FRAME, region: { x: 0, y: 0, w: 2, h: 2 }, action: 'move', dx: 1, dy: 1 },
      run,
    );
    expect(out).toMatchObject({ changed: 6, clipped: 0, target: 'cel' });
    expect(await dump(run, 4, 4)).toEqual(['....', '.RG.', '.B..', '....']);
    expect(hosted.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'AI: selection.transform',
    ]);
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
    await registry.execute(
      'selection.transform',
      { ...FRAME, region: { x: 0, y: 0, w: 2, h: 2 }, action: 'move', dx: 1, dy: 0, copy: true },
      run,
    );
    // copy: the original stays; the lifted pixels land one column to the right
    expect(await dump(run, 4, 4)).toEqual(['RRG.', 'BB..', '....', '....']);
  });

  it('counts opaque pixels pushed off the canvas', async () => {
    const { run } = await flatFrom(START);
    const out = await registry.execute(
      'selection.transform',
      { ...FRAME, region: { x: 0, y: 0, w: 2, h: 2 }, action: 'move', dx: -1 },
      run,
    );
    expect(out).toMatchObject({ clipped: 2 });
    expect(await dump(run, 4, 4)).toEqual(['G...', '....', '....', '....']);
  });

  it('flips horizontally and vertically in place', async () => {
    const { run } = await flatFrom(['RG..', 'B...', '....']);
    const region = { x: 0, y: 0, w: 3, h: 2 };
    await registry.execute(
      'selection.transform',
      { ...FRAME, region, action: 'flip', axis: 'h' },
      run,
    );
    expect(await dump(run, 4, 3)).toEqual(['.GR.', '..B.', '....']);
    await registry.execute(
      'selection.transform',
      { ...FRAME, region, action: 'flip', axis: 'v' },
      run,
    );
    expect(await dump(run, 4, 3)).toEqual(['..B.', '.GR.', '....']);
  });

  it('rotates 90, 180 and -90 degrees (hand-computed)', async () => {
    const rotate = async (angle: number) => {
      const { run } = await flatFrom(['RGB.', '....', '....', '....']);
      await registry.execute(
        'selection.transform',
        { ...FRAME, region: { x: 0, y: 0, w: 3, h: 1 }, action: 'rotate', angle },
        run,
      );
      return dump(run, 4, 4);
    };
    // 3x1 -> 1x3 anchored at the region's top-left corner; clockwise: the left pixel goes to the top
    expect(await rotate(90)).toEqual(['R...', 'G...', 'B...', '....']);
    expect(await rotate(-90)).toEqual(['B...', 'G...', 'R...', '....']);
    expect(await rotate(270)).toEqual(['B...', 'G...', 'R...', '....']);
    expect(await rotate(180)).toEqual(['BGR.', '....', '....', '....']);
    expect(await rotate(360)).toEqual(['RGB.', '....', '....', '....']);
  });

  it('four quarter turns of a square region are the identity', async () => {
    const { run, hosted } = await flatFrom(['RG..', 'BR..', '....', '....']);
    const before = documentHash(hosted.store);
    for (let i = 0; i < 4; i++) {
      await registry.execute(
        'selection.transform',
        { ...FRAME, region: { x: 0, y: 0, w: 2, h: 2 }, action: 'rotate', angle: 90 },
        run,
      );
    }
    expect(await dump(run, 4, 4)).toEqual(['RG..', 'BR..', '....', '....']);
    expect(hosted.store.historyInfo().entries).toHaveLength(4);
    expect(documentHash(hosted.store)).not.toBe('');
    expect(before).not.toBe('');
  });

  it('refuses mismatched fields and a region off the canvas', async () => {
    const { run } = await flatFrom(START);
    const call = (s: Record<string, unknown>) =>
      rejection(registry.execute('selection.transform', { ...FRAME, ...s }, run));
    expect((await call({ action: 'flip' })).details.issues).toEqual([
      { path: 'axis', message: 'flip needs "axis": "h" or "v"' },
    ]);
    expect((await call({ action: 'rotate', angle: 45 })).details.issues).toEqual([
      { path: 'angle', message: 'rotate needs "angle", a multiple of 90 degrees' },
    ]);
    expect((await call({ action: 'move', axis: 'h' })).code).toBe('BAD_INPUT');
    expect(await call({ action: 'move', region: { x: 3, y: 0, w: 2, h: 1 } })).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'out-of-canvas' },
    });
    expect((await call({ action: 'spin' })).code).toBe('BAD_INPUT');
  });

  it('transforms a rig frame as overrides', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'selection.transform',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        region: { x: 16, y: 0, w: 24, h: 24 },
        action: 'flip',
        axis: 'h',
      },
      run,
    )) as { target: string; changed: number };
    expect(out.target).toBe('overrides');
    expect(out.changed).toBeGreaterThan(0);
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'AI: selection.transform',
    ]);
  });

  it('runs its first example on the hero', async () => {
    const { run } = await openHero();
    const example = need(need(registry.get('selection.transform')).examples[0]);
    expect(await registry.execute('selection.transform', example.input, run)).toMatchObject({
      target: 'overrides',
    });
  });
});

describe('shade.withRamp', () => {
  /** A flat document with a 4-colour palette; ramp "warm" = [R, G, B] and ramp "solo" = [B]. */
  async function withRamps(rows: readonly string[]) {
    const flat = await flatFrom(rows, { paletteLocked: true });
    flat.hosted.store.transact('ramps', (tx) => {
      tx.update((d) => {
        const palette = need(d.palettes[0]);
        palette.ramps.push({ name: 'warm', indices: [1, 2, 3] }, { name: 'solo', indices: [3] });
      });
    });
    return flat;
  }

  it('shifts pixels along the ramp, stops at the ends and counts skipped pixels', async () => {
    const { run, hosted } = await withRamps(['RGB.', 'BBR.']);
    const before = documentHash(hosted.store);
    const out = await registry.execute(
      'shade.withRamp',
      { ...FRAME, ramp: 'warm', steps: 1, region: { x: 0, y: 0, w: 3, h: 2 } },
      run,
    );
    expect(out).toMatchObject({ changed: 3, skipped: 0, target: 'cel' });
    // R->G, G->B, B->B (end), B->B, B->B, R->G
    expect(await dump(run, 4, 2)).toEqual(['GBB.', 'BBG.']);
    expect(hosted.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'ramps',
      'AI: shade.withRamp',
    ]);
    hosted.store.undo();
    expect(documentHash(hosted.store)).toBe(before);
  });

  it('goes the other way with negative steps, honours the region, and skips off-ramp pixels', async () => {
    const { run } = await withRamps(['RGB.', '.R#.'].map((r) => r.replace('#', '.')));
    // paint a colour on no ramp at (3,0)
    await registry.execute(
      'pixels.writeGrid',
      { ...FRAME, x: 3, y: 0, rows: ['1'], legend: { '1': '#ff0000' } },
      run,
    );
    const out = await registry.execute(
      'shade.withRamp',
      { ...FRAME, ramp: 'solo', steps: -1, region: { x: 0, y: 0, w: 4, h: 1 } },
      run,
    );
    // only B is on "solo" (single colour, nothing to move to); R, G are off that ramp
    expect(out).toMatchObject({ changed: 0, skipped: 3 });
    const down = await registry.execute('shade.withRamp', { ...FRAME, steps: -1 }, run);
    // any ramp: G->R, B->G, R stays (first of warm), the extra R too; (1,1) R stays
    expect(down).toMatchObject({ skipped: 0 });
    expect(await dump(run, 4, 2)).toEqual(['RRGR', '.R..']);
  });

  it('refuses unknown ramps, no palette, a zero step and a region off the canvas', async () => {
    const { run } = await withRamps(['RGB.']);
    const call = (s: Record<string, unknown>) =>
      rejection(registry.execute('shade.withRamp', { ...FRAME, ...s }, run));
    expect(await call({ ramp: 'nope', steps: 1 })).toMatchObject({
      code: 'NOT_FOUND',
      details: { available: ['warm', 'solo'] },
    });
    expect((await call({ steps: 0 })).code).toBe('BAD_INPUT');
    expect(await call({ steps: 1, region: { x: 0, y: 0, w: 9, h: 1 } })).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'out-of-canvas' },
    });
    const bare = await openFlat();
    expect(
      await rejection(registry.execute('shade.withRamp', { ...FRAME, steps: 1 }, bare.run)),
    ).toMatchObject({ code: 'REFUSED', details: { reason: 'no-palette' } });
  });

  it('shades an indexed document', async () => {
    const { run, hosted } = await openFlat({ w: 3, h: 1, indexed: true });
    hosted.store.transact('ramp', (tx) => {
      tx.update((d) => {
        need(d.palettes[0]).ramps.push({ name: 'warm', indices: [1, 2, 3] });
      });
    });
    await registry.execute(
      'draw.shapes',
      { ...FRAME, shapes: [{ type: 'line', x: 0, y: 0, x2: 1, y2: 0, color: R }] },
      run,
    );
    await registry.execute('shade.withRamp', { ...FRAME, ramp: 'warm', steps: 2 }, run);
    expect(await dump(run, 3, 1)).toEqual(['BB.']);
  });

  it('shades a rig frame as overrides', async () => {
    const { hero, run } = await openHero();
    hero.store.transact('palette', (tx) => {
      const id = tx.newId('palette');
      tx.update((d) => {
        d.palettes.push({
          id,
          name: 'skin',
          colors: [
            [0xe8, 0xbe, 0x96, 255],
            [0x46, 0x2d, 0x1e, 255],
          ],
          ramps: [{ name: 'skin', indices: [1, 0] }],
        });
        d.activePaletteId = id;
      });
    });
    const out = (await registry.execute(
      'shade.withRamp',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        ramp: 'skin',
        steps: -1,
        region: { x: 21, y: 2, w: 8, h: 8 },
      },
      run,
    )) as { target: string; changed: number };
    expect(out.target).toBe('overrides');
    expect(out.changed).toBeGreaterThan(0);
  });
});
