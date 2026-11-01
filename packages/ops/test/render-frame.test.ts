// render.frame: schema test, example test, image content, overlay placement, limits, skins.
import { decodePng } from '@pixel-forge/png';
import type { DecodedRgba } from '@pixel-forge/png';
import type { IndexedImage } from '@pixel-forge/raster';
import { describe, expect, it } from 'vitest';
import { bytesToBase64, registry, renderFrame } from '../src/index.js';
import { BONE_COLOR, PIVOT_COLOR, PIVOT_OUTLINE } from '../src/overlay.js';
import { FLAT, openFlat } from './grid-fixtures.js';
import type { HostedDocument, RunOptions } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

interface FrameOut {
  animation: string;
  frameIndex: number;
  scale: number;
  image: { mimeType: string; data: string; width: number; height: number };
  bones?: { name: string; parent?: string; pivot: [number, number]; tip: [number, number] }[];
}

const HERO_FRAME = { doc: HERO_ID, animation: { group: 'default' }, frame: 0 } as const;

const decode = (out: FrameOut): DecodedRgba =>
  decodePng(new Uint8Array(Buffer.from(out.image.data, 'base64')));
const px = (img: DecodedRgba, x: number, y: number): number[] => {
  const o = (y * img.width + x) * 4;
  return [...img.data.subarray(o, o + 4)];
};

async function frame(run: RunOptions, input: Record<string, unknown>): Promise<FrameOut> {
  return (await registry.execute('render.frame', { ...HERO_FRAME, ...input }, run)) as FrameOut;
}

describe('base64', () => {
  it('matches the platform encoder for every remainder', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('render.frame', () => {
  it('rejects bad input', async () => {
    const { run } = await openHero();
    const noFrame = await rejection(
      registry.execute('render.frame', { doc: HERO_ID, animation: { group: 'default' } }, run),
    );
    expect(noFrame.code).toBe('BAD_INPUT');
    expect(noFrame.details.issues).toEqual([
      { path: 'frame', message: expect.any(String) as string },
    ]);
    const big = await rejection(
      registry.execute('render.frame', { ...HERO_FRAME, scale: 17 }, run),
    );
    expect(big.details.issues).toEqual([{ path: 'scale', message: expect.any(String) as string }]);
  });

  it('runs its example: a 48x48 hero at x8 with the skeleton, as a PNG', async () => {
    const { run, hero } = await openHero();
    const version = hero.store.version;
    const example = need(renderFrame.examples[0]);
    const out = (await registry.execute('render.frame', example.input, run)) as FrameOut;
    expect(out).toMatchObject({ animation: 'default', frameIndex: 0, scale: 8 });
    expect(out.image).toMatchObject({ mimeType: 'image/png', width: 384, height: 384 });
    const png = decode(out);
    expect([png.width, png.height]).toEqual([384, 384]);
    expect(out.bones).toHaveLength(17);
    expect(hero.store.version).toBe(version); // read-only
  });

  it('draws the frame upscaled over a checkerboard', async () => {
    const { run } = await openHero();
    const png = decode(await frame(run, { scale: 4 }));
    // the eye (27, 4) is #1e1e28; the far top-left corner is transparent: checker, light square first
    expect(px(png, 27 * 4 + 1, 4 * 4 + 2)).toEqual([30, 30, 40, 255]);
    expect(px(png, 27 * 4 + 3, 4 * 4)).toEqual([30, 30, 40, 255]);
    expect(px(png, 0, 0)).toEqual([200, 200, 200, 255]);
    expect(px(png, 4, 0)).toEqual([150, 150, 150, 255]);
    expect(px(png, 4, 4)).toEqual([200, 200, 200, 255]);
  });

  it('defaults to the largest scale that fits and reduces an oversized one', async () => {
    const { run } = await openHero();
    expect((await frame(run, {})).image.width).toBe(768); // 48 * 16
    const flat = await openFlat({ w: 100, h: 90 });
    const base = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 };
    const out = (await registry.execute(
      'render.frame',
      { ...base, scale: 16 },
      flat.run,
    )) as FrameOut;
    expect(out).toMatchObject({ scale: 15 });
    expect([out.image.width, out.image.height]).toEqual([1500, 1350]);
    const huge = await openFlat({ w: 1569, h: 1 });
    const err = await rejection(registry.execute('render.frame', base, huge.run));
    expect(err).toMatchObject({ code: 'REFUSED', details: { reason: 'too-large' } });
  });

  it('places pivots on the snapped pivot pixels and bones along the rest pose', async () => {
    const { run, hero } = await openHero();
    const plain = decode(await frame(run, { scale: 4 }));
    const out = await frame(run, { scale: 4, bones: true, pivots: true });
    const marked = decode(out);
    // frame 0 has no keys, so every pivot is the sum of the rest offsets down the chain (hand maths)
    const rig = need(hero.store.doc.rig);
    const view = need(rig.views[0]);
    expect(need(hero.store.doc.animations[0])).toMatchObject({ frames: [{ boneKeys: {} }] });
    const pivotOf = (id: string): [number, number] => {
      let x = 0;
      let y = 0;
      for (let cur: string | undefined = id; cur !== undefined;) {
        const rest = need(view.rest[cur as keyof typeof view.rest]);
        x += rest.x;
        y += rest.y;
        cur = rig.bones.find((b) => b.id === cur)?.parentId;
      }
      return [x, y];
    };
    for (const bone of rig.bones) {
      const mark = need(out.bones?.find((m) => m.name === bone.name));
      expect(mark.pivot).toEqual(pivotOf(bone.id));
      // the pivot's centre pixel is the red marker; without the overlay it is not
      expect(px(marked, mark.pivot[0] * 4 + 2, mark.pivot[1] * 4 + 2)).toEqual([...PIVOT_COLOR]);
      expect(px(plain, mark.pivot[0] * 4 + 2, mark.pivot[1] * 4 + 2)).not.toEqual([...PIVOT_COLOR]);
    }
    // torso: pivot (24, 23), length 13 along the rest angle -90 deg (up): tip (24, 10)
    expect(out.bones?.find((m) => m.name === 'torso')).toEqual({
      name: 'torso',
      parent: 'pelvis',
      pivot: [24, 23],
      tip: [24, 10],
    });
    // the yellow bone line passes through the middle of the torso, between its two marks
    expect(px(marked, 24 * 4 + 2, 17 * 4)).toEqual([...BONE_COLOR]);
    // only overlay colours differ from the plain render
    const overlay = [BONE_COLOR, PIVOT_COLOR, PIVOT_OUTLINE].map((c) => c.join(','));
    let differing = 0;
    for (let i = 0; i < plain.data.length; i += 4) {
      const a = [...plain.data.subarray(i, i + 4)].join(',');
      const b = [...marked.data.subarray(i, i + 4)].join(',');
      if (a === b) continue;
      differing += 1;
      expect(overlay).toContain(b);
    }
    expect(differing).toBeGreaterThan(100);
  });

  it('draws bones or pivots alone', async () => {
    const { run } = await openHero();
    const bonesOnly = decode(await frame(run, { scale: 4, bones: true }));
    expect(px(bonesOnly, 24 * 4 + 2, 23 * 4 + 2)).toEqual([...BONE_COLOR]); // line, no marker
    const pivotsOnly = decode(await frame(run, { scale: 4, pivots: true }));
    expect(px(pivotsOnly, 24 * 4 + 2, 17 * 4)).not.toEqual([...BONE_COLOR]);
    expect(px(pivotsOnly, 24 * 4 + 2, 23 * 4 + 2)).toEqual([...PIVOT_COLOR]);
  });

  it('is deterministic', async () => {
    const { run } = await openHero();
    const a = await frame(run, { scale: 3, bones: true, pivots: true });
    const b = await frame(run, { scale: 3, bones: true, pivots: true });
    expect(a).toEqual(b);
  });

  it('flips the skeleton of a mirror animation about the origin', async () => {
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
    const out = await frame(run, {
      animation: { group: 'default', direction: 'west' },
      bones: true,
    });
    expect(out.animation).toBe('default/west');
    // foot_r: pivot on the axis (origin.x = 24), tip 6 px to the right at rest, so 6 px to the left
    expect(out.bones?.find((m) => m.name === 'foot_r')).toMatchObject({
      pivot: [24, 45],
      tip: [18, 45],
    });
  });

  it('refuses overlays without a rig, and unknown skins and frames', async () => {
    const flat = await openFlat();
    const base = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0 };
    const noRig = await rejection(
      registry.execute('render.frame', { ...base, bones: true }, flat.run),
    );
    expect(noRig).toMatchObject({ code: 'REFUSED', details: { reason: 'no-rig' } });
    const skin = await rejection(
      registry.execute('render.frame', { ...base, skin: 'nope' }, flat.run),
    );
    expect(skin).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'skin', available: [] } });
    const missing = await rejection(
      registry.execute('render.frame', { ...base, frame: 9 }, flat.run),
    );
    expect(missing).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
  });

  it('renders a skin by name or id', async () => {
    const { run, hosted } = await withRedSquareAndSkin();
    const base = { doc: FLAT.doc, animation: { group: 'idle' }, frame: 0, scale: 2 };
    const plain = decode((await registry.execute('render.frame', base, run)) as FrameOut);
    expect(px(plain, 2, 2)).toEqual([255, 0, 0, 255]);
    const skinId = need(hosted.store.doc.skins[0]).id;
    for (const skin of ['alt', skinId]) {
      const skinned = decode(
        (await registry.execute('render.frame', { ...base, skin }, run)) as FrameOut,
      );
      expect(px(skinned, 2, 2)).toEqual([0, 255, 0, 255]); // remap 1 -> 2: red to green
    }
  });
});

/** An indexed flat document with a red pixel at (1, 1) and a skin "alt" that remaps red to green. */
async function withRedSquareAndSkin(): Promise<{ run: RunOptions; hosted: HostedDocument }> {
  const { run, hosted } = await openFlat({ indexed: true });
  const tx = hosted.store.begin('setup');
  const skin = tx.newId('skin');
  tx.writeImage(FLAT.imgBg, (img) => {
    (img as IndexedImage).set(1, 1, 1);
  });
  tx.update((d) => {
    d.skins.push({ id: skin, name: 'alt', remap: [[1, 2]] });
  });
  tx.commit();
  return { run, hosted };
}
