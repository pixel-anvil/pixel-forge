// doc.undo: schema test and example test. A history op: it runs without a transaction of its own.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { docUndo, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('doc.undo', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(registry.execute('doc.undo', {}, run));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'doc', message: expect.any(String) as string }]);
  });

  it('runs its example on a fresh document: nothing to undo, no error', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const example = need(docUndo.examples[0]);
    const out = await registry.execute('doc.undo', example.input, run);
    expect(out).toEqual(example.output);
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('reverts the newest change and reports its label', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0, bones: { torso: { angle: 10 } } },
      run,
    );
    const result = await registry.call('doc.undo', { doc: HERO_ID }, run);
    expect(result).toEqual({
      ok: true,
      op: 'doc.undo',
      output: { undone: true, label: 'AI: rig.setPose' },
      doc: { id: HERO_ID, version: 2, undoEntry: null, canUndo: false, canRedo: true },
    });
    expect(documentHash(hero.store)).toBe(before);
  });
});
