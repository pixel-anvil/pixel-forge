// frame.duplicate: schema test and example test.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { frameDuplicate, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('frame.duplicate', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('frame.duplicate', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'frame', message: expect.any(String) as string }]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute(
      'frame.duplicate',
      need(frameDuplicate.examples[0]).input,
      run,
    );
    expect(out).toEqual({ frameId: expect.any(String) as string, frameIndex: 1, frames: 2 });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: frame.duplicate']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('reports an unknown frame', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute(
        'frame.duplicate',
        { doc: HERO_ID, animation: { group: 'default' }, frame: 5 },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
  });
});
