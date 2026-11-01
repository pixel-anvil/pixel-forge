// lint.run: schema test and example test. Read-only: no version change, no history entry.
import { documentHash } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { lintRun, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

describe('lint.run', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('lint.run', { doc: HERO_ID, enable: ['no.such.rule'] }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([
      { path: 'enable.0', message: expect.any(String) as string },
    ]);
  });

  it('runs its example without changing the document', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const v0 = hero.store.version;
    const out = await registry.execute('lint.run', need(lintRun.examples[0]).input, run);
    expect(out).toEqual({ count: 0, findings: [] });
    expect(hero.store.version).toBe(v0);
    expect(documentHash(hero.store)).toBe(before);
    expect(hero.store.historyInfo().entries).toHaveLength(0);
  });

  it('returns the findings of the rules it runs, counted', async () => {
    const { run } = await openHero();
    // A new frame has no keys; anim.emptyFrame is the rule under test here, the count must match.
    await registry.execute(
      'frame.add',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0 },
      run,
    );
    const out = (await registry.execute(
      'lint.run',
      { doc: HERO_ID, enable: ['anim.emptyFrame'], maxPixels: 4 },
      run,
    )) as { count: number; findings: { rule: string }[] };
    expect(out.count).toBe(out.findings.length);
    expect(out.findings.every((f) => f.rule === 'anim.emptyFrame')).toBe(true);
  });

  it('reports an unknown animation', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('lint.run', { doc: HERO_ID, animations: [{ group: 'run' }] }, run),
    );
    expect(err).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'animation' } });
  });
});
