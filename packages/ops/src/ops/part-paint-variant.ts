/**
 * `part.paintVariant`: write pixels into a part variant's own image (RIG-07).
 * @packageDocumentation
 */
import { referencedImages } from '@pixel-forge/core';
import { IndexedImage, TiledImage } from '@pixel-forge/raster';
import type { Rgba } from '@pixel-forge/raster';
import { z } from 'zod';
import { activePalette, paletteIndexOf } from '../cel.js';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { sameColor } from '../frame-edit.js';
import { HexColor, MAX_WRITE_GRID } from '../grid.js';
import { DocRef, PartRef, VariantRef, resolvePart, resolveVariant } from '../refs.js';
import { checkPalette, parseGrid } from './pixels-write-grid.js';

/**
 * `part.paintVariant` (MCP `part_paint_variant`, CLI `pf part paint-variant`).
 *
 * Replaces the variant's image with a copy that has the grid written over it, the way
 * `part.paintOverlap` does, so it is one undo step. The image grows when the grid reaches outside it
 * and the pivot moves with it, so the part stays in place. Stale overrides need no code: a part
 * override is hashed over the part's own render, which includes this image. `PART_RENDER_VERSION`
 * stays as it is: only a change of the part pipeline's code versions it, not a change of data.
 */
export const partPaintVariant = defineOp({
  name: 'part.paintVariant',
  safety: 'mutate',
  summary: "Paint a text grid into a part variant's own image.",
  description:
    '"." transparent, "_" keeps. x, y are in the variant image; negative grows it (the pivot moves, the part stays put). Fixes a cut for every pose. Frame overrides of the part go stale (override_list). Locked palettes: palette colours only.',
  input: z.strictObject({
    doc: DocRef,
    part: PartRef,
    variant: VariantRef.default('default'),
    x: z.int().optional().describe('Column of the grid in the variant image (default 0).'),
    y: z.int().optional().describe('Row (default 0).'),
    rows: z
      .array(z.string().min(1).max(MAX_WRITE_GRID))
      .min(1)
      .max(MAX_WRITE_GRID)
      .describe('Equal-length rows, at most 32x32 symbols.'),
    legend: z.record(z.string(), HexColor).describe('Symbol (0-9A-Za-z) to "#rrggbb[aa]".'),
  }),
  output: z.strictObject({
    part: z.string().describe('Part layer name.'),
    variant: z.string().describe('Variant id.'),
    changed: z.int().describe('Pixels whose colour changed (0: nothing was written).'),
    grew: z
      .strictObject({ left: z.int(), top: z.int(), right: z.int(), bottom: z.int() })
      .describe('Pixels the image grew on each side.'),
    pivot: z.strictObject({ x: z.int(), y: z.int() }).describe('Pivot afterwards.'),
  }),
  examples: [
    {
      title: 'Restore two forearm pixels',
      input: {
        doc: 'doc_g1ed5q',
        part: 'lower_arm_r',
        x: 0,
        y: 0,
        rows: ['11'],
        legend: { '1': '#e8be96' },
      },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const { part, name } = resolvePart(doc, input.part);
    const variant = resolveVariant(part, input.variant);
    const old = ctx.view.image(variant.imageId);
    if (old === undefined) {
      throw new OpError('INTERNAL', `image ${variant.imageId} of variant ${variant.id} is missing`);
    }
    const cells = parseGrid(input.rows, input.legend);
    checkPalette(doc, cells);
    const x0 = input.x ?? 0;
    const y0 = input.y ?? 0;
    const palette = activePalette(doc);
    if (old instanceof IndexedImage && palette === undefined) {
      throw new OpError('REFUSED', 'the document is indexed but has no active palette', {
        reason: 'no-palette',
      });
    }

    // The pixels that differ from the old image (outside it counts as transparent).
    const writes: { x: number; y: number; rgba: Rgba; index: number }[] = [];
    cells.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell === 'keep') return;
        const x = x0 + c;
        const y = y0 + r;
        const inside = x >= 0 && y >= 0 && x < old.width && y < old.height;
        let index = 0;
        let same: boolean;
        if (old instanceof IndexedImage) {
          index =
            cell[3] === 0
              ? old.transparentIndex
              : ((palette && paletteIndexOf(palette, cell)) ?? old.transparentIndex);
          same = inside ? old.get(x, y) === index : index === old.transparentIndex;
        } else {
          same = inside ? sameColor(old.get(x, y), cell) : cell[3] === 0;
        }
        if (!same) writes.push({ x, y, rgba: cell, index });
      });
    });
    const pivot = { x: variant.pivot.x, y: variant.pivot.y };
    if (writes.length === 0) {
      return {
        part: name,
        variant: variant.id,
        changed: 0,
        grew: { left: 0, top: 0, right: 0, bottom: 0 },
        pivot,
      };
    }

    const minX = Math.min(0, ...writes.map((p) => p.x));
    const minY = Math.min(0, ...writes.map((p) => p.y));
    const maxX = Math.max(old.width - 1, ...writes.map((p) => p.x));
    const maxY = Math.max(old.height - 1, ...writes.map((p) => p.y));
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    let image: TiledImage | IndexedImage;
    if (old instanceof IndexedImage) {
      const t = old.transparentIndex;
      const data = new Uint8Array(w * h).fill(t);
      const src = old.toIndices();
      for (let y = 0; y < old.height; y++) {
        data.set(src.subarray(y * old.width, (y + 1) * old.width), (y - minY) * w - minX);
      }
      for (const p of writes) data[(p.y - minY) * w + (p.x - minX)] = p.index;
      image = IndexedImage.fromIndices(w, h, data, t);
    } else {
      const data = new Uint8Array(w * h * 4);
      const src = old.toRGBA().data;
      for (let y = 0; y < old.height; y++) {
        data.set(
          src.subarray(y * old.width * 4, (y + 1) * old.width * 4),
          ((y - minY) * w - minX) * 4,
        );
      }
      for (const p of writes) data.set(p.rgba, ((p.y - minY) * w + (p.x - minX)) * 4);
      image = TiledImage.fromRGBA({ width: w, height: h, data });
    }
    const imageId = ctx.tx.createImage(image);
    const next = { x: pivot.x - minX, y: pivot.y - minY };
    ctx.tx.update((d) => {
      const dv = d.rig?.parts
        .find((p) => p.id === part.id)
        ?.variants.find((v) => v.id === variant.id);
      if (dv === undefined) return;
      dv.imageId = imageId;
      dv.pivot = { ...next };
    });
    if (!referencedImages(ctx.tx.doc).has(variant.imageId)) ctx.tx.deleteImage(variant.imageId);
    return {
      part: name,
      variant: variant.id,
      changed: writes.length,
      grew: {
        left: 0 - minX,
        top: 0 - minY,
        right: maxX - (old.width - 1),
        bottom: maxY - (old.height - 1),
      },
      pivot: next,
    };
  },
});
