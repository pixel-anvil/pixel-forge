// rig.mirrorAnimation: a derived flipped copy under another direction (I6).
import { documentHash, imageHash, renderFrame, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigMirrorAnimation } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

describe('rig.mirrorAnimation', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'rig.mirrorAnimation',
        { doc: HERO_ID, source: { group: 'default' }, direction: 'default' },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([
      { path: 'direction', message: expect.any(String) as string },
    ]);
  });

  it('runs its example as one undo step; the mirror renders and holds no frames', async () => {
    const { hero, host, run } = await openHero();
    const before = documentHash(hero.store);
    const out = (await registry.execute(
      'rig.mirrorAnimation',
      need(rigMirrorAnimation.examples[0]).input,
      run,
    )) as { animation: string };
    expect(out).toMatchObject({ label: 'default/left', mirrorOf: 'default' });
    const anim = need(hero.store.doc.animations.find((a) => a.id === out.animation));
    expect(anim).toMatchObject({ group: 'default', direction: 'left', overrides: [] });
    expect('frames' in anim).toBe(false);
    expect(stepLabels(hero)).toEqual(['AI: rig.mirrorAnimation']);
    expect(validate(hero.store).filter((f) => f.severity === 'error')).toEqual([]);
    const flipped = renderFrame(hero.store, { id: anim.id }, 0, { rig: host.renderer });
    const source = renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer });
    expect(imageHash(flipped)).not.toBe(imageHash(source)); // an asymmetric hero flips
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('refuses a mirror of a mirror, a taken direction and an unknown source', async () => {
    const { hero, run } = await openHero();
    const mirror = (source: object, direction: string) =>
      registry.execute('rig.mirrorAnimation', { doc: HERO_ID, source, direction }, run);
    await mirror({ group: 'default' }, 'left');
    const twice = await rejection(mirror({ group: 'default', direction: 'left' }, 'right'));
    expect(twice).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-of-mirror' } });
    const taken = await rejection(mirror({ group: 'default' }, 'left'));
    expect(taken).toMatchObject({ code: 'REFUSED', details: { reason: 'animation-exists' } });
    const same = await rejection(
      mirror({ group: 'default' }, 'right').then(() => mirror({ group: 'default' }, 'right')),
    );
    expect(same.details.reason).toBe('animation-exists');
    const unknown = await rejection(mirror({ group: 'swim' }, 'left'));
    expect(unknown).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'animation' } });
    expect(hero.store.doc.animations).toHaveLength(3);
  });
});
