// rig.bindParts: layers become parts by name or overlap; ties are reported, never guessed.
import { documentHash, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigBindParts } from '../src/index.js';
import { HERO_ID, flatHost, need, openHero, rejection, stepLabels, issues } from './helpers.js';

const base = { doc: HERO_ID, layer: 'body', animation: { group: 'run' }, frame: 0 };
const head = { kind: 'rect', x: 24, y: 16, w: 18, h: 12 };
const errors = (store: Parameters<typeof validate>[0]) =>
  validate(store).filter((f) => f.severity === 'error');

describe('rig.bindParts', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute('rig.bindParts', { doc: HERO_ID, rawNames: { arm: '' } }, run),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(issues(bad)[0]).toMatchObject({ path: 'rawNames.arm' });
    const flag = await rejection(
      registry.execute('rig.bindParts', { doc: HERO_ID, byName: 1 }, run),
    );
    expect(flag.details.issues).toEqual([
      { path: 'byName', message: expect.any(String) as string },
    ]);
  });

  it('runs its example: nothing to bind on the hero (all layers are parts), nothing recorded', async () => {
    const { hero, run } = await openHero();
    const result = await registry.call('rig.bindParts', need(rigBindParts.examples[0]).input, run);
    expect(result).toMatchObject({
      ok: true,
      output: { bound: [], ambiguous: [], skipped: [] },
      doc: { undoEntry: null },
    });
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('binds a split layer by raw name as one undo step', async () => {
    const { hosted, store, run } = await flatHost(true);
    const cut = (await registry.execute(
      'part.split',
      { ...base, selection: head, name: 'cap', bind: false },
      run,
    )) as { layer: string };
    const before = documentHash(store);
    const out = (await registry.execute(
      'rig.bindParts',
      {
        doc: HERO_ID,
        layers: ['cap'],
        rawNames: { cap: 'part:head@cap' },
        byOverlap: false,
        zByBone: { head: 7 },
      },
      run,
    )) as { bound: { layer: string; how: string; merged: boolean }[] };
    expect(out.bound).toHaveLength(1);
    expect(out.bound[0]).toMatchObject({ layer: cut.layer, how: 'name', merged: false });
    expect(stepLabels(hosted).at(-1)).toBe('AI: rig.bindParts');
    expect(store.doc.rig?.parts).toHaveLength(1);
    expect(errors(store)).toEqual([]);
    store.undo();
    expect(documentHash(store)).toBe(before);
  });

  it('reports skipped layers (here: several drawings) and honours byName=false', async () => {
    const { store, run } = await flatHost(true);
    const all = (await registry.execute(
      'rig.bindParts',
      { doc: HERO_ID, rawNames: { body: 'part:torso' } },
      run,
    )) as { bound: unknown[]; skipped: { layer: string; reason: string }[] };
    expect(all.bound).toEqual([]);
    expect(all.skipped.map((s) => s.reason)).toContain('animated');
    const none = await registry.call(
      'rig.bindParts',
      { doc: HERO_ID, byName: false, byOverlap: false },
      run,
    );
    expect(none).toMatchObject({ ok: true, output: { bound: [] }, doc: { undoEntry: null } });
    expect(store.doc.rig?.parts).toEqual([]);
  });

  it('refuses a document without a rig and unknown layers or views', async () => {
    const { run: flat } = await flatHost(false);
    expect(
      await rejection(registry.execute('rig.bindParts', { doc: HERO_ID }, flat)),
    ).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'no-rig' },
    });
    const { run } = await openHero();
    expect(
      await rejection(registry.execute('rig.bindParts', { doc: HERO_ID, layers: ['nope'] }, run)),
    ).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'layer' } });
    expect(
      await rejection(registry.execute('rig.bindParts', { doc: HERO_ID, view: 'top' }, run)),
    ).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'view' } });
  });
});
