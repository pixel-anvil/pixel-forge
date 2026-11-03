// rig.setPose with "frames" and "keyAll" (T5.17): many frames, one undo step, and the interpolation trap.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const anim = { group: 'default' };
const N = 12;

async function twelve() {
  const h = await openHero();
  for (let i = 1; i < N; i++) {
    await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, h.run);
  }
  return h;
}

const frames = Array.from({ length: N }, (_, i) => ({
  frame: i,
  bones: { upper_arm_r: { angle: i * 5 }, torso: { angle: 0 - i } },
  parts: i === 0 ? { head: { z: 4 } } : undefined,
}));

interface Read {
  bones: Record<string, unknown>;
  parts: Record<string, unknown>;
}

describe('rig.setPose frames', () => {
  it('poses 12 frames in one call and one undo restores all of them', async () => {
    const { hero, run } = await twelve();
    const before = documentHash(hero.store);
    const entries = hero.store.historyInfo().entries.length;
    const out = await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frames },
      run,
    );
    expect(out).toMatchObject({
      frameIndex: 0,
      frames: Array.from({ length: N }, (_, i) => i),
      keyed: ['torso', 'upper_arm_r'],
      interpolated: [],
    });
    expect(hero.store.historyInfo().entries).toHaveLength(entries + 1);
    const a = hero.store.doc.animations[0];
    const last = a !== undefined && 'frames' in a ? a.frames[11] : undefined;
    expect(Object.values(last?.boneKeys ?? {})).toEqual(
      expect.arrayContaining([{ angle: 55 }, { angle: -11 }]),
    );
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('round-trips with rig.readPose on every frame', async () => {
    const { hero, run } = await twelve();
    await registry.execute('rig.setPose', { doc: HERO_ID, animation: anim, frames }, run);
    const all = [];
    for (let i = 0; i < N; i++) {
      const read = (await registry.execute(
        'rig.readPose',
        { doc: HERO_ID, animation: anim, frame: i },
        run,
      )) as Read;
      expect(read.bones).toMatchObject({ upper_arm_r: { angle: i * 5 }, torso: { angle: 0 - i } });
      all.push({ frame: i, bones: read.bones });
    }
    const hash = documentHash(hero.store);
    const back = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frames: all },
      run,
    )) as { changed: string[] };
    expect(back.changed).toEqual([]);
    expect(documentHash(hero.store)).toBe(hash);
  });

  it('names the bones that interpolate, and keyAll keys the rest at rest', async () => {
    const { hero, run } = await twelve();
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 11, bones: { torso: { angle: 9 } } },
      run,
    );
    const one = [{ frame: 0, bones: { upper_arm_r: { angle: 5 } } }];
    const partial = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frames: one },
      run,
    )) as { keyed: string[]; interpolated: string[] };
    expect(partial.keyed).toEqual(['upper_arm_r']);
    expect(partial.interpolated).toEqual(['torso']);
    const all = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, keyAll: true, frames: one },
      run,
    )) as { keyed: string[]; interpolated: string[] };
    expect(all.interpolated).toEqual([]);
    expect(all.keyed).toEqual(need(hero.store.doc.rig?.bones.map((b) => b.name).sort()));
    const a = hero.store.doc.animations[0];
    const f0 = a !== undefined && 'frames' in a ? a.frames[0] : undefined;
    const torso = need(hero.store.doc.rig?.bones.find((b) => b.name === 'torso')).id;
    expect(f0?.boneKeys[torso]).toEqual({ angle: 0 });
  });

  it('keeps old single-frame calls unchanged and refuses mixed or bad input', async () => {
    const { hero, run } = await twelve();
    const old = await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 2, bones: { torso: { angle: 3 } } },
      run,
    );
    expect(old).not.toHaveProperty('frames');
    expect(old).toMatchObject({ frameIndex: 2, changed: ['bones.torso'], keyed: ['torso'] });
    const version = hero.store.version;
    const bad = async (input: Record<string, unknown>) =>
      rejection(registry.execute('rig.setPose', { doc: HERO_ID, animation: anim, ...input }, run));
    const t = (angle: unknown) => ({ torso: { angle } });
    expect((await bad({ frame: 1, frames })).code).toBe('BAD_INPUT');
    expect((await bad({ bones: t(1) })).code).toBe('BAD_INPUT');
    const dup = [
      { frame: 1, bones: t(1) },
      { frame: 1, bones: t(2) },
    ];
    expect((await bad({ frames: dup })).code).toBe('BAD_INPUT');
    expect((await bad({ frames: [{ frame: 1, bones: t('x') }] })).code).toBe('BAD_INPUT');
    const missing = [
      { frame: 1, bones: t(1) },
      { frame: 99, bones: t(1) },
    ];
    expect((await bad({ frames: missing })).code).toBe('NOT_FOUND');
    expect(hero.store.version).toBe(version);
  });
});
