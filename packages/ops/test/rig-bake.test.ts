// rig.bake: destructive (confirm text names what "replace" consumes and drops), bake equals the rig render.
import { documentHash, imageHash, renderFrame, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { exampleInput, registry, rigBake } from '../src/index.js';
import { HERO_ID, flatHost, need, openHero, rejection, stepLabels } from './helpers.js';

const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');

describe('rig.bake', () => {
  it('rejects bad input before asking for confirmation', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'rig.bake',
        { doc: HERO_ID, animation: { group: 'default' }, mode: 'copy' },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([{ path: 'mode', message: expect.any(String) as string }]);
  });

  it('is refused without confirm, and the message says what "replace" consumes and drops', async () => {
    const { hero, run } = await openHero();
    const hash = documentHash(hero.store);
    const refused = await rejection(
      registry.execute('rig.bake', need(rigBake.examples[0]).input, run),
    );
    expect(refused.code).toBe('CONFIRM_REQUIRED');
    expect(refused.message).toMatch(/consumes the cels of the other exported pixel layers/);
    expect(refused.message).toMatch(
      /drops the animation's bone keys, part keys, overrides and post-passes/,
    );
    expect(refused.details.warning).toEqual(expect.stringContaining('consumes'));
    expect(documentHash(hero.store)).toBe(hash);
    const tool = (await import('../src/index.js'))
      .mcpTools(registry)
      .find((t) => t.name === 'rig_bake');
    expect(tool?.description).toContain('consumes the cels of the other exported pixel layers');
  });

  it('runs its example (mode new): the baked frames equal the rig render, one undo step', async () => {
    const { hero, host, run } = await openHero();
    const before = documentHash(hero.store);
    const out = (await registry.execute(
      'rig.bake',
      exampleInput(rigBake, need(rigBake.examples[0]).input),
      run,
    )) as { animation: string; frames: string[]; dropped: { boneKeys: number; cels: number } };
    expect(out.frames).toHaveLength(1);
    expect(out.dropped).toMatchObject({ boneKeys: 0, cels: 0, postPasses: false });
    expect(stepLabels(hero)).toEqual(['AI: rig.bake']);
    const render = (anim: object): string =>
      imageHash(
        renderFrame(hero.store, anim as never, 0, { rig: host.renderer, exportOnly: true }),
      );
    expect(render({ group: 'default_baked' })).toBe(render({ group: 'default' }));
    expect(errors(hero.store)).toEqual([]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
  });

  it('mode replace keeps ids, drops keys and reports them; the render is unchanged', async () => {
    const { hero, host, run } = await openHero();
    await registry.execute(
      'rig.setPose',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        bones: { upper_arm_r: { angle: -40 } },
      },
      run,
    );
    const anim = need(hero.store.doc.animations[0]);
    const render = (): string =>
      imageHash(
        renderFrame(hero.store, { id: anim.id }, 0, { rig: host.renderer, exportOnly: true }),
      );
    const posed = render();
    const out = await registry.execute(
      'rig.bake',
      { doc: HERO_ID, animation: { group: 'default' }, mode: 'replace', confirm: true },
      run,
    );
    expect(out).toMatchObject({ animation: anim.id, dropped: { boneKeys: 1 } });
    expect(render()).toBe(posed);
    expect(errors(hero.store)).toEqual([]);
  });

  it('mode replace consumes the cels of other exported layers at the baked frames', async () => {
    const { store, host, run } = await flatHost(true);
    const frame0 = (): string =>
      imageHash(renderFrame(store, { group: 'run' }, 0, { rig: host.renderer, exportOnly: true }));
    const flat = frame0();
    const out = (await registry.execute(
      'rig.bake',
      { doc: HERO_ID, animation: { group: 'run' }, mode: 'replace', confirm: true },
      run,
    )) as { dropped: { cels: number } };
    expect(out.dropped.cels).toBe(4); // the body layer's cels at the 4 run frames
    expect(frame0()).toBe(flat);
    const body = store.doc.layers.find((l) => l.name === 'body');
    expect(body !== undefined && 'cels' in body ? Object.keys(body.cels) : []).toHaveLength(1); // run_copy's
    expect(errors(store)).toEqual([]);
  });

  it('refuses a mirror, a taken name and a bad name', async () => {
    const { run } = await openHero();
    await registry.execute(
      'rig.mirrorAnimation',
      { doc: HERO_ID, source: { group: 'default' }, direction: 'left' },
      run,
    );
    const bake = (extra: Record<string, unknown>) =>
      rejection(
        registry.execute(
          'rig.bake',
          { doc: HERO_ID, animation: { group: 'default' }, mode: 'new', confirm: true, ...extra },
          run,
        ),
      );
    expect(await bake({ animation: { group: 'default', direction: 'left' } })).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'mirror-animation' },
    });
    expect(await bake({ name: 'default' })).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'name-taken' },
    });
    expect((await bake({ name: 'Bad Name' })).code).toBe('BAD_INPUT');
  });
});
