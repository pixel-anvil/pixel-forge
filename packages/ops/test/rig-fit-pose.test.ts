// rig.fitPose: the document-level pose search. The target is a render of a known pose, so the
// acceptance test is "find that pose", in a bounded number of renders, and "apply it, same pixels".
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import { encodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { registry, rigFitPose } from '../src/index.js';
import { HERO_ID, openHero, rejection } from './helpers.js';

const anim = { group: 'default' };
const call = (run: Awaited<ReturnType<typeof openHero>>['run'], op: string, input: object) =>
  registry.execute(op, { doc: HERO_ID, ...input }, run);

interface Fit {
  exact: boolean;
  error: number;
  renders: number;
  frameIndex: number;
  bones: Record<string, { angle: number }>;
  parts: Record<string, { variant: string }>;
}

/** The hero with frame 1 posed (arm raised, sleeve on) and frame 0 keyed at rest. */
async function setup() {
  const h = await openHero();
  await call(h.run, 'frame.duplicate', { animation: anim, frame: 0 });
  await call(h.run, 'rig.setPose', {
    animation: anim,
    frame: 0,
    bones: { upper_arm_r: { angle: 0 }, lower_arm_r: { angle: 0 } },
    parts: { lower_arm_r: { variant: 'default' } },
  });
  await call(h.run, 'rig.setPose', {
    animation: anim,
    frame: 1,
    bones: { upper_arm_r: { angle: -40 }, lower_arm_r: { angle: 25 } },
    parts: { lower_arm_r: { variant: 'sleeve' } },
  });
  return h;
}

const render = (h: Awaited<ReturnType<typeof openHero>>, frame: number): string =>
  imageHash(renderFrame(h.hero.store, anim, frame, { rig: h.host.renderer, exportOnly: true }));

describe('rig.fitPose', () => {
  it('declares itself', () => {
    expect(rigFitPose.mcpName).toBe('rig_fit_pose');
    expect(rigFitPose.safety).toBe('io');
  });

  it('finds a known pose of the hero within a bounded number of renders', async () => {
    const h = await setup();
    const out = (await call(h.run, 'rig.fitPose', {
      animation: anim,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r', 'lower_arm_r'],
      parts: ['lower_arm_r'],
    })) as Fit;
    expect(out).toMatchObject({ exact: true, error: 0, frameIndex: 0 });
    expect(out.bones.upper_arm_r?.angle).toBe(-40);
    expect(out.parts).toEqual({ lower_arm_r: { variant: 'sleeve' } });
    // The bound: two bones, one variant, ±180° (606 renders measured).
    expect(out.renders).toBeLessThanOrEqual(700);
  });

  it('gives output that rig.setPose takes, and frame 0 then renders like the target', async () => {
    const h = await setup();
    const out = (await call(h.run, 'rig.fitPose', {
      animation: anim,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r', 'lower_arm_r'],
      parts: ['lower_arm_r'],
    })) as Fit;
    expect(render(h, 0)).not.toBe(render(h, 1));
    await call(h.run, 'rig.setPose', {
      animation: anim,
      frame: 0,
      bones: out.bones,
      parts: out.parts,
    });
    expect(render(h, 0)).toBe(render(h, 1));
  });

  it('does not change the document, and gives the same result for the same input', async () => {
    const h = await setup();
    const hash = documentHash(h.hero.store);
    const input = {
      animation: anim,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r', 'lower_arm_r'],
      seed: 7,
    };
    const a = await call(h.run, 'rig.fitPose', input);
    const b = await call(h.run, 'rig.fitPose', input);
    expect(b).toEqual(a);
    expect(documentHash(h.hero.store)).toBe(hash);
  });

  it('fits a target PNG file', async () => {
    const h = await setup();
    const frame1 = renderFrame(h.hero.store, anim, 1, { rig: h.host.renderer, exportOnly: true });
    const { width, height, data } = frame1.toRGBA();
    h.fs.seed('/work/target.png', encodePng({ width, height, data, kind: 'rgba' }));
    const out = (await call(h.run, 'rig.fitPose', {
      animation: anim,
      frame: 0,
      file: '/work/target.png',
      bones: ['upper_arm_r', 'lower_arm_r'],
      parts: ['lower_arm_r'],
    })) as Fit;
    expect(out.exact).toBe(true);
    expect(out.bones.upper_arm_r?.angle).toBe(-40);
  });

  it('reports the best it found when the budget ends first', async () => {
    const h = await setup();
    const out = (await call(h.run, 'rig.fitPose', {
      animation: anim,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r'],
      maxRenders: 3,
    })) as Fit;
    expect(out.renders).toBe(3);
    expect(out.exact).toBe(false);
    expect(out.error).toBeGreaterThan(0);
  });

  it('is compact', async () => {
    const h = await setup();
    const out = await call(h.run, 'rig.fitPose', {
      animation: anim,
      frame: 0,
      targetFrame: 1,
      bones: ['upper_arm_r', 'lower_arm_r'],
      parts: ['lower_arm_r'],
    });
    expect(JSON.stringify(out).length).toBeLessThan(300);
  });

  it('refuses a bad target, bad refs and an empty search', async () => {
    const h = await setup();
    const base = { animation: anim, frame: 0, bones: ['upper_arm_r'] };
    const target = { targetFrame: 1 };
    // neither or both targets
    expect((await rejection(call(h.run, 'rig.fitPose', base))).code).toBe('BAD_INPUT');
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, file: '/work/x.png' })))
        .code,
    ).toBe('BAD_INPUT');
    // a PNG of the wrong size
    h.fs.seed(
      '/work/small.png',
      encodePng({ width: 1, height: 1, data: new Uint8Array(4), kind: 'rgba' }),
    );
    expect(
      await rejection(call(h.run, 'rig.fitPose', { ...base, file: '/work/small.png' })),
    ).toMatchObject({ code: 'REFUSED', details: { reason: 'bad-size' } });
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, file: '/work/missing.png' }))).code,
    ).toBe('IO_FAILED');
    // unknown bone, part, frame, target frame
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, bones: ['nope'] }))).code,
    ).toBe('NOT_FOUND');
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, parts: ['nope'] }))).code,
    ).toBe('NOT_FOUND');
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, frame: 9 }))).code,
    ).toBe('NOT_FOUND');
    expect((await rejection(call(h.run, 'rig.fitPose', { ...base, targetFrame: 9 }))).code).toBe(
      'NOT_FOUND',
    );
    // a part with one variant has nothing to choose
    expect(
      await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, parts: ['head'] })),
    ).toMatchObject({ code: 'REFUSED', details: { reason: 'no-variants' } });
    // schema: range, unknown keys
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, range: 0 }))).code,
    ).toBe('BAD_INPUT');
    expect(
      (await rejection(call(h.run, 'rig.fitPose', { ...base, ...target, extra: 1 }))).code,
    ).toBe('BAD_INPUT');
  });
});
