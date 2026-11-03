// rig.copyPose: bone keys of one frame onto another, plain or mirrored; one undo step.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigCopyPose } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

const anim = { group: 'default' };

async function setup() {
  const h = await openHero();
  await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, h.run);
  await registry.execute(
    'rig.setPose',
    {
      doc: HERO_ID,
      animation: anim,
      frame: 0,
      bones: { upper_arm_r: { angle: 30, offset: { x: 2, y: 1 } }, torso: { angle: 4 } },
    },
    h.run,
  );
  return h;
}

const read = async (h: Awaited<ReturnType<typeof setup>>, frame: number) =>
  (await registry.execute('rig.readPose', { doc: HERO_ID, animation: anim, frame }, h.run)) as {
    keyed: string[];
    bones: Record<string, Record<string, unknown>>;
  };

describe('rig.copyPose', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'rig.copyPose',
        { doc: HERO_ID, from: { animation: anim, frame: 0 }, to: { animation: anim } },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([
      { path: 'to.frame', message: expect.any(String) as string },
    ]);
  });

  it('copies keys as one undo step, and undo restores the document', async () => {
    const h = await setup();
    const before = documentHash(h.hero.store);
    const steps = stepLabels(h.hero).length;
    const out = await registry.execute(
      'rig.copyPose',
      { doc: HERO_ID, from: { animation: anim, frame: 0 }, to: { animation: anim, frame: 1 } },
      h.run,
    );
    expect(out).toMatchObject({
      from: 'default #0',
      to: 'default #1',
      pasted: ['torso', 'upper_arm_r'],
      skipped: [],
    });
    expect(stepLabels(h.hero).length).toBe(steps + 1);
    expect(stepLabels(h.hero).at(-1)).toBe('AI: rig.copyPose');
    const pose = await read(h, 1);
    expect(pose.bones.upper_arm_r).toMatchObject({ angle: 30, offset: { x: 2, y: 1 } });
    expect(pose.keyed).toContain('bones.torso.angle');
    h.hero.store.undo();
    expect(documentHash(h.hero.store)).toBe(before);
  });

  it('mirrored swaps _l/_r and negates angles and offset x', async () => {
    const h = await setup();
    await registry.execute(
      'rig.copyPose',
      {
        doc: HERO_ID,
        from: { animation: anim, frame: 0 },
        to: { animation: anim, frame: 1 },
        mirrored: true,
      },
      h.run,
    );
    const pose = await read(h, 1);
    expect(pose.bones.upper_arm_l).toMatchObject({ angle: -30, offset: { x: -2, y: 1 } });
    expect(pose.bones.torso).toMatchObject({ angle: -4 });
  });

  it('runs its example shape and refuses a mirror animation as target', async () => {
    const h = await setup();
    expect(need(rigCopyPose.examples[0]).input).toMatchObject({ mirrored: true });
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: anim, direction: 'left' },
      h.run,
    );
    const refused = await rejection(
      registry.execute(
        'rig.copyPose',
        {
          doc: HERO_ID,
          from: { animation: anim, frame: 0 },
          to: { animation: { group: 'default', direction: 'left' }, frame: 0 },
        },
        h.run,
      ),
    );
    expect(refused).toMatchObject({ code: 'REFUSED', details: { reason: 'mirror-animation' } });
  });
});
