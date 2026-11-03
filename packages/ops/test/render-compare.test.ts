// render.compare: A, B and a difference tile; counts, bounds, limits, no document change.
import { documentHash } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/index.js';
import { HERO_ID, openHero, rejection } from './helpers.js';

const anim = { group: 'default' };
interface Out {
  a: string;
  b: string;
  scale: number;
  identical: boolean;
  changedPixels: number;
  bounds?: { x: number; y: number; w: number; h: number };
  image: { data: string; width: number; height: number };
}

describe('render.compare', () => {
  it('rejects bad input with the issue path', async () => {
    const { run } = await openHero();
    const bad = await rejection(
      registry.execute(
        'render.compare',
        { doc: HERO_ID, a: { animation: anim, frame: 0 }, b: { animation: anim } },
        run,
      ),
    );
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([
      { path: 'b.frame', message: expect.any(String) as string },
    ]);
  });

  it('reports identical frames and an empty diff tile', async () => {
    const { hero, run } = await openHero();
    const before = documentHash(hero.store);
    const side = { animation: anim, frame: 0 };
    const out = (await registry.execute(
      'render.compare',
      { doc: HERO_ID, a: side, b: side, scale: 2 },
      run,
    )) as Out;
    expect(out).toMatchObject({
      a: 'default #0',
      b: 'default #0',
      identical: true,
      changedPixels: 0,
    });
    expect(out.bounds).toBeUndefined();
    const img = decodePng(new Uint8Array(Buffer.from(out.image.data, 'base64')));
    expect(img.width).toBe(out.image.width);
    expect(img.width).toBeLessThanOrEqual(1568);
    expect(documentHash(hero.store)).toBe(before);
  });

  it('counts the pixels a re-pose changes, with their bounds, and paints them magenta', async () => {
    const { hero, run } = await openHero();
    await registry.execute('frame.duplicate', { doc: HERO_ID, animation: anim, frame: 0 }, run);
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 1, bones: { upper_arm_r: { angle: 60 } } },
      run,
    );
    await registry.execute(
      'rig.setPose',
      { doc: HERO_ID, animation: anim, frame: 0, bones: { upper_arm_r: { angle: 0 } } },
      run,
    );
    const out = (await registry.execute(
      'render.compare',
      {
        doc: HERO_ID,
        a: { animation: anim, frame: 0 },
        b: { animation: anim, frame: 1 },
        scale: 1,
      },
      run,
    )) as Out;
    expect(out.identical).toBe(false);
    expect(out.changedPixels).toBeGreaterThan(0);
    const { w, h } = hero.store.doc.meta.canvas;
    expect(out.image.width).toBe(3 * w + 4);
    expect(out.image.height).toBe(h);
    const b = out.bounds;
    expect(b).toBeDefined();
    const img = decodePng(new Uint8Array(Buffer.from(out.image.data, 'base64')));
    const magenta = (x: number, y: number): boolean => {
      const o = (y * img.width + x) * 4;
      return img.data[o] === 255 && img.data[o + 1] === 0 && img.data[o + 2] === 255;
    };
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 2 * (w + 2); x < 3 * w + 4; x++) if (magenta(x, y)) n++;
    expect(n).toBe(out.changedPixels);
  });
});
