import type { BoneId, BoneKey } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { copyPose, mirrorBoneName, pastePose } from '../src/index.js';
import { bone, errorCode } from './helpers.js';

const rig = {
  bones: [
    { id: bone('hip'), name: 'hip' },
    { id: bone('arm_l'), name: 'arm_l' },
    { id: bone('arm_r'), name: 'arm_r' },
    { id: bone('leg_l'), name: 'leg_l' },
    { id: bone('tail_l'), name: 'tail_l' },
  ],
};
const frame = {
  boneKeys: {
    [bone('hip')]: { angle: 10, offset: { x: 3, y: -2 } },
    [bone('arm_l')]: { angle: 30, interp: 'step', flipX: true },
    [bone('arm_r')]: { angle: -45 },
    [bone('leg_l')]: { angle: 0, offset: { x: 0, y: 1 } },
  } as Partial<Record<BoneId, BoneKey>>,
};

describe('mirrorBoneName', () => {
  it('swaps the _l/_r suffix and leaves other names alone', () => {
    expect(mirrorBoneName('arm_l')).toBe('arm_r');
    expect(mirrorBoneName('arm_r')).toBe('arm_l');
    expect(mirrorBoneName('hip')).toBe('hip');
    expect(mirrorBoneName('_l')).toBe('_l');
    expect(mirrorBoneName('hand_l_r')).toBe('hand_l_l');
    expect(mirrorBoneName('girl')).toBe('girl');
  });
});

describe('copyPose / pastePose', () => {
  const clip = copyPose(rig, frame);

  it('copies the keys of the frame by bone name, as copies', () => {
    expect(Object.keys(clip.bones).sort()).toEqual(['arm_l', 'arm_r', 'hip', 'leg_l']);
    expect(clip.bones.hip).toEqual({ angle: 10, offset: { x: 3, y: -2 } });
    expect(clip.bones.hip).not.toBe(frame.boneKeys[bone('hip')]);
  });

  it('plain paste keeps names and values', () => {
    const { keys, skipped } = pastePose(rig, clip);
    expect(skipped).toEqual([]);
    expect(keys[bone('arm_l')]).toEqual({ angle: 30, interp: 'step', flipX: true });
    expect(keys[bone('hip')]).toEqual({ angle: 10, offset: { x: 3, y: -2 } });
  });

  it('mirrored paste swaps _l/_r and negates angles (hand-written expectation)', () => {
    const { keys, skipped } = pastePose(rig, clip, { mirrored: true });
    // arm_l (30) lands on arm_r as -30; arm_r (-45) lands on arm_l as 45.
    expect(keys[bone('arm_r')]).toEqual({ angle: -30, interp: 'step', flipX: true });
    expect(keys[bone('arm_l')]).toEqual({ angle: 45 });
    // a centre bone keeps its name; angle and offset x negated, offset y kept
    expect(keys[bone('hip')]).toEqual({ angle: -10, offset: { x: -3, y: -2 } });
    // leg_l has no leg_r: skipped, not pasted onto anything else; zero stays +0
    expect(skipped).toEqual(['leg_l']);
    expect(Object.is(keys[bone('arm_l')]?.angle, 45)).toBe(true);
    expect(Object.keys(keys)).toHaveLength(3);
  });

  it('mirroring twice is the identity on the paired bones', () => {
    const once = pastePose(rig, clip, { mirrored: true }).keys;
    const sym = {
      bones: [
        { id: bone('a_l'), name: 'a_l' },
        { id: bone('a_r'), name: 'a_r' },
      ],
    };
    const c = { bones: { a_l: { angle: 7, offset: { x: 2, y: 3 } }, a_r: { angle: -1 } } };
    const m1 = pastePose(sym, c, { mirrored: true }).keys;
    const back = pastePose(sym, copyPose(sym, { boneKeys: m1 }), { mirrored: true }).keys;
    expect(back[bone('a_l')]).toEqual(c.bones.a_l);
    expect(back[bone('a_r')]).toEqual(c.bones.a_r);
    expect(once[bone('hip')]?.angle).toBe(-10);
  });

  it('a negated angle is never -0, and duplicate names are refused', () => {
    const c = { bones: { hip: { angle: 0 } } };
    const k = pastePose(rig, c, { mirrored: true }).keys[bone('hip')];
    expect(Object.is(k?.angle, 0)).toBe(true);
    const dup = { bones: [rig.bones[0], { id: bone('x'), name: 'hip' }] as typeof rig.bones };
    expect(errorCode(() => pastePose(dup, c))).toBe('BAD_VALUE');
    expect(errorCode(() => copyPose(dup, frame))).toBe('BAD_VALUE');
  });
});
