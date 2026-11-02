// rig.setPartZ: the default z changes after creation; renders, joint check and overlap follow.
import { documentHash, imageHash, renderFrame } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigSetPartZ } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

describe('rig.setPartZ', () => {
  it('rejects a non-integer z with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute('rig.setPartZ', { doc: HERO_ID, part: 'lower_arm_r', z: 1.5 }, run),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([{ path: 'z', message: expect.any(String) as string }]);
  });

  it('runs its example as one undo step; the render follows and undo restores it', async () => {
    const { hero, host, run } = await openHero();
    const render = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const before = documentHash(hero.store);
    const frame0 = render();
    const out = await registry.execute('rig.setPartZ', need(rigSetPartZ.examples[0]).input, run);
    expect(out).toMatchObject({ part: 'lower_arm_r', z: 5, previous: 3, keyedFrames: 0 });
    expect(stepLabels(hero)).toEqual(['AI: rig.setPartZ']);
    expect(Object.values(need(hero.store.doc.rig?.views[0]).defaultZ)).toContain(5);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(render()).toBe(frame0);
  });

  it('changes the render, and jointCheck and paintOverlap see the new order', async () => {
    const { hero, host, run } = await openHero();
    const key = (): string =>
      imageHash(renderFrame(hero.store, { group: 'default' }, 0, { rig: host.renderer }));
    const gap = { doc: HERO_ID, part: 'lower_arm_r', pivot: { x: 3, y: 1 } };
    await registry.execute('rig.setPivot', gap, run);
    const gaps = async (): Promise<number> =>
      (
        (await registry.execute('rig.jointCheck', { doc: HERO_ID }, run)) as {
          summary: { gapCount: number };
        }
      ).summary.gapCount;
    const baseKey = key();
    const baseGaps = await gaps();
    expect(baseGaps).toBeGreaterThan(0);
    // The forearm (z 3) is on top, so overlap grows the upper arm. Lift the upper arm above it.
    await registry.execute('rig.setPartZ', { doc: HERO_ID, part: 'upper_arm_r', z: 9 }, run);
    expect(key()).not.toBe(baseKey);
    expect(await gaps()).toBe(baseGaps);
    const painted = await registry.execute('part.paintOverlap', { doc: HERO_ID }, run);
    expect(painted).toMatchObject({ painted: [{ part: 'lower_arm_r' }] });
    expect(await gaps()).toBe(0);
  });

  it('reports the previous z, counts frame z keys that still win, and takes a view', async () => {
    const { run } = await openHero();
    const first = (await registry.execute(
      'rig.setPartZ',
      { doc: HERO_ID, part: 'lower_arm_r', z: 2 },
      run,
    )) as { previous: number; view: string };
    const second = await registry.execute(
      'rig.setPartZ',
      { doc: HERO_ID, part: 'lower_arm_r', z: 3, view: 'side' },
      run,
    );
    expect(first.previous).toBe(3);
    expect(second).toMatchObject({ previous: 2, z: 3, view: first.view });
    await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        parts: { lower_arm_r: { z: 7 } },
      },
      run,
    );
    const third = await registry.execute(
      'rig.setPartZ',
      { doc: HERO_ID, part: 'lower_arm_r', z: 4 },
      run,
    );
    expect(third).toMatchObject({ keyedFrames: 1 });
  });

  it('rejects an unknown part or view without recording a step', async () => {
    const { hero, run } = await openHero();
    const part = await rejection(
      registry.execute('rig.setPartZ', { doc: HERO_ID, part: 'nope', z: 1 }, run),
    );
    expect(part.code).toBe('NOT_FOUND');
    const view = await rejection(
      registry.execute(
        'rig.setPartZ',
        { doc: HERO_ID, part: 'lower_arm_r', z: 1, view: 'nope' },
        run,
      ),
    );
    expect(view.code).toBe('NOT_FOUND');
    expect(stepLabels(hero)).toEqual([]);
  });
});
