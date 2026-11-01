// part.split: rect / lasso / flood selections on a flat layer, bound by name or overlap (W2b recomposite).
import { documentHash, imageHash, renderFrame, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { partSplit, registry } from '../src/index.js';
import { HERO_ID, flatHost, need, rejection, stepLabels, issues } from './helpers.js';

const base = { doc: HERO_ID, layer: 'body', animation: { group: 'run' }, frame: 0 };
const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');

describe('part.split', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await flatHost(true);
    const cases: [Record<string, unknown>, string][] = [
      [{ selection: { kind: 'rect', x: 0, y: 0, w: 0, h: 4 } }, 'selection.w'],
      [
        {
          selection: {
            kind: 'lasso',
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        },
        'selection.points',
      ],
      [{ selection: { kind: 'blob' } }, 'selection.kind'],
      [{ selection: { kind: 'flood', x: 1, y: 1, connectivity: 6 } }, 'selection.connectivity'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(registry.execute('part.split', { ...base, ...extra }, run));
      expect(bad.code).toBe('BAD_INPUT');
      expect(issues(bad)[0]).toMatchObject({ path });
    }
  });

  it('runs its example: the head is cut off, bound to the head bone, and the frame recomposites', async () => {
    const { hosted, host, store, run } = await flatHost(true);
    const render = (): string =>
      imageHash(renderFrame(store, { group: 'run' }, 0, { rig: host.renderer }));
    const before = documentHash(store);
    const frame0 = render();
    const out = (await registry.execute('part.split', need(partSplit.examples[0]).input, run)) as {
      pixels: number;
      bound?: { bone: string; view: string; how: string; merged: boolean };
    };
    expect(out.pixels).toBeGreaterThan(20);
    expect(out.bound).toMatchObject({ bone: 'head', view: 'side', how: 'name', merged: false });
    expect(stepLabels(hosted)).toEqual(['AI: part.split']);
    expect(store.doc.rig?.parts.map((p) => p.boneId)).toHaveLength(1);
    expect(render()).toBe(frame0); // W2b: the part plus the remainder equal the source frame
    expect(errors(store)).toEqual([]);
    store.undo();
    expect(documentHash(store)).toBe(before);
  });

  it('splits by lasso and by flood, binding by overlap when there is a clear winner', async () => {
    const { store, run } = await flatHost(true);
    const lasso = (await registry.execute(
      'part.split',
      {
        ...base,
        name: 'cap',
        selection: {
          kind: 'lasso',
          points: [
            [24, 16],
            [40, 16],
            [40, 26],
            [24, 26],
          ],
        },
        bind: false,
      },
      run,
    )) as { layer: string; pixels: number; bound?: object };
    expect(lasso.pixels).toBeGreaterThan(0);
    expect(lasso.bound).toBeUndefined();
    expect(store.doc.layers.find((l) => l.id === lasso.layer)).toMatchObject({
      kind: 'pixel',
      name: 'cap',
    });
    const flood = (await registry.execute(
      'part.split',
      { ...base, selection: { kind: 'flood', x: 33, y: 40, connectivity: 8 } },
      run,
    )) as { pixels: number; ambiguous?: string[]; skipped?: string; bound?: object };
    expect(flood.pixels).toBeGreaterThan(0);
    // either a clear winner bound it, or it stayed a pixel layer and says why
    expect(
      flood.bound !== undefined || flood.ambiguous !== undefined || flood.skipped !== undefined,
    ).toBe(true);
    expect(errors(store)).toEqual([]);
  });

  it('keeps a layer as a plain pixel layer when the document has no rig', async () => {
    const { run } = await flatHost(false);
    const out = await registry.execute(
      'part.split',
      { ...base, selection: { kind: 'rect', x: 24, y: 16, w: 18, h: 12 } },
      run,
    );
    expect(out).not.toHaveProperty('bound');
  });

  it('maps core refusals: empty selection, unknown names, a mirror animation', async () => {
    const { run } = await flatHost(true);
    const empty = await rejection(
      registry.execute(
        'part.split',
        { ...base, selection: { kind: 'rect', x: 0, y: 0, w: 4, h: 4 } },
        run,
      ),
    );
    expect(empty).toMatchObject({ code: 'REFUSED', details: { reason: 'empty-selection' } });
    const rect = { kind: 'rect', x: 24, y: 16, w: 18, h: 12 };
    const bone = await rejection(
      registry.execute('part.split', { ...base, selection: rect, partName: 'part:tail' }, run),
    );
    expect(bone).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'bone' } });
    const layer = await rejection(
      registry.execute('part.split', { ...base, layer: 'nope', selection: rect }, run),
    );
    expect(layer).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'layer' } });
    const view = await rejection(
      registry.execute('part.split', { ...base, view: 'back', selection: rect }, run),
    );
    expect(view).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'view' } });
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: { group: 'run' }, direction: 'left' },
      run,
    );
    const mirror = await rejection(
      registry.execute(
        'part.split',
        { ...base, animation: { group: 'run', direction: 'left' }, selection: rect },
        run,
      ),
    );
    expect(mirror).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-animation' } });
  });
});
