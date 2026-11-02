// frame.add: schema test and example test.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { frameAdd, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('frame.add', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('frame.add', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'frame', message: expect.any(String) as string }]);
    const badPosition = await rejection(
      registry.execute(
        'frame.add',
        { doc: HERO_ID, animation: { group: 'default' }, frame: 0, position: 'sideways' },
        run,
      ),
    );
    expect(badPosition.details.issues).toEqual([
      { path: 'position', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = await registry.execute('frame.add', need(frameAdd.examples[0]).input, run);
    expect(out).toEqual({ frameId: expect.any(String) as string, frameIndex: 1, frames: 2 });
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: frame.add']);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('inserts before the reference frame when asked', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'frame.add',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0, position: 'before' },
      run,
    )) as { frameId: string; frameIndex: number; frames: number };
    expect(out).toMatchObject({ frameIndex: 0, frames: 2 });
    const anim = hero.store.doc.animations[0];
    expect(anim !== undefined && 'frames' in anim ? anim.frames[0]?.id : undefined).toBe(
      out.frameId,
    );
  });

  it('reports an unknown frame', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute(
        'frame.add',
        { doc: HERO_ID, animation: { group: 'default' }, frame: 5 },
        run,
      ),
    );
    expect(err).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
  });
});
