// anim.update: rename (I6), loop, quantum, post-passes; mirrors follow their source's group.
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { animUpdate, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');

describe('anim.update', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const anim = { group: 'default' };
    const cases: [Record<string, unknown>, string][] = [
      [{ group: 'Run' }, 'group'],
      [{ direction: 'default' }, 'direction'],
      [{ loop: 'forever' }, 'loop'],
      [{ angleQuantum: 7 }, 'angleQuantum'],
      [{ postPasses: { outline: { color: [1, 2, 3] } } }, 'postPasses.outline.color'],
    ];
    for (const [extra, path] of cases) {
      const bad = await rejection(
        registry.execute('anim.update', { doc: HERO_ID, animation: anim, ...extra }, run),
      );
      expect(bad.code).toBe('BAD_INPUT');
      expect(bad.details.issues).toEqual([{ path, message: expect.any(String) as string }]);
    }
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute('anim.update', need(animUpdate.examples[0]).input, run);
    expect(out).toMatchObject({ label: 'default', changed: ['loop'], mirrors: [] });
    expect(hero.store.doc.animations[0]).toMatchObject({ loop: 'pingpong' });
    expect(stepLabels(hero)).toEqual(['AI: anim.update']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('sets and clears direction, quantum and post-passes; records nothing for a no-op', async () => {
    const { hero, run } = await openHero();
    const up = (extra: Record<string, unknown>) =>
      registry.call(
        'anim.update',
        { doc: HERO_ID, animation: { group: 'default' }, ...extra },
        run,
      );
    const anim = () => hero.store.doc.animations[0];
    await up({
      angleQuantum: 0.5,
      postPasses: { removeOrphans: {}, outline: { color: [0, 0, 0, 255] } },
    });
    expect(anim()).toMatchObject({
      angleQuantum: 0.5,
      postPasses: { removeOrphans: {}, outline: { color: [0, 0, 0, 255] } },
    });
    const same = await up({ angleQuantum: 0.5 });
    expect(same).toMatchObject({ ok: true, output: { changed: [] }, doc: { undoEntry: null } });
    await up({ angleQuantum: null, postPasses: null, direction: 'side' });
    expect(anim()).toMatchObject({ direction: 'side' });
    expect(anim()).not.toHaveProperty('angleQuantum');
    expect(anim()).not.toHaveProperty('postPasses');
    await registry.execute(
      'anim.update',
      { doc: HERO_ID, animation: { group: 'default', direction: 'side' }, direction: null },
      run,
    );
    expect(anim()).not.toHaveProperty('direction');
    expect(errors(hero.store)).toEqual([]);
  });

  it('refuses a rename that breaks I6 and changes nothing', async () => {
    const { hero, run } = await openHero();
    await registry.execute('anim.create', { doc: HERO_ID, group: 'run', direction: 'side' }, run);
    const hash = documentHash(hero.store);
    const clash = await rejection(
      registry.execute(
        'anim.update',
        { doc: HERO_ID, animation: { group: 'default' }, group: 'run', direction: 'side' },
        run,
      ),
    );
    expect(clash).toMatchObject({ code: 'REFUSED', details: { reason: 'animation-exists' } });
    expect(documentHash(hero.store)).toBe(hash);
  });

  it("renames a source together with its mirrors; a mirror keeps its source's group", async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: { group: 'default' }, direction: 'left' },
      run,
    );
    const out = await registry.execute(
      'anim.update',
      { doc: HERO_ID, animation: { group: 'default' }, group: 'idle' },
      run,
    );
    expect(out).toMatchObject({ label: 'idle', changed: ['group'], mirrors: ['idle/left'] });
    expect(hero.store.doc.animations.map((a) => a.group)).toEqual(['idle', 'idle']);
    expect(errors(hero.store)).toEqual([]);

    const mirror = { group: 'idle', direction: 'left' };
    const group = await rejection(
      registry.execute('anim.update', { doc: HERO_ID, animation: mirror, group: 'walk' }, run),
    );
    expect(group).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-group' } });
    const loop = await rejection(
      registry.execute('anim.update', { doc: HERO_ID, animation: mirror, loop: 'once' }, run),
    );
    expect(loop).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-animation' } });
    // a mirror's direction can change
    await registry.execute(
      'anim.update',
      { doc: HERO_ID, animation: mirror, direction: 'west' },
      run,
    );
    expect(hero.store.doc.animations[1]).toMatchObject({ group: 'idle', direction: 'west' });
    // a rename that makes a mirror clash is refused
    await registry.execute('anim.create', { doc: HERO_ID, group: 'walk', direction: 'west' }, run);
    const mirrorClash = await rejection(
      registry.execute(
        'anim.update',
        { doc: HERO_ID, animation: { group: 'idle' }, group: 'walk' },
        run,
      ),
    );
    expect(mirrorClash.details.reason).toBe('animation-exists');
  });
});
