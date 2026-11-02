// anim.create: a new animation with empty frames; I6 uniqueness and the name grammar (I7).
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { animCreate, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

describe('anim.create', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const names = ['Run', 'a b', '__proto__', ''];
    for (const group of names) {
      const bad = await rejection(registry.execute('anim.create', { doc: HERO_ID, group }, run));
      expect(bad.code).toBe('BAD_INPUT');
      expect(bad.details.issues).toEqual([
        { path: 'group', message: expect.any(String) as string },
      ]);
    }
    const dir = await rejection(
      registry.execute('anim.create', { doc: HERO_ID, group: 'run', direction: 'default' }, run),
    );
    expect(dir.details.issues).toEqual([
      { path: 'direction', message: expect.any(String) as string },
    ]);
    const quantum = await rejection(
      registry.execute('anim.create', { doc: HERO_ID, group: 'run', angleQuantum: 7 }, run),
    );
    expect(quantum.details.issues).toEqual([
      { path: 'angleQuantum', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = (await registry.execute(
      'anim.create',
      need(animCreate.examples[0]).input,
      run,
    )) as {
      animation: string;
      label: string;
      frameIds: string[];
    };
    expect(out.label).toBe('run/side');
    expect(out.frameIds).toHaveLength(4);
    expect(stepLabels(hero)).toEqual(['AI: anim.create']);
    const anim = need(hero.store.doc.animations.find((a) => a.id === out.animation));
    expect(anim).toMatchObject({ group: 'run', direction: 'side', loop: 'loop', overrides: [] });
    expect('frames' in anim && anim.frames.map((f) => [f.id, f.durationMs])).toEqual(
      out.frameIds.map((id) => [id, 100]),
    );
    expect(validate(hero.store).filter((f) => f.severity === 'error')).toEqual([]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('takes loop, duration and angle quantum, and leaves an undirected animation without direction', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'anim.create',
      {
        doc: HERO_ID,
        group: 'idle',
        loop: 'pingpong',
        frames: 2,
        durationMs: 250,
        angleQuantum: 0.5,
      },
      run,
    );
    const anim = need(hero.store.doc.animations.find((a) => a.group === 'idle'));
    expect(anim).toMatchObject({ loop: 'pingpong', angleQuantum: 0.5 });
    expect('direction' in anim).toBe(false);
  });

  it('refuses a duplicate (group, direction) and changes nothing', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const dup = await rejection(
      registry.execute('anim.create', { doc: HERO_ID, group: 'default' }, run),
    );
    expect(dup).toMatchObject({ code: 'REFUSED', details: { reason: 'animation-exists' } });
    expect(documentHash(hero.store)).toBe(hash);
    // the same group in another direction is fine
    await registry.execute(
      'anim.create',
      { doc: HERO_ID, group: 'default', direction: 'side' },
      run,
    );
    expect(hero.store.doc.animations).toHaveLength(2);
  });
});
