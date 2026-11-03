// Second test rig (card E7.4): fixtures/generated/ninja.pxf, cut from the CC0 `male_base_ninja` sheet.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DocumentStore, createRigRenderer, renderFrame } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { jointCheck } from '@pixel-forge/rig';
import type { ImageId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { readPxf } from '../src/index.js';
import { need } from './helpers.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const ninja = (await import(/* @vite-ignore */ pathToFileURL(`${fixtures}src/ninja.ts`).href)) as {
  NINJA_CELL: { w: number; h: number };
  NINJA_COLUMN: number;
  NINJA_PAD_X: number;
  ninjaParts(): { bone: string; far?: boolean; piece?: string }[];
  rasterizeNinjaPart(p: unknown): Uint8Array;
  loadNinjaSource(): Promise<void>;
  buildNinjaPxf(): Promise<Uint8Array>;
};

const file = readPxf(new Uint8Array(readFileSync(`${fixtures}generated/ninja.pxf`)));
const rig = need(file.doc.rig);

describe('ninja.pxf', () => {
  it('is what the generator builds', async () => {
    const bytes = await ninja.buildNinjaPxf();
    expect(Buffer.from(bytes).equals(readFileSync(`${fixtures}generated/ninja.pxf`))).toBe(true);
  });

  it('has 16 parts, one on each bone except the root, and 4 joint pieces (E7.5)', () => {
    expect(file.doc.meta.canvas).toEqual({ w: ninja.NINJA_CELL.w + 2 * ninja.NINJA_PAD_X, h: 64 });
    expect(rig.parts).toHaveLength(20);
    // The knee pieces sit on the shin bones and the elbow pieces on the lower-arm bones.
    expect(new Set(rig.parts.map((p) => p.boneId)).size).toBe(16);
    expect(
      ninja
        .ninjaParts()
        .filter((p) => p.piece !== undefined)
        .map((p) => `${p.bone}.${p.piece ?? ''}`)
        .sort(),
    ).toEqual(['lower_arm_l.elbow', 'lower_arm_r.elbow', 'shin_l.knee', 'shin_r.knee']);
  });

  it('jointCheck is clean', () => {
    const images = { image: (id: ImageId) => file.images.get(id) };
    const report = jointCheck({ rig, images, canvas: file.doc.meta.canvas });
    expect(report.summary).toEqual({ joints: 15, jointsWithGaps: 0, gapCount: 0, unionCount: 0 });
  });

  it('renders the rest pose with the silhouette of the source cell', async () => {
    await ninja.loadNinjaSource();
    const sheet = decodePng(
      new Uint8Array(readFileSync(`${fixtures}cc0/male_base_ninja/ninja_full.png`)),
    );
    const store = new DocumentStore(file.doc, { images: file.images });
    const out = renderFrame(store, { group: 'default' }, 0, { rig: createRigRenderer() }).toRGBA();
    const { w, h } = ninja.NINJA_CELL;
    let opaque = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < out.width; x++) {
        const cx = x - ninja.NINJA_PAD_X;
        const want =
          cx >= 0 && cx < w
            ? (sheet.data[(y * sheet.width + ninja.NINJA_COLUMN * w + cx) * 4 + 3] ?? 0) > 0
            : false;
        const got = (out.data[(y * out.width + x) * 4 + 3] ?? 0) > 0;
        if (want) opaque++;
        expect(got, `pixel ${String(x)},${String(y)}`).toBe(want);
      }
    }
    expect(opaque).toBeGreaterThan(200);
  });

  it('has a darker far copy of each near limb', () => {
    const far = ninja.ninjaParts().filter((p) => p.far === true && p.piece === undefined);
    expect(far.map((p) => p.bone).sort()).toEqual([
      'foot_l',
      'hand_l',
      'lower_arm_l',
      'shin_l',
      'thigh_l',
      'upper_arm_l',
    ]);
  });
});
