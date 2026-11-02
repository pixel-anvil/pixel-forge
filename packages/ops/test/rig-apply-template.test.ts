// rig.applyTemplate: schema test and example test.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigApplyTemplate } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('rig.applyTemplate', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const unknown = await rejection(
      registry.execute('rig.applyTemplate', { doc: HERO_ID, template: 'humanoid-top' }, run),
    );
    expect(unknown.code).toBe('BAD_INPUT');
    expect(unknown.details.issues).toEqual([
      { path: 'template', message: expect.any(String) as string },
    ]);
    const tiny = await rejection(
      registry.execute(
        'rig.applyTemplate',
        { doc: HERO_ID, template: 'humanoid-side', height: 4 },
        run,
      ),
    );
    expect(tiny.details.issues).toEqual([
      { path: 'height', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute(
      'rig.applyTemplate',
      need(rigApplyTemplate.examples[0]).input,
      run,
    );
    expect(out).toMatchObject({ viewId: expect.any(String) as string, created: [] });
    expect(Object.keys((out as { bones: object }).bones)).toHaveLength(17);
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: rig.applyTemplate']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('adds a new view for a template whose view does not exist yet', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'rig.applyTemplate',
      { doc: HERO_ID, template: 'humanoid-front' },
      run,
    )) as { viewId: string };
    expect(hero.store.doc.rig?.views.map((v) => v.name)).toEqual(['side', 'front']);
    expect(hero.store.doc.rig?.views[1]?.id).toBe(out.viewId);
  });

  it('refuses a view name that is taken, with nothing changed', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const err = await rejection(
      registry.execute('rig.applyTemplate', { doc: HERO_ID, template: 'humanoid-side' }, run),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'name-taken' } });
    expect(documentHash(hero.store)).toBe(before);
  });

  it('creates the rig when the document has none', async () => {
    const { hero, run } = await openHero();
    hero.store.transact('Drop rig', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    const out = await registry.execute(
      'rig.applyTemplate',
      { doc: HERO_ID, template: 'humanoid-side', height: 48 },
      run,
    );
    expect(out).toMatchObject({ created: expect.arrayContaining(['root', 'torso']) as string[] });
    expect(hero.store.doc.rig?.bones).toHaveLength(17);
  });
});
