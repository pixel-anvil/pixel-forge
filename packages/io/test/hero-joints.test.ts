// Joint pieces (docs/ai/KNOWN_ISSUES.md RIG-10 to RIG-12): the hero with knee and shoulder pieces, fixtures/generated/hero_joints.pxf.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jointCheck } from '@pixel-forge/rig';
import type { ImageId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { readPxf } from '../src/index.js';
import { need } from './helpers.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const hero = (await import(/* @vite-ignore */ pathToFileURL(`${fixtures}src/hero.ts`).href)) as {
  HERO_JOINT_PARTS: readonly { layer: string; bone: string; rects: readonly number[][] }[];
  buildHeroPxf(parts: unknown, z: unknown): Promise<Uint8Array>;
  HERO_JOINT_Z: Record<string, number>;
};

const file = readPxf(new Uint8Array(readFileSync(`${fixtures}generated/hero_joints.pxf`)));
const rig = need(file.doc.rig);
const side = need(rig.views[0]);
/** The document layer name of a part: the bone name, or `<bone>_<part>`. */
const layerName = (layerId: string): string =>
  need(file.doc.layers.find((l) => l.id === layerId)).name;
const boneName = (id: string): string => need(rig.bones.find((b) => b.id === id)).name;

describe('hero_joints.pxf', () => {
  it('is what the generator builds', async () => {
    const bytes = await hero.buildHeroPxf(hero.HERO_JOINT_PARTS, hero.HERO_JOINT_Z);
    expect(Buffer.from(bytes).equals(readFileSync(`${fixtures}generated/hero_joints.pxf`))).toBe(
      true,
    );
  });

  it('has a second part on each shin bone, named knee', () => {
    for (const side of ['l', 'r']) {
      const parts = rig.parts.filter((p) => boneName(p.boneId) === `shin_${side}`);
      expect(parts.map((p) => layerName(p.layerId)).sort()).toEqual([
        `shin_${side}`,
        `shin_${side}_knee`,
      ]);
    }
  });

  it('draws each knee piece above its own leg and below the next leg', () => {
    const z = (layer: string): number => {
      const p = need(rig.parts.find((q) => layerName(q.layerId) === layer));
      return need(side.defaultZ[p.id]);
    };
    expect(z('shin_l_knee')).toBeGreaterThan(z('shin_l'));
    expect(z('shin_r_knee')).toBeGreaterThan(z('shin_r'));
    expect(z('shin_l_knee')).toBeLessThan(z('shin_r'));
  });

  it('centres each piece on the knee pivot and keeps the thigh above it', () => {
    for (const [bone, knee] of [
      ['shin_l', 'shin_l'],
      ['shin_r', 'shin_r'],
    ] as const) {
      const piece = need(hero.HERO_JOINT_PARTS.find((p) => p.layer === `part:${knee}.knee`));
      const ys = piece.rects.flatMap((r) => [r[1] ?? 0, (r[1] ?? 0) + (r[3] ?? 0) - 1]);
      expect([Math.min(...ys), Math.max(...ys)]).toEqual([33, 37]); // pivot row 35 in the middle
      const thigh = need(
        hero.HERO_JOINT_PARTS.find((p) => p.bone === bone.replace('shin', 'thigh')),
      );
      expect(thigh.rects).toHaveLength(1);
      expect((thigh.rects[0]?.[1] ?? 0) + (thigh.rects[0]?.[3] ?? 0) - 1).toBe(35); // ends at the pivot row
    }
  });

  it('has a shoulder piece on each upper-arm bone, centred on the shoulder pivot, at its arm z', () => {
    const z = (layer: string): number => {
      const p = need(rig.parts.find((q) => layerName(q.layerId) === layer));
      return need(side.defaultZ[p.id]);
    };
    for (const arm of ['upper_arm_l', 'upper_arm_r']) {
      const parts = rig.parts.filter((p) => boneName(p.boneId) === arm);
      expect(parts.map((p) => layerName(p.layerId)).sort()).toEqual([arm, `${arm}_shoulder`]);
      expect(z(`${arm}_shoulder`)).toBe(z(arm));
      const piece = need(hero.HERO_JOINT_PARTS.find((p) => p.layer === `part:${arm}.shoulder`));
      const ys = piece.rects.flatMap((r) => [r[1] ?? 0, (r[1] ?? 0) + (r[3] ?? 0) - 1]);
      expect([Math.min(...ys), Math.max(...ys)]).toEqual([11, 14]); // pivot row 12 near the top
    }
  });

  it('keeps each knee piece no wider than the shin (no lump when the knee bends)', () => {
    for (const side of ['l', 'r']) {
      const piece = need(hero.HERO_JOINT_PARTS.find((p) => p.layer === `part:shin_${side}.knee`));
      const widest = Math.max(...piece.rects.map((r) => r[2] ?? 0));
      expect(widest).toBeLessThanOrEqual(4);
    }
  });

  it('jointCheck is clean', () => {
    const images = { image: (id: ImageId) => file.images.get(id) };
    const report = jointCheck({ rig, images, canvas: file.doc.meta.canvas });
    expect(report.summary).toEqual({ joints: 15, jointsWithGaps: 0, gapCount: 0, unionCount: 0 });
  });
});
