import { describe, expect, it } from 'vitest';
import { fitHumanoid, humanoidSide, type TemplateLandmarks } from '../src/index.js';
import { errorCode } from './helpers.js';

const LM: TemplateLandmarks = {
  headTop: { x: 31, y: 16 },
  hips: { x: 30, y: 44 },
  feet: { x: 30, y: 63 },
  handR: { x: 38, y: 47 },
};

const len = (t: { bones: readonly { name: string; length: number }[] }, n: string): number =>
  t.bones.find((b) => b.name === n)?.length ?? -1;

describe('fitHumanoid', () => {
  it('puts the root at the feet and measures the height', () => {
    const f = fitHumanoid('side', LM);
    expect(f.height).toBe(47);
    expect(f.origin).toEqual({ x: 30, y: 63 });
    expect(f.template.bones.find((b) => b.name === 'root')?.rest).toMatchObject({ x: 30, y: 63 });
  });

  it('lands the hips and the head top on the landmarks', () => {
    const f = fitHumanoid('side', LM);
    const t = f.template;
    // Leg: ankle + shin + thigh (the foot length is the sole-to-ankle in side view: the foot bone is horizontal).
    const legs = 63 - 44;
    const thigh = len(t, 'thigh_l');
    const shin = len(t, 'shin_l');
    const rest = (n: string) => t.bones.find((b) => b.name === n)?.rest ?? { x: 0, y: 0, angle: 0 };
    // The hip pivot is rest.y above the pelvis... pelvis is the child of root: its offset is -(hip height).
    expect(rest('pelvis').y).toBe(-legs);
    expect(thigh + shin + len(fitHumanoid('front', LM).template, 'foot_l')).toBe(legs);
    // Body above the hips: pelvis + torso + neck + head reaches the top of the head.
    expect(len(t, 'pelvis') + len(t, 'torso') + len(t, 'neck') + len(t, 'head')).toBe(
      63 - 16 - legs,
    );
  });

  it('splits the arm over the hand landmark, and keeps the default arm without hands', () => {
    const f = fitHumanoid('side', LM);
    const arm =
      len(f.template, 'upper_arm_r') + len(f.template, 'lower_arm_r') + len(f.template, 'hand_r');
    const shoulderH = -(f.template.bones.find((b) => b.name === 'torso')?.rest.y ?? 0);
    expect(arm).toBeGreaterThan(0);
    // The fingertip is 16 px above the feet row (y 47).
    const pelvisTop = 19 + len(f.template, 'pelvis');
    const shoulder = pelvisTop + len(f.template, 'torso') - Math.round(0.03 * 47);
    expect(shoulder - arm).toBe(63 - 47);
    expect(shoulderH).toBeGreaterThan(0);
    const bare = fitHumanoid('side', { headTop: LM.headTop, hips: LM.hips, feet: LM.feet });
    expect(len(bare.template, 'upper_arm_r')).toBe(Math.round(0.14 * 47));
  });

  it('is deterministic ', () => {
    expect(fitHumanoid('front', LM)).toEqual(fitHumanoid('front', LM));
  });

  it('splits a default-shaped character like the default legs', () => {
    // 48 px, hips 22 px up: ankle 2, shin 10, thigh 10 as in DEFAULT_PROPORTIONS.
    const f = fitHumanoid('side', {
      headTop: { x: 0, y: -48 },
      hips: { x: 0, y: -22 },
      feet: { x: 0, y: 0 },
    });
    const d = humanoidSide({ height: 48 });
    for (const n of [
      'thigh_l',
      'shin_l',
      'pelvis',
      'neck',
      'upper_arm_l',
      'lower_arm_l',
      'hand_l',
    ]) {
      expect(len(f.template, n), n).toBe(len(d, n));
    }
  });

  it('builds front and back views too', () => {
    const front = fitHumanoid('front', LM).template;
    const back = fitHumanoid('back', LM).template;
    expect(front.view.name).toBe('front');
    expect(back.view.name).toBe('back');
    expect(front.bones.find((b) => b.name === 'upper_arm_l')?.rest.x).toBe(
      -(back.bones.find((b) => b.name === 'upper_arm_l')?.rest.x ?? 0),
    );
  });

  it('refuses bad landmarks', () => {
    const bad = (lm: TemplateLandmarks) => errorCode(() => fitHumanoid('side', lm));
    expect(bad({ ...LM, headTop: { x: 0, y: 1.5 } })).toBe('BAD_VALUE');
    expect(bad({ ...LM, hips: { x: 0, y: 70 } })).toBe('BAD_VALUE');
    expect(bad({ ...LM, hips: { x: 0, y: 10 } })).toBe('BAD_VALUE');
    expect(bad({ ...LM, headTop: { x: 0, y: 60 } })).toBe('BAD_VALUE');
    expect(bad({ ...LM, handR: { x: 0, y: 30 } })).toBe('BAD_VALUE');
    expect(bad({ ...LM, handR: { x: 0, y: 70 } })).toBe('BAD_VALUE');
  });
});
