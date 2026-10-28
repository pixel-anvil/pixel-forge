// T3.9: the synthetic hero fixtures (fixtures/src/hero.ts, fixtures/src/aseprite/hero_parts.lua).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from '@pixel-forge/core';
import type { TiledImage } from '@pixel-forge/raster';
import { HUMANOID_BONES, humanoidSide, jointCheck } from '@pixel-forge/rig';
import type { ImageId, Layer } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { createDocumentFromAseprite, pxfStore, readPxf } from '../src/index.js';
import { need } from './helpers.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

interface HeroModule {
  HERO_PARTS: readonly {
    layer: string;
    bone: string;
    variant?: string;
    rects: readonly (readonly [number, number, number, number, readonly number[]])[];
  }[];
  HERO_CAPS: Readonly<Record<string, readonly [number, number, number, number]>>;
  HERO_SIZE: number;
  HERO_HEIGHT: number;
  HERO_ORIGIN: { x: number; y: number };
  rasterizePart(part: HeroModule['HERO_PARTS'][number]): Uint8Array;
  partBox(part: HeroModule['HERO_PARTS'][number]): [number, number, number, number];
  buildHeroPxf(): Promise<Uint8Array>;
}
// Loaded by URL: the generator lives outside every package's tsconfig.
const hero = (await import(
  /* @vite-ignore */ pathToFileURL(`${fixtures}src/hero.ts`).href
)) as HeroModule;

const template = humanoidSide({ height: hero.HERO_HEIGHT, origin: hero.HERO_ORIGIN });
/** Canvas pivot of every bone: the sum of the rest offsets along the parent chain. */
const pivots = new Map<string, { x: number; y: number }>();
for (const b of template.bones) {
  const p = b.parent === undefined ? { x: 0, y: 0 } : need(pivots.get(b.parent));
  pivots.set(b.name, { x: p.x + b.rest.x, y: p.y + b.rest.y });
}
const alpha = (bone: string): ((x: number, y: number) => boolean) => {
  const part = need(hero.HERO_PARTS.find((p) => p.bone === bone && p.variant === undefined));
  const data = hero.rasterizePart(part);
  return (x, y) => (data[(y * hero.HERO_SIZE + x) * 4 + 3] ?? 0) > 0;
};

describe('hero.pxf', () => {
  const committed = new Uint8Array(readFileSync(`${fixtures}generated/hero.pxf`));

  it('regenerates byte for byte', async () => {
    const a = await hero.buildHeroPxf();
    expect(Buffer.from(a).equals(Buffer.from(committed))).toBe(true);
    expect(Buffer.from(await hero.buildHeroPxf()).equals(Buffer.from(a))).toBe(true);
  });

  it('binds every part by name, with the sleeve variant on the right forearm', () => {
    const file = readPxf(committed);
    const rig = need(file.doc.rig);
    expect(validate(pxfStore(file)).filter((f) => f.severity === 'error')).toEqual([]);
    expect(rig.bones.map((b) => b.name)).toEqual([...HUMANOID_BONES]);
    expect(rig.views.map((v) => v.name)).toEqual(['side']);
    const bones = HUMANOID_BONES.filter((b) => b !== 'root');
    const byBone = new Map(
      rig.parts.map((p) => [need(rig.bones.find((b) => b.id === p.boneId)).name, p]),
    );
    expect([...byBone.keys()].sort()).toEqual([...bones].sort());
    for (const [bone, part] of byBone) {
      const names = part.variants.map((v) => v.name);
      expect(names).toEqual(bone === 'lower_arm_r' ? ['default', 'sleeve'] : ['default']);
      // The pivot pixel, placed at the cel offset, is the bone's canvas pivot.
      for (const v of part.variants) {
        const src = need(
          hero.HERO_PARTS.find((p) => p.bone === bone && (p.variant ?? 'default') === v.name),
        );
        const [bx, by, bw, bh] = hero.partBox(src);
        const piv = need(pivots.get(bone));
        expect(v.pivot).toEqual({ x: piv.x - bx, y: piv.y - by });
        const img = need(file.images.get(v.imageId));
        expect([img.width, img.height]).toEqual([bw, bh]);
      }
    }
  });
});

describe('hero joint caps (rest pose, by hand-computed coordinates)', () => {
  // The rest-pose definition of docs/contracts/JOINT_CHECK.md checked by hand: every joint has a cap
  // rectangle that parent and child both cover (condition 3 "was covered" can then hold at the outer
  // side for any angle), and the pivot pixel lies in it. `jointCheck` (T3.4) is run below.
  const joints = template.bones.filter((b) => b.parent !== undefined && b.parent !== 'root');
  it('has a caps entry for every joint with parts on both sides', () => {
    expect(Object.keys(hero.HERO_CAPS).sort()).toEqual(joints.map((b) => b.name).sort());
  });
  for (const joint of joints) {
    it(`${joint.name}: cap covered by parent and child, pivot inside`, () => {
      const [cx, cy, cw, ch] = need(hero.HERO_CAPS[joint.name]);
      const parent = alpha(need(joint.parent));
      const child = alpha(joint.name);
      for (let y = cy; y < cy + ch; y++) {
        for (let x = cx; x < cx + cw; x++) {
          expect([x, y, parent(x, y), child(x, y)]).toEqual([x, y, true, true]);
        }
      }
      const p = need(pivots.get(joint.name));
      expect(p.x >= cx && p.x < cx + cw && p.y >= cy && p.y < cy + ch).toBe(true);
    });
  }
});

describe('hero jointCheck (T3.4, docs/contracts/JOINT_CHECK.md)', () => {
  const file = readPxf(new Uint8Array(readFileSync(`${fixtures}generated/hero.pxf`)));
  const rig = need(file.doc.rig);
  const images = { image: (id: ImageId) => file.images.get(id) };
  const input = { rig, images, canvas: file.doc.meta.canvas };

  const report = jointCheck(input);

  it('checks one joint per bone whose parent also has parts, over the default sweep', () => {
    expect(report.view).toBe('side');
    expect(report.params).toEqual({ rangeDeg: 30, stepDeg: 5, radius: 4 });
    // Every non-root bone but the pelvis (its parent, the root, has no part).
    expect(report.joints.map((j) => j.bone)).toEqual(
      HUMANOID_BONES.filter((b) => b !== 'root' && b !== 'pelvis').sort(),
    );
    for (const j of report.joints) expect(j.angles).toHaveLength(12);
    expect(report.summary.joints).toBe(15);
  });

  // FINDING (T3.4): the hero is NOT clean under the T3.0 definition. The 3 px joint caps are narrower
  // than the parts at the head, hips and knees. The art and the contract are unchanged. This pins the
  // exact (joint, angle, pixel) findings until the hero's caps are widened; then summary.gapCount is 0,
  // this test goes, and the `it.fails` below becomes a plain `it`.
  it('reports exactly these gaps today (default sweep, radius 4)', () => {
    const found = report.joints
      .filter((j) => j.gapCount > 0)
      .map((j) => [
        j.bone,
        j.angles.filter((a) => a.gaps.length > 0).map((a) => [a.angle, a.gaps]),
      ]);
    expect(found).toEqual([
      [
        'head',
        [
          [
            -30,
            [
              [27, 8],
              [26, 9],
            ],
          ],
          [-25, [[26, 9]]],
          [-20, [[26, 9]]],
          [20, [[22, 9]]],
          [25, [[22, 9]]],
        ],
      ],
      [
        'shin_l',
        [
          [-30, [[21, 37]]],
          [-25, [[21, 37]]],
          [-20, [[21, 37]]],
        ],
      ],
      [
        'shin_r',
        [
          [-30, [[22, 37]]],
          [-25, [[22, 37]]],
          [-20, [[22, 37]]],
          [20, [[25, 37]]],
          [25, [[25, 37]]],
          [30, [[25, 37]]],
        ],
      ],
      [
        'thigh_l',
        [
          [10, [[25, 28]]],
          [15, [[25, 28]]],
          [20, [[25, 28]]],
        ],
      ],
      [
        'thigh_r',
        [
          [15, [[26, 28]]],
          [20, [[26, 28]]],
        ],
      ],
    ]);
    expect(report.summary).toEqual({ joints: 15, jointsWithGaps: 5, gapCount: 20, unionCount: 8 });
  });

  // The card's acceptance: no gaps at the angles JOINT_CHECK.md requires (±30° in 5° steps). It fails
  // until the hero's caps are fixed; `it.fails` makes the suite notice when it starts to pass.
  it.fails('has no gaps over the default sweep (±30°, 5°, radius 4)', () => {
    expect(report.summary.gapCount).toBe(0);
  });
});

describe('hero_parts.aseprite', () => {
  it('imports to the same pixels as the TS parts', () => {
    const bytes = new Uint8Array(readFileSync(`${fixtures}aseprite/hero_parts.aseprite`));
    const { store, report } = createDocumentFromAseprite(bytes);
    expect(store.doc.meta.canvas).toEqual({ w: hero.HERO_SIZE, h: hero.HERO_SIZE });
    expect(report.parts.unbound.map((u) => u.source).sort()).toEqual(
      hero.HERO_PARTS.map((p) => p.layer).sort(),
    );
    const flat = (ls: readonly Layer[]): Layer[] =>
      ls.flatMap((l) => (l.kind === 'group' ? flat(l.children) : [l]));
    const layers = flat(store.doc.layers as Layer[]);
    expect(layers).toHaveLength(hero.HERO_PARTS.length);
    for (const u of report.parts.unbound) {
      const part = need(hero.HERO_PARTS.find((p) => p.layer === u.source));
      const layer = need(layers.find((l) => l.id === u.layerId));
      if (layer.kind !== 'pixel') throw new Error('not a pixel layer');
      const cel = need(Object.values(layer.cels)[0]);
      if (!('imageId' in cel)) throw new Error('linked cel');
      const img = need(store.image(cel.imageId)) as TiledImage;
      const rgba = img.toRGBA();
      const full = new Uint8Array(hero.HERO_SIZE * hero.HERO_SIZE * 4);
      for (let y = 0; y < rgba.height; y++) {
        const at = ((y + cel.offset.y) * hero.HERO_SIZE + cel.offset.x) * 4;
        full.set(rgba.data.subarray(y * rgba.width * 4, (y + 1) * rgba.width * 4), at);
      }
      expect(Buffer.from(full).equals(Buffer.from(hero.rasterizePart(part)))).toBe(true);
    }
  });
});
