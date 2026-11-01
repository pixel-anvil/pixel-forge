// rig.editBones: ordered skeleton edits in one undo step; refusals leave the document untouched.
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigEditBones } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

const edit = (edits: unknown[]) => ({ doc: HERO_ID, edits });
const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');

describe('rig.editBones', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const empty = await rejection(registry.execute('rig.editBones', edit([]), run));
    expect(empty.details.issues).toEqual([
      { path: 'edits', message: expect.any(String) as string },
    ]);
    const bad = await rejection(
      registry.execute(
        'rig.editBones',
        edit([{ action: 'addBone', name: 'Tail', length: 3 }]),
        run,
      ),
    );
    expect(bad.details.issues).toEqual([
      { path: 'edits.0.name', message: expect.any(String) as string },
    ]);
    const kind = await rejection(
      registry.execute('rig.editBones', edit([{ action: 'explode' }]), run),
    );
    expect(kind.code).toBe('BAD_INPUT');
  });

  it('runs its example as one undo step', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const out = (await registry.execute(
      'rig.editBones',
      need(rigEditBones.examples[0]).input,
      run,
    )) as {
      results: { action: string; id?: string }[];
      bones: number;
    };
    expect(out.bones).toBe(18);
    expect(out.results.map((r) => r.action)).toEqual(['addBone', 'setLength']);
    expect(hero.store.doc.rig?.bones.find((b) => b.name === 'head')?.length).toBe(9);
    expect(stepLabels(hero)).toEqual(['AI: rig.editBones']);
    expect(errors(hero.store)).toEqual([]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('adds, renames, reparents, rests and deletes bones, naming earlier additions', async () => {
    const { hero, run } = await openHero();
    const bones = () => need(hero.store.doc.rig).bones;
    const out = (await registry.execute(
      'rig.editBones',
      edit([
        {
          action: 'addBone',
          name: 'tail',
          parent: 'pelvis',
          length: 6,
          rest: { view: 'side', x: -3, y: 1, angle: 180 },
        },
        { action: 'addBone', name: 'tail_tip', parent: 'tail', length: 3 },
        { action: 'rename', bone: 'tail_tip', name: 'tip' },
        { action: 'reparent', bone: 'tip', parent: 'torso' },
        { action: 'setRest', bone: 'tip', view: 'side', x: 0, y: -2, angle: 90 },
        { action: 'reparent', bone: 'tip', parent: null },
        { action: 'deleteBone', bone: 'tip' },
        { action: 'deleteBone', bone: 'tail' },
      ]),
      run,
    )) as { results: { id?: string }[] };
    expect(out.results[0]?.id).toMatch(/^bon_/);
    expect(bones().map((b) => b.name)).not.toContain('tail');
    expect(errors(hero.store)).toEqual([]);

    await registry.execute(
      'rig.editBones',
      edit([
        { action: 'addBone', name: 'tail', parent: 'pelvis', length: 6 },
        { action: 'addBone', name: 'fin', parent: 'tail', length: 2 },
      ]),
      run,
    );
    await registry.execute(
      'rig.editBones',
      edit([{ action: 'deleteBone', bone: 'tail', cascade: true }]),
      run,
    );
    expect(bones().map((b) => b.name)).not.toContain('fin');
    expect(bones()).toHaveLength(17);
  });

  it('edits views: add, rename, delete', async () => {
    const { hero, run } = await openHero();
    const out = (await registry.execute(
      'rig.editBones',
      edit([
        { action: 'addView', name: 'front', directions: ['front'] },
        { action: 'setRest', bone: 'root', view: 'front', x: 24, y: 47, angle: 0 },
        { action: 'renameView', view: 'front', name: 'facing' },
      ]),
      run,
    )) as { results: { id?: string }[] };
    expect(out.results[0]?.id).toMatch(/^viw_/);
    expect(hero.store.doc.rig?.views.map((v) => v.name)).toEqual(['side', 'facing']);
    await registry.execute('rig.editBones', edit([{ action: 'deleteView', view: 'facing' }]), run);
    expect(hero.store.doc.rig?.views).toHaveLength(1);
    expect(errors(hero.store)).toEqual([]);
  });

  it('maps refusals (core reasons) and undoes the whole call when one edit fails', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const one = (e: unknown) => rejection(registry.execute('rig.editBones', edit([e]), run));
    expect(await one({ action: 'deleteBone', bone: 'head' })).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'has-parts' },
    });
    expect(await one({ action: 'deleteBone', bone: 'torso' })).toMatchObject({
      details: { reason: 'has-children' },
    });
    expect(await one({ action: 'addBone', name: 'head', length: 1 })).toMatchObject({
      details: { reason: 'name-taken' },
    });
    expect(await one({ action: 'reparent', bone: 'torso', parent: 'head' })).toMatchObject({
      details: { reason: 'cycle' },
    });
    expect(await one({ action: 'rename', bone: 'nope', name: 'x' })).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'bone' },
    });
    expect(
      await one({ action: 'setRest', bone: 'head', view: 'top', x: 0, y: 0, angle: 0 }),
    ).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'view' },
    });
    const partial = await rejection(
      registry.execute(
        'rig.editBones',
        edit([
          { action: 'addBone', name: 'tail', length: 4 },
          { action: 'deleteBone', bone: 'head' },
        ]),
        run,
      ),
    );
    expect(partial.code).toBe('REFUSED');
    expect(documentHash(hero.store)).toBe(hash);
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });
});
