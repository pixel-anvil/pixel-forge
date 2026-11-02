// override.list / override.resolve: stale overrides apart from render errors (CORE-03); keep, rebase, discard.
import { attributeEditTx, documentHash, renderFrame, validate } from '@pixel-forge/core';
import type { PartRenderer } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { overrideList, overrideResolve, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels, issues } from './helpers.js';

const anim = { group: 'default' };

/** Hero with one override: a recoloured opaque pixel of frame 0 (a part or final override). */
async function withOverride() {
  const f = await openHero();
  const edited = renderFrame(f.hero.store, anim, 0, { rig: f.host.renderer, exportOnly: true });
  const { data, width } = edited.toRGBA();
  let at = 0;
  while ((data[at * 4 + 3] ?? 0) === 0) at += 1;
  edited.set(at % width, Math.floor(at / width), [250, 10, 250, 255]);
  const ids = f.hero.store.transact('edit', (tx) =>
    attributeEditTx(tx, anim, 0, edited, { rig: f.host.renderer as PartRenderer }),
  );
  const id = need(ids[0]);
  f.hero.store.clearHistory();
  return { ...f, id, edited };
}

/** Rotating the root changes the art under the override. */
const makeStale = (run: Parameters<typeof registry.execute>[2]) =>
  registry.execute(
    'rig.setPose',
    { doc: HERO_ID, animation: anim, frame: 0, bones: { root: { angle: 25 } } },
    run,
  );

describe('override.list', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute('override.list', { doc: HERO_ID, animations: [{ group: 7 }] }, run),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(issues(bad)[0]?.path.startsWith('animations.0')).toBe(true);
  });

  it('runs its example: the hero has no overrides', async () => {
    const { run } = await openHero();
    const out = await registry.execute('override.list', need(overrideList.examples[0]).input, run);
    expect(out).toEqual({
      counts: { total: 0, valid: 0, stale: 0, errors: 0 },
      stale: [],
      errors: [],
      valid: [],
    });
  });

  it('lists a fresh override as valid and a changed one as stale (reason hash)', async () => {
    const { run, id } = await withOverride();
    expect(await registry.execute('override.list', { doc: HERO_ID }, run)).toMatchObject({
      counts: { total: 1, valid: 1, stale: 0, errors: 0 },
      valid: [id],
    });
    await makeStale(run);
    const out = (await registry.execute('override.list', { doc: HERO_ID }, run)) as {
      counts: object;
      stale: {
        id: string;
        reason: string;
        animation: string;
        frameIndex: number;
        target: string;
      }[];
      errors: unknown[];
    };
    expect(out.counts).toEqual({ total: 1, valid: 0, stale: 1, errors: 0 });
    expect(out.stale[0]).toMatchObject({ id, reason: 'hash', animation: 'default', frameIndex: 0 });
    expect(out.errors).toEqual([]);
  });

  it('reports overrides whose render fails as errors, not as stale (CORE-03)', async () => {
    const { run, id } = await withOverride();
    // No view draws "back": the frame cannot be rendered.
    await registry.execute(
      'anim.update',
      { doc: HERO_ID, animation: anim, direction: 'back' },
      run,
    );
    const out = (await registry.execute('override.list', { doc: HERO_ID }, run)) as {
      counts: object;
      stale: unknown[];
      errors: { id: string; reason: string; errorCode: string; errorMessage: string }[];
    };
    expect(out.counts).toEqual({ total: 1, valid: 0, stale: 0, errors: 1 });
    expect(out.stale).toEqual([]);
    expect(out.errors[0]).toMatchObject({
      id,
      reason: 'error',
      errorCode: expect.any(String) as string,
    });
    expect(out.errors[0]?.errorMessage).not.toBe('');
  });

  it('can be narrowed to some animations', async () => {
    const { run } = await withOverride();
    await registry.execute('anim.create', { doc: HERO_ID, group: 'run' }, run);
    const out = await registry.execute(
      'override.list',
      { doc: HERO_ID, animations: [{ group: 'run' }] },
      run,
    );
    expect(out).toMatchObject({ counts: { total: 0 } });
  });
});

describe('override.resolve', () => {
  it('rejects bad input and asks for ids', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute('override.resolve', { doc: HERO_ID, action: 'burn', overrides: ['x'] }, run),
    );
    expect(bad.details.issues).toEqual([{ path: 'action', message: expect.any(String) as string }]);
    const none = await rejection(
      registry.execute('override.resolve', { doc: HERO_ID, action: 'keep' }, run),
    );
    expect(none.code).toBe('BAD_INPUT');
  });

  it('runs its example (rebase every stale override): nothing stale on the hero, nothing recorded', async () => {
    const { hero, run } = await openHero();
    const result = await registry.call(
      'override.resolve',
      need(overrideResolve.examples[0]).input,
      run,
    );
    expect(result).toMatchObject({
      ok: true,
      output: { action: 'rebase', resolved: [], skipped: [] },
      doc: { undoEntry: null },
    });
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('rebases a stale override: it is valid again, as one undo step', async () => {
    const { hero, run, id } = await withOverride();
    await makeStale(run);
    const before = documentHash(hero.store);
    const out = await registry.execute(
      'override.resolve',
      { doc: HERO_ID, action: 'rebase', overrides: [id] },
      run,
    );
    expect(out).toEqual({ action: 'rebase', resolved: [id], skipped: [] });
    expect(stepLabels(hero)).toEqual(['AI: rig.setPose', 'AI: override.resolve']);
    expect(await registry.execute('override.list', { doc: HERO_ID }, run)).toMatchObject({
      counts: { valid: 1, stale: 0 },
    });
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(await registry.execute('override.list', { doc: HERO_ID }, run)).toMatchObject({
      counts: { valid: 0, stale: 1 },
    });
  });

  it('keep changes nothing; discard removes the override and its images', async () => {
    const { hero, run, id } = await withOverride();
    await makeStale(run);
    const hash = documentHash(hero.store);
    const kept = await registry.call(
      'override.resolve',
      { doc: HERO_ID, action: 'keep', allStale: true },
      run,
    );
    expect(kept).toMatchObject({ ok: true, output: { resolved: [id] }, doc: { undoEntry: null } });
    expect(documentHash(hero.store)).toBe(hash);
    const images = hero.store.imageIds().length;
    await registry.execute(
      'override.resolve',
      { doc: HERO_ID, action: 'discard', overrides: [id] },
      run,
    );
    expect(hero.store.doc.animations[0]?.overrides).toEqual([]);
    expect(hero.store.imageIds().length).toBeLessThan(images);
    expect(
      validate(hero.store).filter((f) => f.severity === 'error' || f.code === 'IMAGE_ORPHAN'),
    ).toEqual([]);
  });

  it('allStale leaves render errors out of a rebase and reports them', async () => {
    const { run, id } = await withOverride();
    await registry.execute(
      'anim.update',
      { doc: HERO_ID, animation: anim, direction: 'back' },
      run,
    );
    const out = await registry.execute(
      'override.resolve',
      { doc: HERO_ID, action: 'rebase', allStale: true },
      run,
    );
    expect(out).toEqual({ action: 'rebase', resolved: [], skipped: [id] });
    const direct = await rejection(
      registry.execute(
        'override.resolve',
        { doc: HERO_ID, action: 'rebase', overrides: [id] },
        run,
      ),
    );
    expect(direct.code).not.toBe('INTERNAL');
  });

  it('allStale also leaves overrides without a target out of a rebase, and still rebases the others', async () => {
    const { hero, run, id } = await withOverride();
    // A second override whose frame is gone has no target (stale, reason no-target).
    const dead = hero.store.transact('dead override', (tx) => {
      let copy = '';
      tx.update((d) => {
        const a = need(d.animations[0]);
        const o = need(a.overrides[0]);
        copy = 'ovr_dead00';
        a.overrides.push({
          ...(JSON.parse(JSON.stringify(o)) as typeof o),
          id: copy as typeof o.id,
          frameId: 'frm_gone00' as typeof o.frameId,
        });
      });
      return copy;
    });
    await makeStale(run);
    const listed = (await registry.execute('override.list', { doc: HERO_ID }, run)) as {
      stale: { id: string; reason: string }[];
    };
    expect(listed.stale.find((s) => s.id === dead)?.reason).toBe('no-target');
    const out = await registry.execute(
      'override.resolve',
      { doc: HERO_ID, action: 'rebase', allStale: true },
      run,
    );
    expect(out).toEqual({ action: 'rebase', resolved: [id], skipped: [dead] });
    // Naming it explicitly is still refused.
    const direct = await rejection(
      registry.execute(
        'override.resolve',
        { doc: HERO_ID, action: 'rebase', overrides: [dead] },
        run,
      ),
    );
    expect(direct).toMatchObject({ code: 'REFUSED', details: { reason: 'no-target' } });
  });

  it('reports unknown override ids with kind override', async () => {
    const { run } = await withOverride();
    for (const action of ['keep', 'rebase', 'discard']) {
      const missing = await rejection(
        registry.execute(
          'override.resolve',
          { doc: HERO_ID, action, overrides: ['ovr_nope00'] },
          run,
        ),
      );
      expect(missing).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'override' } });
    }
  });
});
