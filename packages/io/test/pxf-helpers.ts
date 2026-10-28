import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocumentStore, referencedImages } from '@pixel-forge/core';
import type { RigRenderer } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import { Document } from '@pixel-forge/schema';
import type { ImageId } from '@pixel-forge/schema';
import { fixedClock } from '../src/index.js';
import type { WritePxfOptions } from '../src/index.js';

const frozenPath = fileURLToPath(
  new URL('../../../fixtures/frozen/v1/minimal-document.json', import.meta.url),
);

/** The frozen v1 `document.json` text, exactly as committed. */
export function frozenText(): string {
  return readFileSync(frozenPath, 'utf8');
}

/**
 * A store of the frozen v1 fixture document with tiny synthetic indexed images: indices 1..7 in a
 * deterministic pattern, and 0/255 masks for the images used as `erase`.
 */
export function frozenStore(): DocumentStore {
  const doc = Document.parse(JSON.parse(frozenText()));
  const erase = new Set<string>();
  for (const a of doc.animations) for (const o of a.overrides) if (o.erase) erase.add(o.erase);
  const images: [ImageId, IndexedImage][] = [...referencedImages(doc)].sort().map((id, n) => {
    const data = new Uint8Array(9);
    for (let i = 0; i < 9; i++) {
      data[i] = erase.has(id) ? (i % 2 === 0 ? 255 : 0) : 1 + ((i * 3 + n) % 7);
    }
    return [id, IndexedImage.fromIndices(3, 3, data, 0)];
  });
  return new DocumentStore(doc, { images });
}

/**
 * A rig renderer for tests: one 3x3 indexed part per part layer, positioned by the frame index so
 * every frame renders differently.
 */
export const fakeRig: RigRenderer = {
  renderParts(ctx) {
    const parts = ctx.view.doc.rig?.parts ?? [];
    return ctx.partLayers.flatMap((layer, n) => {
      const part = parts.find((p) => p.layerId === layer.id);
      if (part === undefined) return [];
      const img = IndexedImage.fromIndices(3, 3, new Uint8Array(9).fill(2 + n), 0);
      return [
        {
          layerId: layer.id,
          partId: part.id,
          z: n,
          image: img,
          offset: { x: 4 + ctx.frameIndex * 2 + n, y: 6 },
        },
      ];
    });
  },
};

/** Default write options: fixed clock, render cache with the fake rig. */
export function opts(extra: Partial<WritePxfOptions> = {}): WritePxfOptions {
  return { clock: fixedClock('2026-10-27T10:00:00Z'), rig: fakeRig, ...extra };
}

/** A small RGBA image with a recognisable pattern. */
export function rgbaImage(seed: number): TiledImage {
  const img = new TiledImage(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if ((x + y + seed) % 3 !== 0) img.set(x, y, [(seed * 40 + x * 30) & 255, y * 60, 90, 255]);
    }
  }
  return img;
}
