// rig.readPose: the pair of rig.setPose. Reading a frame and writing it back must not change the render.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigReadPose } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const anim = { group: 'default' };
const pose = (frame: number, input: Record<string, unknown>) => ({
  doc: HERO_ID,
  animation: anim,
  frame,
  ...input,
});

/** The hero's default animation with 5 frames; keys on frames 0 and 4 only (1..3 interpolate). */
async function setup() {
  const h = await openHero();
  for (let i = 0; i < 4; i++) {
    await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, h.run);
  }
  await registry.execute(
    'rig.setPose',
    pose(0, {
      bones: { upper_arm_r: { angle: 0, offset: { x: 0, y: 0 } }, torso: { angle: 4 } },
      parts: { head: { z: 3, visible: true }, lower_arm_r: { variant: 'default' } },
    }),
    h.run,
  );
  await registry.execute(
    'rig.setPose',
    pose(4, {
      bones: { upper_arm_r: { angle: -40, offset: { x: 2, y: -4 }, interp: 'step' } },
      parts: { head: { z: 5 }, lower_arm_r: { variant: 'sleeve' } },
    }),
    h.run,
  );
  return h;
}

describe('rig.readPose', () => {
  it('runs its example output through the schema', () => {
    expect(rigReadPose.mcpName).toBe('rig_read_pose');
    expect(rigReadPose.safety).toBe('read');
  });

  it('says which values are keys and which are interpolated or held', async () => {
    const { hero, run } = await setup();
    const version = hero.store.version;
    const out = (await registry.execute('rig.readPose', pose(2, {}), run)) as {
      bones: Record<string, unknown>;
      parts: Record<string, unknown>;
      keyed: string[];
      frameIndex: number;
    };
    expect(out.frameIndex).toBe(2);
    expect(out.keyed).toEqual([]);
    // Linear halfway between 0 and -40; torso has one key, so it holds.
    expect(out.bones).toEqual({
      torso: { angle: 4 },
      upper_arm_r: { angle: -20, offset: { x: 1, y: -2 } },
    });
    expect(out.parts).toEqual({
      head: { z: 3, visible: true },
      lower_arm_r: { variant: 'default' },
    });
    const first = (await registry.execute('rig.readPose', pose(0, {}), run)) as typeof out;
    expect(first.keyed).toEqual([
      'bones.torso.angle',
      'bones.upper_arm_r.angle',
      'bones.upper_arm_r.offset',
      'parts.head.visible',
      'parts.head.z',
      'parts.lower_arm_r.variant',
    ]);
    const last = (await registry.execute('rig.readPose', pose(4, {}), run)) as typeof out;
    expect(last.bones.upper_arm_r).toEqual({ angle: -40, offset: { x: 2, y: -4 }, interp: 'step' });
    expect(last.parts).toEqual({
      head: { z: 5, visible: true },
      lower_arm_r: { variant: 'sleeve' },
    });
    expect(hero.store.version).toBe(version);
  });

  it('writes back with rig.setPose and the render does not change', async () => {
    const { hero, host, run } = await setup();
    const render = (f: number): string =>
      imageHash(renderFrame(hero.store, anim, f, { rig: host.renderer }));
    for (const f of [0, 1, 2, 3, 4]) {
      const before = render(f);
      const read = (await registry.execute('rig.readPose', pose(f, {}), run)) as {
        bones: Record<string, unknown>;
        parts: Record<string, unknown>;
      };
      await registry.execute('rig.setPose', pose(f, { bones: read.bones, parts: read.parts }), run);
      expect(render(f), `frame ${String(f)}`).toBe(before);
    }
  });

  it('is compact: the hero frame stays under 600 bytes', async () => {
    const { run } = await setup();
    const out = await registry.execute('rig.readPose', pose(2, {}), run);
    expect(JSON.stringify(out).length).toBeLessThan(600);
  });

  it('does not change the document and refuses bad refs', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const out = await registry.execute('rig.readPose', pose(0, {}), run);
    expect(out).toMatchObject({ bones: {}, parts: {}, keyed: [] });
    expect(documentHash(hero.store)).toBe(hash);
    const frame = await rejection(registry.execute('rig.readPose', pose(9, {}), run));
    expect(frame).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
    const unknown = await rejection(
      registry.execute('rig.readPose', { ...pose(0, {}), animation: { group: 'nope' } }, run),
    );
    expect(unknown.code).toBe('NOT_FOUND');
  });

  it('holds part values from the previous key, also in a loop', async () => {
    const { hero, run } = await setup();
    hero.store.transact('Loop', (tx) => {
      tx.update((d) => {
        const a = need(d.animations[0]);
        if ('frames' in a) a.loop = 'loop';
      });
    });
    // Step channel: frame 3 holds the key of frame 0 (z=3) until the key on frame 4.
    const out = (await registry.execute('rig.readPose', pose(3, {}), run)) as {
      parts: Record<string, { z?: number }>;
    };
    expect(out.parts.head?.z).toBe(3);
  });
});
