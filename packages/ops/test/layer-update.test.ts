// layer.update: rename (unique names), visible, opacity, export; reference layers never export.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { layerUpdate, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

describe('layer.update', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 'Head' }, 'name'],
      [{ opacity: 256 }, 'opacity'],
      [{ visible: 'no' }, 'visible'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(
        registry.execute('layer.update', { doc: HERO_ID, layer: 'head', ...extra }, run),
      );
      expect(bad.code).toBe('BAD_INPUT');
      expect(bad.details.issues).toEqual([{ path, message: expect.any(String) as string }]);
    }
    const empty = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'head' }, run),
    );
    expect(empty.code).toBe('BAD_INPUT');
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute('layer.update', need(layerUpdate.examples[0]).input, run);
    expect(out).toMatchObject({ path: 'head', changed: ['visible'] });
    expect(hero.store.doc.layers.find((l) => l.name === 'head')?.visible).toBe(false);
    expect(stepLabels(hero)).toEqual(['AI: layer.update']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('renames (the part follows), sets opacity and export, and no-ops record nothing', async () => {
    const { hero, run } = await openHero();
    const out = await registry.execute(
      'layer.update',
      { doc: HERO_ID, layer: 'head', name: 'skull', opacity: 128, export: false },
      run,
    );
    expect(out).toMatchObject({ path: 'skull', changed: ['name', 'opacity', 'export'] });
    expect(hero.store.doc.layers.find((l) => l.name === 'skull')).toMatchObject({
      kind: 'part',
      opacity: 128,
      export: false,
    });
    const summary = (await registry.execute('doc.summary', { doc: HERO_ID }, run)) as {
      rig: { parts: { name: string }[] };
    };
    expect(summary.rig.parts.map((p) => p.name)).toContain('skull');
    const same = await registry.call(
      'layer.update',
      { doc: HERO_ID, layer: 'skull', opacity: 128 },
      run,
    );
    expect(same).toMatchObject({ ok: true, output: { changed: [] }, doc: { undoEntry: null } });
  });

  it('refuses a name that is taken and an unknown layer', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const taken = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'head', name: 'torso' }, run),
    );
    expect(taken).toMatchObject({ code: 'REFUSED', details: { reason: 'name-taken' } });
    expect(documentHash(hero.store)).toBe(hash);
    const missing = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'tail', visible: true }, run),
    );
    expect(missing).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'layer' } });
  });

  it('works inside groups and on reference layers', async () => {
    const { hero, run } = await openHero();
    hero.store.transact('add groups', (tx) => {
      const group = tx.newId('layer');
      const child = tx.newId('layer');
      const ref = tx.newId('layer');
      tx.update((d) => {
        d.layers.push({
          kind: 'group',
          id: group,
          name: 'art',
          visible: true,
          opacity: 255,
          export: true,
          children: [
            {
              kind: 'pixel',
              id: child,
              name: 'head',
              visible: true,
              opacity: 255,
              export: true,
              cels: {},
            },
            {
              kind: 'reference',
              id: ref,
              name: 'guide',
              visible: true,
              opacity: 255,
              export: false,
              cels: {},
            },
          ],
        });
      });
    });
    // "head" is now ambiguous between the part layer and the pixel layer: the path disambiguates
    const amb = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'head', visible: false }, run),
    );
    expect(amb.code).toBe('AMBIGUOUS');
    const out = await registry.execute(
      'layer.update',
      { doc: HERO_ID, layer: 'art/head', name: 'face' },
      run,
    );
    expect(out).toMatchObject({ path: 'art/face' });
    const ref = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'guide', export: true }, run),
    );
    expect(ref).toMatchObject({ code: 'REFUSED', details: { reason: 'reference-layer' } });
    // a sibling name clash inside the group
    const clash = await rejection(
      registry.execute('layer.update', { doc: HERO_ID, layer: 'art/face', name: 'guide' }, run),
    );
    expect(clash.details.reason).toBe('name-taken');
  });
});
