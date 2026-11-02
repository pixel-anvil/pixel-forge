// part.paintOverlap: the W2b paint step as an op. Grow the variant, shift the pivot, keep the rest composite.
import { documentHash, imageHash, renderFrame, validate } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { partPaintOverlap, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels, issues } from './helpers.js';

/** Opens a one-pixel gap at the right elbow: the forearm pivot moves 2 px, the arm no longer overlaps. */
async function withElbowGap() {
  const f = await openHero();
  await registry.execute(
    'rig.setPivot',
    { doc: HERO_ID, part: 'lower_arm_r', pivot: { x: 3, y: 1 } },
    f.run,
  );
  f.hero.store.clearHistory();
  const gaps = async (): Promise<number> =>
    (
      (await registry.execute('rig.jointCheck', { doc: HERO_ID }, f.run)) as {
        summary: { gapCount: number };
      }
    ).summary.gapCount;
  const rest = (): string =>
    imageHash(renderFrame(f.hero.store, { group: 'default' }, 0, { rig: f.host.renderer }));
  return { ...f, gaps, rest };
}

describe('part.paintOverlap', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute('part.paintOverlap', { doc: HERO_ID, color: [1, 2, 3] }, run),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(issues(bad).length).toBeGreaterThan(0);
    const range = await rejection(
      registry.execute('part.paintOverlap', { doc: HERO_ID, color: [1, 2, 3, 999] }, run),
    );
    expect(range.code).toBe('BAD_INPUT');
  });

  it('runs its example: closes the elbow gap, rest composite unchanged, one undo step', async () => {
    const { hero, run, gaps, rest } = await withElbowGap();
    expect(await gaps()).toBeGreaterThan(0);
    const before = documentHash(hero.store);
    const composite = rest();
    const out = (await registry.execute(
      'part.paintOverlap',
      need(partPaintOverlap.examples[0]).input,
      run,
    )) as {
      painted: { part: string; bones: string[]; pixels: number; grew: object; pivot: object }[];
    };
    expect(out.painted).toHaveLength(1);
    expect(out.painted[0]).toMatchObject({ part: 'upper_arm_r', bones: ['lower_arm_r'] });
    expect(out.painted[0]?.pixels).toBeGreaterThan(0);
    expect(rest()).toBe(composite); // painting inside the mask changes nothing at rest
    expect(await gaps()).toBe(0);
    expect(stepLabels(hero)).toEqual(['AI: part.paintOverlap']);
    expect(
      validate(hero.store).filter((f) => f.severity === 'error' || f.code === 'IMAGE_ORPHAN'),
    ).toEqual([]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(await gaps()).toBeGreaterThan(0);
  });

  it('paints with a chosen colour; a joint filter that excludes the gap paints nothing', async () => {
    const { hero, run, gaps } = await withElbowGap();
    const other = await registry.call(
      'part.paintOverlap',
      { doc: HERO_ID, bones: ['lower_arm_l'] },
      run,
    );
    expect(other).toMatchObject({ ok: true, output: { painted: [] }, doc: { undoEntry: null } });
    await registry.execute(
      'part.paintOverlap',
      { doc: HERO_ID, view: 'side', color: [255, 0, 0, 255] },
      run,
    );
    const part = need(
      hero.store.doc.rig?.parts.find((p) => p.variants.some((v) => v.pivot.x === 2)),
    );
    const painted = hero.store.doc.rig?.parts
      .flatMap((p) => p.variants)
      .map((v) => hero.store.image(v.imageId));
    const reds = painted?.some((img) => {
      const data = (img as { toRGBA(): { data: Uint8Array } }).toRGBA().data;
      for (let o = 0; o < data.length; o += 4) {
        if (data[o] === 255 && data[o + 1] === 0 && data[o + 2] === 0 && data[o + 3] === 255)
          return true;
      }
      return false;
    });
    expect(reds).toBe(true);
    expect(part).toBeDefined();
    expect(await gaps()).toBe(0);
  });

  it('is a no-op on a clean rig, and reports unknown names', async () => {
    const { hero, run } = await openHero();
    const clean = await registry.call('part.paintOverlap', { doc: HERO_ID }, run);
    expect(clean).toMatchObject({
      ok: true,
      output: { painted: [], uncovered: [], skipped: [] },
      doc: { undoEntry: null },
    });
    expect(hero.store.historyInfo().entries).toHaveLength(0);
    expect(
      await rejection(
        registry.execute('part.paintOverlap', { doc: HERO_ID, bones: ['tail'] }, run),
      ),
    ).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'bone' } });
    expect(
      await rejection(registry.execute('part.paintOverlap', { doc: HERO_ID, view: 'top' }, run)),
    ).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'view' } });
  });
});
