// rig.jointCheck: schema test and example test. Read-only.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { registry, rigJointCheck } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('rig.jointCheck', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(registry.execute('rig.jointCheck', { doc: HERO_ID, view: 3 }, run));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'view', message: expect.any(String) as string }]);
  });

  it('runs its example: the hero passes, nothing changes', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const v0 = hero.store.version;
    const out = await registry.execute(
      'rig.jointCheck',
      need(rigJointCheck.examples[0]).input,
      run,
    );
    expect(out).toMatchObject({
      view: 'side',
      summary: { gapCount: 0, joints: 15, jointsWithGaps: 0 },
    });
    expect(hero.store.version).toBe(v0);
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('compact form: the clean hero is under 500 bytes and says what was checked', async () => {
    const { run } = await openHero();
    const out = await registry.execute('rig.jointCheck', { doc: HERO_ID, compact: true }, run);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(500);
    expect(out).toMatchObject({
      view: 'side',
      summary: { joints: 15, jointsWithGaps: 0, gapCount: 0 },
      problems: [],
    });
    expect(out).not.toHaveProperty('joints');
  });

  it('compact form names the joints with gaps and agrees with the full form', async () => {
    const { run } = await openHero();
    // A tiny radius-1 window and a wide sweep is not guaranteed to open gaps, so compare in general.
    const args = { doc: HERO_ID, rangeDeg: 90, stepDeg: 45, radius: 1 };
    const full = (await registry.execute('rig.jointCheck', args, run)) as {
      joints: { bone: string; gapCount: number; union: unknown[] }[];
      summary: unknown;
    };
    const compact = (await registry.execute('rig.jointCheck', { ...args, compact: true }, run)) as {
      problems: { bone: string; kind: string; gapCount: number; unionCount: number }[];
      summary: unknown;
    };
    expect(compact.summary).toEqual(full.summary);
    expect(compact.problems).toEqual(
      full.joints
        .filter((j) => j.gapCount > 0)
        .map((j) => ({
          bone: j.bone,
          kind: 'gap',
          gapCount: j.gapCount,
          unionCount: j.union.length,
        })),
    );
  });

  it('checks the view it is given, the same as the default view', async () => {
    const { run } = await openHero();
    const byDefault = await registry.execute('rig.jointCheck', { doc: HERO_ID }, run);
    const byName = await registry.execute('rig.jointCheck', { doc: HERO_ID, view: 'side' }, run);
    expect(byName).toEqual(byDefault);
  });

  it('passes the sweep inputs to the check and reports them', async () => {
    const { run } = await openHero();
    const out = await registry.execute(
      'rig.jointCheck',
      { doc: HERO_ID, rangeDeg: 10, stepDeg: 10, radius: 2 },
      run,
    );
    expect(out).toMatchObject({ params: { rangeDeg: 10, stepDeg: 10, radius: 2 } });
  });

  it('rejects a radius below 1', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('rig.jointCheck', { doc: HERO_ID, radius: 0 }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
  });

  it('reports an unknown view with the views that exist', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('rig.jointCheck', { doc: HERO_ID, view: 'back' }, run),
    );
    expect(err).toMatchObject({
      code: 'NOT_FOUND',
      details: { kind: 'view', available: ['side'] },
    });
  });

  it('refuses a document without a rig', async () => {
    const { hero, run } = await openHero();
    hero.store.transact('Drop rig', (tx) => {
      tx.update((d) => {
        delete d.rig;
      });
    });
    const err = await rejection(registry.execute('rig.jointCheck', { doc: HERO_ID }, run));
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'no-rig' } });
  });
});
