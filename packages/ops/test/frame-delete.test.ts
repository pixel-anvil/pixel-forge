// frame.delete: schema test and example test. A plain mutate op: no confirm, one undo step.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { frameDelete, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('frame.delete', () => {
  it('is a mutate op (no confirm), per spec 9.2', () => {
    expect(frameDelete.safety).toBe('mutate');
  });

  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('frame.delete', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'frame', message: expect.any(String) as string }]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    // The hero has one frame; the example deletes frame 1, so add it first.
    await registry.execute(
      'frame.add',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0 },
      run,
    );
    const before = documentHash(hero.store);
    const out = await registry.execute('frame.delete', need(frameDelete.examples[0]).input, run);
    expect(out).toEqual({ frameId: expect.any(String) as string, frames: 1 });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'AI: frame.add',
      'AI: frame.delete',
    ]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.canRedo).toBe(true);
  });

  it('refuses to delete the only frame, with nothing changed', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const err = await rejection(
      registry.execute(
        'frame.delete',
        { doc: HERO_ID, animation: { group: 'default' }, frame: 0 },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'last-frame' } });
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.canUndo).toBe(false);
  });
});
