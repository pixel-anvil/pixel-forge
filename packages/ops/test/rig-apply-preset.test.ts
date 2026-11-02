// rig.applyPreset (E3.3): every preset on the hero, one undo step, replace rules, view and parameter errors.
import { documentHash } from '@pixel-forge/core';
import { PRESET_NAMES } from '@pixel-forge/rig';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels } from './helpers.js';

interface Out {
  animation: string;
  label: string;
  created: boolean;
  frames: number;
  loop: string;
  angleQuantum: number;
  params: Record<string, number>;
  rootMotion: { dx: number; dy: number }[];
  labels: Record<string, string>[];
  warnings: string[];
}

type Run = Parameters<typeof registry.execute>[2];

const apply = async (run: Run, input: Record<string, unknown>): Promise<Out> =>
  (await registry.execute('rig.applyPreset', { doc: HERO_ID, ...input }, run)) as Out;

describe('rig.applyPreset', () => {
  it.each(PRESET_NAMES)('%s: creates group/side with keyed frames', async (preset) => {
    const { hero, run } = await openHero();
    const out = await apply(run, { preset });
    expect(out.label).toBe(`${preset}/side`);
    expect(out.created).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.rootMotion).toHaveLength(out.frames);
    expect(out.labels).toHaveLength(out.frames);
    expect(out.params.frames).toBe(out.frames);
    const a = need(hero.store.doc.animations.find((x) => x.id === out.animation));
    if (!('frames' in a)) throw new Error('not authored');
    expect(a.frames).toHaveLength(out.frames);
    expect(a.direction).toBe('side');
    expect(a.loop).toBe(out.loop);
    expect(a.angleQuantum).toBe(out.angleQuantum);
    expect(a.frames.every((f) => Object.keys(f.boneKeys).length > 0)).toBe(true);
    expect(a.frames.map((f) => f.rootMotion)).toEqual(out.rootMotion);
  });

  it('is one undo step: one undo removes the whole animation', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const entries = hero.store.historyInfo().entries.length;
    await apply(run, { preset: 'walk', frames: 8 });
    expect(hero.store.historyInfo().entries).toHaveLength(entries + 1);
    expect(stepLabels(hero).at(-1)).toBe('AI: rig.applyPreset');
    await registry.execute('doc.undo', { doc: HERO_ID }, run);
    expect(documentHash(hero.store)).toBe(before);
  });

  it('takes params, group and direction; frames and params.frames must agree', async () => {
    const { run } = await openHero();
    const out = await apply(run, {
      preset: 'walk',
      group: 'stroll',
      frames: 6,
      params: { frames: 6 },
    });
    expect(out.label).toBe('stroll/side');
    expect(out.frames).toBe(6);
    const err = await rejection(apply(run, { preset: 'run', frames: 6, params: { frames: 8 } }));
    expect(err.code).toBe('BAD_INPUT');
  });

  it('refuses an existing animation without replace; replace is one undo step', async () => {
    const { hero, run } = await openHero();
    await apply(run, { preset: 'walk', frames: 8 });
    const afterFirst = documentHash(hero.store);
    const err = await rejection(apply(run, { preset: 'walk', frames: 6 }));
    expect(err.code).toBe('REFUSED');
    expect(err.details.reason).toBe('animation-exists');
    expect(documentHash(hero.store)).toBe(afterFirst);

    const entries = hero.store.historyInfo().entries.length;
    const out = await apply(run, { preset: 'walk', frames: 6, replace: true });
    expect(out.created).toBe(false);
    expect(out.frames).toBe(6);
    expect(hero.store.historyInfo().entries).toHaveLength(entries + 1);
    const a = need(hero.store.doc.animations.find((x) => x.id === out.animation));
    expect('frames' in a && a.frames.length).toBe(6);
    await registry.execute('doc.undo', { doc: HERO_ID }, run);
    expect(documentHash(hero.store)).toBe(afterFirst);

    const grown = await apply(run, { preset: 'walk', frames: 10, replace: true });
    expect(grown.frames).toBe(10);
  });

  it('rejects an unsupported view, an unknown preset and bad parameters', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const view = await rejection(apply(run, { preset: 'walk', view: '3/4' }));
    expect(view.code).toBe('BAD_INPUT');
    expect(view.message).toContain('"side"');
    expect((await rejection(apply(run, { preset: 'moonwalk' }))).message).toContain('walk');
    const bad = await rejection(apply(run, { preset: 'walk', params: { nope: 1 } }));
    expect(bad.code).toBe('INVALID_VALUE');
    const range = await rejection(apply(run, { preset: 'walk', frames: 1000 }));
    expect(range.code).toBe('INVALID_VALUE');
    expect(documentHash(hero.store)).toBe(before);
  });

  it('is deterministic', async () => {
    const a = await openHero();
    const b = await openHero();
    await apply(a.run, { preset: 'run' });
    await apply(b.run, { preset: 'run' });
    expect(documentHash(a.hero.store)).toBe(documentHash(b.hero.store));
  });
});
