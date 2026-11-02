// rig.setPivot: moves the variant pivot; the render follows.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigSetPivot } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

describe('rig.setPivot', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'rig.setPivot',
        { doc: HERO_ID, part: 'lower_arm_r', pivot: { x: 1.5, y: 0 } },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([
      { path: 'pivot.x', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step and moves the rendered art', async () => {
    const { hero, host, run } = await openHero();
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const before = documentHash(hero.store);
    const frame0 = render();
    const out = await registry.execute('rig.setPivot', need(rigSetPivot.examples[0]).input, run);
    expect(out).toMatchObject({
      part: 'lower_arm_r',
      pivot: { x: 3, y: 1 },
      previous: { x: 1, y: 1 },
    });
    expect(stepLabels(hero)).toEqual(['AI: rig.setPivot']);
    expect(render()).not.toBe(frame0);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(render()).toBe(frame0);
  });

  it('picks a variant by name inside a view, and by id; same pivot records nothing', async () => {
    const { hero, run } = await openHero();
    const part = need(hero.store.doc.rig?.parts.find((p) => p.variants.length === 2));
    const sleeve = need(part.variants.find((v) => v.name === 'sleeve'));
    const out = await registry.execute(
      'rig.setPivot',
      { doc: HERO_ID, part: part.id, variant: 'sleeve', view: 'side', pivot: { x: 5, y: 5 } },
      run,
    );
    expect(out).toMatchObject({ variant: sleeve.id, pivot: { x: 5, y: 5 } });
    expect(
      hero.store.doc.rig?.parts
        .find((p) => p.id === part.id)
        ?.variants.find((v) => v.id === sleeve.id)?.pivot,
    ).toEqual({ x: 5, y: 5 });
    const same = await registry.call(
      'rig.setPivot',
      { doc: HERO_ID, part: part.id, variant: sleeve.id, pivot: { x: 5, y: 5 } },
      run,
    );
    expect(same).toMatchObject({ ok: true, doc: { undoEntry: null } });
  });

  it('reports unknown parts, variants and views with what exists', async () => {
    const { run } = await openHero();
    const set = (extra: Record<string, unknown>) =>
      rejection(
        registry.execute(
          'rig.setPivot',
          { doc: HERO_ID, part: 'head', pivot: { x: 1, y: 1 }, ...extra },
          run,
        ),
      );
    expect(await set({ part: 'tail' })).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'part' },
    });
    const variant = await set({ variant: 'cape' });
    expect(variant).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'variant', available: ['default'] },
    });
    expect(await set({ view: 'back' })).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'view' },
    });
  });
});
