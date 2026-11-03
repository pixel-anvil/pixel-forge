// part.paintVariant: pixels into a part variant's own image (RIG-07): one undo step, stale overrides, growth.
import { attributeEditTx, documentHash, imageHash, renderFrame, validate } from '@pixel-forge/core';
import type { PartRenderer } from '@pixel-forge/core';
import { describe, expect, it } from 'vitest';
import { partPaintVariant, registry } from '../src/index.js';
import { HERO_ID, need, openHero, rejection, stepLabels, issues } from './helpers.js';

const anim = { group: 'default' };
const PINK = { '1': '#ff00ff' };

describe('part.paintVariant', () => {
  it('rejects a bad grid with the issue path, and a part layer name that does not exist', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'part.paintVariant',
        { doc: HERO_ID, part: 'lower_arm_r', rows: ['12'], legend: PINK },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(issues(bad)[0]?.path).toBe('rows.0');
    const none = await rejection(
      registry.execute(
        'part.paintVariant',
        { doc: HERO_ID, part: 'nope', rows: ['1'], legend: PINK },
        run,
      ),
    );
    expect(none.code).toBe('NOT_FOUND');
  });

  it('runs its example as one undo step; the render changes and undo restores it', async () => {
    const { hero, host, run } = await openHero();
    const render = (): string =>
      imageHash(renderFrame(hero.store, anim, 0, { rig: host.renderer }));
    const before = documentHash(hero.store);
    const frame0 = render();
    const out = await registry.execute(
      'part.paintVariant',
      { ...need(partPaintVariant.examples[0]).input, legend: PINK },
      run,
    );
    expect(out).toMatchObject({ part: 'lower_arm_r', changed: 2, grew: { left: 0, top: 0 } });
    expect(stepLabels(hero)).toEqual(['AI: part.paintVariant']);
    expect(render()).not.toBe(frame0);
    expect(
      validate(hero.store).filter((f) => f.severity === 'error' || f.code === 'IMAGE_ORPHAN'),
    ).toEqual([]);
    hero.store.undo();
    expect(documentHash(hero.store)).toBe(before);
    expect(render()).toBe(frame0);
  });

  it('writes nothing when the pixels already match', async () => {
    const { hero, run } = await openHero();
    const args = { doc: HERO_ID, part: 'lower_arm_r', rows: ['1'], legend: PINK };
    await registry.execute('part.paintVariant', args, run);
    const again = await registry.call('part.paintVariant', args, run);
    expect(again).toMatchObject({ ok: true, output: { changed: 0 }, doc: { undoEntry: null } });
    expect(stepLabels(hero)).toEqual(['AI: part.paintVariant']);
  });

  it('grows the image for a negative offset and moves the pivot so the part stays in place', async () => {
    const { hero, host, run } = await openHero();
    const render = (): string =>
      imageHash(renderFrame(hero.store, anim, 0, { rig: host.renderer }));
    const before = render();
    const part = need(hero.store.doc.rig?.parts[0]);
    const variant = need(part.variants[0]);
    const was = { ...variant.pivot };
    // A transparent write outside the image changes nothing and does not grow it.
    const quiet = await registry.execute(
      'part.paintVariant',
      { doc: HERO_ID, part: part.id, variant: variant.id, x: -3, y: -2, rows: ['.'], legend: {} },
      run,
    );
    expect(quiet).toMatchObject({ changed: 0, grew: { left: 0, top: 0, right: 0, bottom: 0 } });
    // The hidden pixel is outside the art's bounds, so it sits on the far side of the part.
    const out = (await registry.execute(
      'part.paintVariant',
      { doc: HERO_ID, part: part.id, variant: variant.id, x: -3, y: -2, rows: ['1'], legend: PINK },
      run,
    )) as { grew: { left: number; top: number }; pivot: { x: number; y: number } };
    expect(out.grew).toMatchObject({ left: 3, top: 2 });
    expect(out.pivot).toEqual({ x: was.x + 3, y: was.y + 2 });
    expect(render()).not.toBe(''); // renders without error
    hero.store.undo();
    expect(render()).toBe(before);
  });

  it('makes a part override stale by the existing hash rule', async () => {
    const f = await openHero();
    const edited = renderFrame(f.hero.store, anim, 0, { rig: f.host.renderer, exportOnly: true });
    const { data, width } = edited.toRGBA();
    let at = 0;
    while ((data[at * 4 + 3] ?? 0) === 0) at += 1;
    edited.set(at % width, Math.floor(at / width), [250, 10, 250, 255]);
    f.hero.store.transact('edit', (tx) =>
      attributeEditTx(tx, anim, 0, edited, { rig: f.host.renderer as PartRenderer }),
    );
    const fresh = (await registry.execute('override.list', { doc: HERO_ID }, f.run)) as {
      counts: { valid: number; stale: number };
    };
    expect(fresh.counts).toMatchObject({ valid: 1, stale: 0 });
    // Paint the part the override sits on (the first part override's target).
    const override = need(
      f.hero.store.doc.animations.flatMap((a) => ('overrides' in a ? a.overrides : []))[0],
    );
    expect(override.target).not.toBe('final'); // a part override: hashed over the part's own render
    const target = (override.target as { partId: string }).partId;
    const part = need(f.hero.store.doc.rig?.parts.find((p) => p.id === target));
    await registry.execute(
      'part.paintVariant',
      {
        doc: HERO_ID,
        part: part.id,
        variant: need(part.variants[0]).id,
        rows: ['1'],
        legend: PINK,
      },
      f.run,
    );
    const after = (await registry.execute('override.list', { doc: HERO_ID }, f.run)) as {
      counts: { valid: number; stale: number };
    };
    expect(after.counts).toMatchObject({ valid: 0, stale: 1 });
  });
});
