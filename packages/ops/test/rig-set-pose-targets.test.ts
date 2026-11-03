// rig.setPose end-effector targets (E1.2, FR-AI-17): IK baked to plain FK angle keys.
import { documentHash } from '@pixel-forge/core';
import { resolvePose, snapSkeleton } from '@pixel-forge/rig';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const anim = { group: 'default' };

interface Out {
  keyed: string[];
  changed: string[];
  targets?: {
    frame: number;
    bone: string;
    target: { x: number; y: number };
    effector: { x: number; y: number };
    reached: boolean;
    keyed: string[];
  }[];
}

/** Where a bone really is after the call, by independent FK on the stored keys. */
function pivotOf(hero: Awaited<ReturnType<typeof openHero>>['hero'], bone: string, frame = 0) {
  const doc = hero.store.doc;
  const rig = need(doc.rig);
  const a = need(doc.animations[0]);
  if (!('frames' in a)) throw new Error('mirror');
  const sk = snapSkeleton(rig, need(rig.views[0]), resolvePose(rig, a, frame), {
    angleQuantum: a.angleQuantum ?? 1,
  });
  return need(sk.bones.get(need(rig.bones.find((b) => b.name === bone)).id)).pivot;
}

describe('rig.setPose targets', () => {
  it('puts hand_r on (30,22) within 1 px and stores plain FK keys', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const entries = hero.store.historyInfo().entries.length;
    const out = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, targets: { hand_r: { x: 30, y: 22 } } },
      run,
    )) as Out;
    expect(out.targets).toHaveLength(1);
    expect(out.targets?.[0]).toMatchObject({ bone: 'hand_r', reached: true });
    expect(out.targets?.[0]?.keyed).toEqual(['upper_arm_r', 'lower_arm_r']);
    expect(out.keyed).toEqual(['lower_arm_r', 'upper_arm_r']);
    const p = pivotOf(hero, 'hand_r');
    expect(Math.abs(p.x - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - 22)).toBeLessThanOrEqual(1);
    expect(out.targets?.[0]?.effector).toEqual(p);
    // Plain FK: only angle channels, nothing about IK.
    const a = need(hero.store.doc.animations[0]);
    const keys = 'frames' in a ? Object.values(a.frames[0]?.boneKeys ?? {}) : [];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(Object.keys(k)).toEqual(['angle']);
    expect(hero.store.historyInfo().entries).toHaveLength(entries + 1);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('puts hand_r on (26,30) with a chain of 3 (torso, upper and lower arm)', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, targets: { hand_r: { x: 26, y: 30, chain: 3 } } },
      run,
    )) as Out;
    expect(out.targets?.[0]).toMatchObject({
      reached: true,
      keyed: ['torso', 'upper_arm_r', 'lower_arm_r'],
    });
    const p = pivotOf(hero, 'hand_r');
    expect(Math.abs(p.x - 26)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - 30)).toBeLessThanOrEqual(1);
  });

  it('reports reached false for a target out of reach', async () => {
    const { run } = await openHero();
    const out = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, targets: { hand_r: { x: 60, y: 30 } } },
      run,
    )) as Out;
    expect(out.targets?.[0]?.reached).toBe(false);
    expect(out.targets?.[0]?.target).toEqual({ x: 60, y: 30 });
  });

  it('honours bend and chain, and combines with bones and several frames', async () => {
    const { hero, run } = await openHero();
    await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, run);
    const at = { x: 30, y: 22 };
    const cw = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, targets: { hand_r: { ...at, bend: 'cw' } } },
      run,
    )) as Out;
    const ccw = (await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 1, targets: { hand_r: { ...at, bend: 'ccw' } } },
      run,
    )) as Out;
    expect(cw.targets?.[0]?.reached).toBe(true);
    expect(ccw.targets?.[0]?.reached).toBe(true);
    expect(pivotOf(hero, 'lower_arm_r', 0)).not.toEqual(pivotOf(hero, 'lower_arm_r', 1));
    // Mixed: torso is set by hand and the target is solved on top of it.
    const out = (await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: anim,
        frames: [
          {
            frame: 0,
            bones: { head: { angle: 10 } },
            targets: { hand_r: { x: 26, y: 28, chain: 3 } },
          },
          { frame: 1, targets: { hand_r: at } },
        ],
      },
      run,
    )) as Out;
    expect(out.targets?.map((x) => x.frame)).toEqual([0, 1]);
    expect(out.targets?.[0]?.keyed).toHaveLength(3);
    expect(out.keyed).toContain('head');
    const p = pivotOf(hero, 'hand_r', 0);
    expect(Math.abs(p.x - 26)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - 28)).toBeLessThanOrEqual(1);
  });

  it('refuses bad input and leaves the document alone', async () => {
    const { hero, run } = await openHero();
    const version = hero.store.version;
    const bad = async (input: Record<string, unknown>) =>
      rejection(
        registry.execute('rig.setPose', { doc: HERO_ID, animation: anim, frame: 0, ...input }, run),
      );
    const h = { x: 24, y: 30 };
    expect((await bad({ targets: { nope: h } })).code).toBe('NOT_FOUND');
    expect((await bad({ targets: { hand_r: { x: 1.5, y: 2 } } })).code).toBe('BAD_INPUT');
    expect((await bad({ targets: { hand_r: { ...h, chain: 3, bend: 'cw' } } })).code).toBe(
      'INVALID_VALUE',
    );
    expect((await bad({ targets: { root: h } })).code).toBe('INVALID_VALUE');
    expect(hero.store.version).toBe(version);
  });

  const near = (p: { x: number; y: number }, x: number, y: number) => {
    expect(Math.abs(p.x - x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - y)).toBeLessThanOrEqual(1);
  };

  it('starts the solve from the other frames this call poses (interpolated torso)', async () => {
    const { hero, run } = await openHero();
    for (let i = 0; i < 4; i++) {
      await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, run);
    }
    await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: anim,
        frames: [
          { frame: 0, bones: { torso: { angle: 20 } } },
          { frame: 2, targets: { hand_r: { x: 30, y: 22 } } },
          { frame: 4, bones: { torso: { angle: 20 } } },
        ],
      },
      run,
    );
    // The torso is not keyed on frame 2, so it holds 20 there: the arm must reach with it.
    near(pivotOf(hero, 'hand_r', 2), 30, 22);
  });

  it('honours a null removal in the same call when it starts the solve', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, bones: { torso: { angle: 25 } } },
      run,
    );
    const out = (await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: anim,
        frame: 0,
        bones: { torso: null },
        targets: { hand_r: { x: 30, y: 22 } },
      },
      run,
    )) as Out;
    const a = need(hero.store.doc.animations[0]);
    const keys = 'frames' in a ? (a.frames[0]?.boneKeys ?? {}) : {};
    const torso = need(hero.store.doc.rig?.bones.find((b) => b.name === 'torso')).id;
    expect(keys[torso]).toBeUndefined();
    expect(out.targets?.[0]?.reached).toBe(true);
    near(pivotOf(hero, 'hand_r'), 30, 22);
  });

  it('lets two targets share a chain bone, the later solve winning', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: anim,
        frame: 0,
        targets: { hand_r: { x: 26, y: 30, chain: 3 }, hand_l: { x: 14, y: 30, chain: 3 } },
      },
      run,
    )) as Out;
    expect(out.targets?.map((t) => t.bone)).toEqual(['hand_r', 'hand_l']);
    expect(out.targets?.[0]?.keyed).toContain('torso');
    expect(out.targets?.[1]?.keyed).toContain('torso');
    expect(out.targets?.[1]?.reached).toBe(true);
    near(pivotOf(hero, 'hand_l'), 14, 30);
  });

  it('lets a target override an explicit bones angle and keeps its other channels', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: anim,
        frame: 0,
        bones: { upper_arm_r: { angle: 5, offset: { x: 1, y: 0 } } },
        targets: { hand_r: { x: 30, y: 22 } },
      },
      run,
    )) as Out;
    expect(out.targets?.[0]?.reached).toBe(true);
    near(pivotOf(hero, 'hand_r'), 30, 22);
    const a = need(hero.store.doc.animations[0]);
    const id = need(hero.store.doc.rig?.bones.find((b) => b.name === 'upper_arm_r')).id;
    const key = 'frames' in a ? a.frames[0]?.boneKeys[id] : undefined;
    expect(key?.offset).toEqual({ x: 1, y: 0 });
    expect(key?.angle).not.toBe(5);
  });
});
