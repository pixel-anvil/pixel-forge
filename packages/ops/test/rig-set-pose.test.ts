// rig.setPose: the spec 6.3 exemplar. One call = one undo step; refs by name; sparse merge.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigSetPose } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const pose = (input: Record<string, unknown>) => ({
  doc: HERO_ID,
  animation: { group: 'default' },
  frame: 0,
  ...input,
});

describe('rig.setPose', () => {
  it('runs its first example on the hero and records exactly one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const v0 = hero.store.version;
    const example = need(rigSetPose.examples[0]);
    const result = await registry.call('rig.setPose', example.input, run);
    expect(result).toEqual({
      ok: true,
      op: 'rig.setPose',
      output: example.output,
      doc: { id: HERO_ID, version: v0 + 1, undoEntry: 1, canUndo: true, canRedo: false },
    });
    const history = hero.store.historyInfo();
    expect(history.entries.map((e) => e.label)).toEqual(['AI: rig.setPose']);
    const frame = hero.store.doc.animations[0];
    const keys = frame !== undefined && 'frames' in frame ? frame.frames[0]?.boneKeys : undefined;
    expect(Object.values(keys ?? {})).toEqual(
      expect.arrayContaining([{ angle: -45 }, { angle: -30 }]),
    );
    const after = documentHash(hero.store);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    hero.store.redo();
    expect(documentHash(hero.store)).toBe(after);
  });

  it('changes the render through the host renderer', async () => {
    const { hero, host, run } = await openHero();
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const before = render();
    await registry.execute('rig.setPose', pose({ bones: { upper_arm_r: { angle: -90 } } }), run);
    expect(render()).not.toBe(before);
  });

  it('merges channels, removes keys with null and records nothing for a no-op', async () => {
    const { hero, run } = await openHero();
    const boneId = need(hero.store.doc.rig?.bones.find((b) => b.name === 'torso')).id;
    const key = () => {
      const a = hero.store.doc.animations[0];
      return a !== undefined && 'frames' in a ? a.frames[0]?.boneKeys[boneId] : undefined;
    };
    await registry.execute('rig.setPose', pose({ bones: { torso: { angle: 10 } } }), run);
    await registry.execute(
      'rig.setPose',
      pose({ bones: { torso: { offset: { x: 1, y: -2 }, interp: 'step' } } }),
      run,
    );
    expect(key()).toEqual({ angle: 10, offset: { x: 1, y: -2 }, interp: 'step' });
    const version = hero.store.version;
    const same = await registry.call(
      'rig.setPose',
      pose({ bones: { [boneId]: { angle: 10 } } }),
      run,
    );
    expect(same).toMatchObject({
      ok: true,
      output: { changed: [] },
      doc: { undoEntry: null, version },
    });
    const removed = await registry.execute('rig.setPose', pose({ bones: { torso: null } }), run);
    expect(removed).toMatchObject({ changed: ['bones.torso'] });
    expect(key()).toBeUndefined();
    expect(hero.store.historyInfo().entries).toHaveLength(3);
  });

  it('sets part keys: a variant by name, "auto", z and visibility', async () => {
    const { hero, run } = await openHero();
    const part = need(
      hero.store.doc.rig?.parts.find((p) => p.variants.some((v) => v.name === 'sleeve')),
    );
    const sleeve = need(part.variants.find((v) => v.name === 'sleeve')).id;
    const out = await registry.execute(
      'rig.setPose',
      pose({ parts: { lower_arm_r: { variant: 'sleeve', z: 5 }, head: { visible: false } } }),
      run,
    );
    expect(out).toMatchObject({ changed: ['parts.head', 'parts.lower_arm_r'] });
    const frame = () => {
      const a = hero.store.doc.animations[0];
      return need(a !== undefined && 'frames' in a ? a.frames[0] : undefined);
    };
    expect(frame().partKeys[part.id]).toEqual({ variant: sleeve, z: 5 });
    await registry.execute('rig.setPose', pose({ parts: { [part.id]: { variant: 'auto' } } }), run);
    expect(frame().partKeys[part.id]).toEqual({ variant: 'auto', z: 5 });
  });

  it('reports unknown names with what exists', async () => {
    const { run } = await openHero();
    const bone = await rejection(
      registry.execute('rig.setPose', pose({ bones: { tail: { angle: 1 } } }), run),
    );
    expect(bone.code).toBe('NOT_FOUND');
    expect(bone.details).toMatchObject({ kind: 'bone', ref: 'tail' });
    expect(bone.details.available).toContain('upper_arm_r');
    const variant = await rejection(
      registry.execute('rig.setPose', pose({ parts: { lower_arm_r: { variant: 'cape' } } }), run),
    );
    expect(variant).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'variant', available: ['default', 'sleeve'] },
    });
    const frame = await rejection(
      registry.execute('rig.setPose', pose({ frame: 3, bones: { torso: { angle: 1 } } }), run),
    );
    expect(frame).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame', count: 1 } });
    const anim = await rejection(
      registry.execute(
        'rig.setPose',
        pose({ animation: { group: 'run', direction: 'side' }, bones: { torso: { angle: 1 } } }),
        run,
      ),
    );
    expect(anim).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'animation', available: ['default'] },
    });
  });

  it('refuses bad requests before changing anything', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const cases: [Record<string, unknown>, string, Record<string, unknown>?][] = [
      [pose({}), 'BAD_INPUT'],
      [pose({ bones: { torso: {} } }), 'BAD_INPUT'],
      [pose({ bones: { torso: { angle: 'up' } } }), 'BAD_INPUT'],
      [pose({ bones: { torso: { angle: 1 } }, extra: true }), 'BAD_INPUT'],
      [pose({ bones: { torso: { interp: 'step' } } }), 'REFUSED', { reason: 'empty-key' }],
    ];
    const torso = need(hero.store.doc.rig?.bones.find((b) => b.name === 'torso')).id;
    cases.push([pose({ bones: { torso: { angle: 1 }, [torso]: { angle: 2 } } }), 'BAD_INPUT']);
    for (const [input, code, details] of cases) {
      const err = await rejection(registry.execute('rig.setPose', input, run));
      expect(err.code, JSON.stringify(input)).toBe(code);
      if (details !== undefined) expect(err.details).toMatchObject(details);
    }
    const bad = await rejection(
      registry.execute('rig.setPose', pose({ bones: { torso: { angle: 'up' } } }), run),
    );
    expect(bad.details.issues).toEqual([
      { path: 'bones.torso.angle', message: expect.any(String) as string },
    ]);
    expect(documentHash(hero.store)).toBe(hash);
    expect(hero.store.canUndo).toBe(false);
  });

  it('refuses mirror animations and documents without a rig', async () => {
    const { hero, run } = await openHero();
    hero.store.transact('Setup', (tx) => {
      const src = tx.newId('animation');
      const frame = tx.newId('frame');
      const mirror = tx.newId('animation');
      tx.update((d) => {
        d.animations.push(
          {
            id: src,
            group: 'run',
            direction: 'side',
            loop: 'loop',
            frames: [
              {
                id: frame,
                durationMs: 100,
                markers: {},
                events: [],
                rootMotion: { dx: 0, dy: 0 },
                boneKeys: {},
                partKeys: {},
              },
            ],
            overrides: [],
          },
          { id: mirror, group: 'run', direction: 'left', mirrorOf: src, overrides: [] },
        );
      });
    });
    const err = await rejection(
      registry.execute(
        'rig.setPose',
        pose({ animation: { group: 'run', direction: 'left' }, bones: { torso: { angle: 1 } } }),
        run,
      ),
    );
    expect(err).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'mirror-animation', mirrorOf: 'run/side' },
    });
    hero.store.transact('Drop rig', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    const noRig = await rejection(
      registry.execute('rig.setPose', pose({ bones: { torso: { angle: 1 } } }), run),
    );
    expect(noRig).toMatchObject({ code: 'REFUSED', details: { reason: 'no-rig' } });
  });
});
