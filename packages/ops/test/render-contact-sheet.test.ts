// render.contactSheet: schema test, example test, rig frames (CORE-03), overlay placement, limits.
import { contactSheetFrameOrigin, contactSheetPlan } from '@pixel-forge/io';
import { decodePng } from '@pixel-forge/png';
import type { DecodedRgba } from '@pixel-forge/png';
import { describe, expect, it } from 'vitest';
import { registry, renderContactSheet } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

interface SheetOut {
  frames: number;
  columns: number;
  rows: number;
  scale: number;
  image: { mimeType: string; data: string; width: number; height: number };
}

const decode = (out: { image: { data: string } }): DecodedRgba =>
  decodePng(new Uint8Array(Buffer.from(out.image.data, 'base64')));

/** The sub-image `w` x `h` at `(x, y)`, as comparable bytes. */
function crop(img: DecodedRgba, x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let yy = y; yy < y + h; yy++) {
    const o = (yy * img.width + x) * 4;
    out.push(...img.data.subarray(o, o + w * 4));
  }
  return out;
}

async function sheet(run: RunOptions, input: Record<string, unknown> = {}): Promise<SheetOut> {
  return (await registry.execute(
    'render.contactSheet',
    { doc: HERO_ID, ...input },
    run,
  )) as SheetOut;
}

describe('render.contactSheet', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const err = await rejection(
      registry.execute('render.contactSheet', { doc: HERO_ID, scale: 0 }, run),
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details.issues).toEqual([{ path: 'scale', message: expect.any(String) as string }]);
    const empty = await rejection(
      registry.execute('render.contactSheet', { doc: HERO_ID, animations: [] }, run),
    );
    expect(empty.details.issues).toEqual([
      { path: 'animations', message: expect.any(String) as string },
    ]);
  });

  it('runs its example: the hero rig renders through the host renderer (CORE-03)', async () => {
    const { run, hero } = await openHero();
    const version = hero.store.version;
    const out = (await registry.execute(
      'render.contactSheet',
      need(renderContactSheet.examples[0]).input,
      run,
    )) as SheetOut;
    expect(out).toMatchObject({ frames: 1, columns: 1, rows: 1 });
    expect(out.image.mimeType).toBe('image/png');
    expect(Math.max(out.image.width, out.image.height)).toBeLessThanOrEqual(1568);
    const png = decode(out);
    expect([png.width, png.height]).toEqual([out.image.width, out.image.height]);
    expect(hero.store.version).toBe(version);
  });

  it('shows every frame of every animation, within 1568 px, and labels them', async () => {
    const { run } = await openHero();
    await registry.execute(
      'frame.duplicate',
      { doc: HERO_ID, animation: { group: 'default' }, frame: 0 },
      run,
    );
    const labelled = await sheet(run);
    expect(labelled.frames).toBe(2);
    expect(Math.max(labelled.image.width, labelled.image.height)).toBeLessThanOrEqual(1568);
    const plain = await sheet(run, { labels: false, scale: labelled.scale });
    expect(plain.frames).toBe(2);
    // the labels take room under the frames
    expect(plain.image.width * plain.image.height).toBeLessThan(
      labelled.image.width * labelled.image.height,
    );
    const small = await sheet(run, { scale: 2 });
    expect(small.scale).toBeLessThanOrEqual(2);
  });

  it('draws the same overlay as render.frame inside the tile', async () => {
    const { run, hero } = await openHero();
    const out = await sheet(run, { bones: true, pivots: true });
    const frame = (await registry.execute(
      'render.frame',
      {
        doc: HERO_ID,
        animation: { group: 'default' },
        frame: 0,
        scale: out.scale,
        bones: true,
        pivots: true,
      },
      run,
    )) as { image: { data: string } };
    const plan = contactSheetPlan(hero.store, {});
    const w = hero.store.doc.meta.canvas.w;
    const at = contactSheetFrameOrigin(plan, w, need(plan.tiles[0]));
    const framePng = decode(frame);
    const sheetPng = decode(out);
    expect(crop(sheetPng, at.x, at.y, framePng.width, framePng.height)).toEqual(
      crop(framePng, 0, 0, framePng.width, framePng.height),
    );
    // and the overlay-free sheet differs from it
    const bare = decode(await sheet(run, { scale: out.scale }));
    expect(crop(bare, at.x, at.y, framePng.width, framePng.height)).not.toEqual(
      crop(framePng, 0, 0, framePng.width, framePng.height),
    );
  });

  it("draws a mirror animation's overlay flipped, on its own tile", async () => {
    const { run, hero } = await openHero();
    const source = need(hero.store.doc.animations[0]);
    const tx = hero.store.begin('add mirror');
    const id = tx.newId('animation');
    tx.update((d) => {
      d.animations.push({
        id,
        group: 'default',
        direction: 'west',
        mirrorOf: source.id,
        overrides: [],
      });
    });
    tx.commit();
    const animations = [{ group: 'default', direction: 'west' }];
    const out = await sheet(run, { animations, bones: true, pivots: true, labels: false });
    const frame = (await registry.execute(
      'render.frame',
      {
        doc: HERO_ID,
        animation: animations[0],
        frame: 0,
        scale: out.scale,
        bones: true,
        pivots: true,
      },
      run,
    )) as { image: { data: string } };
    const plan = contactSheetPlan(hero.store, { animations, labels: false });
    const at = contactSheetFrameOrigin(plan, hero.store.doc.meta.canvas.w, need(plan.tiles[0]));
    const framePng = decode(frame);
    expect(crop(decode(out), at.x, at.y, framePng.width, framePng.height)).toEqual(
      crop(framePng, 0, 0, framePng.width, framePng.height),
    );
  });

  it('refuses overlays without a rig, and sheets that do not fit', async () => {
    const flat = await openFlat();
    const noRig = await rejection(
      registry.execute('render.contactSheet', { doc: FLAT.doc, bones: true }, flat.run),
    );
    expect(noRig).toMatchObject({ code: 'REFUSED', details: { reason: 'no-rig' } });
    const ok = (await registry.execute(
      'render.contactSheet',
      { doc: FLAT.doc },
      flat.run,
    )) as SheetOut;
    expect(ok.frames).toBe(2);
    const wide = await openFlat({ w: 2000, h: 2 });
    const tooBig = await rejection(
      registry.execute('render.contactSheet', { doc: FLAT.doc }, wide.run),
    );
    expect(tooBig.code).toBe('REFUSED');
    const unknown = await rejection(
      registry.execute(
        'render.contactSheet',
        { doc: FLAT.doc, animations: [{ group: 'nope' }] },
        flat.run,
      ),
    );
    expect(unknown.code).toBe('NOT_FOUND');
    const skin = await rejection(
      registry.execute('render.contactSheet', { doc: FLAT.doc, skin: 'nope' }, flat.run),
    );
    expect(skin).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'skin' } });
  });
});
