// doc.redo: schema test and example test. A history op: it runs without a transaction of its own.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { docRedo, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('doc.redo', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(registry.execute('doc.redo', {}, run));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'doc', message: expect.any(String) as string }]);
  });

  it('runs its example on a fresh document: nothing to redo, no error', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const example = need(docRedo.examples[0]);
    const out = await registry.execute('doc.redo', example.input, run);
    expect(out).toEqual(example.output);
    expect(documentHash(hero.store)).toBe(before);
  });

  it('re-applies the change that doc.undo reverted', async () => {
    const { hero, run } = await openHero();
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0, bones: { torso: { angle: 10 } } },
      run,
    );
    const after = documentHash(hero.store);
    await registry.execute('doc.undo', { doc: HERO_ID }, run);
    const result = await registry.call('doc.redo', { doc: HERO_ID }, run);
    expect(result).toEqual({
      ok: true,
      op: 'doc.redo',
      output: { redone: true, label: 'AI: rig.setPose' },
      doc: { id: HERO_ID, version: 3, undoEntry: null, canUndo: true, canRedo: false },
    });
    expect(documentHash(hero.store)).toBe(after);
  });
});
