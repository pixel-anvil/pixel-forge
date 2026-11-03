/**
 * `selection.transform`: move, flip or rotate (90 degree steps) a rectangular region of a frame.
 * Uses the integer image transforms of `@pixel-forge/raster` (`crop`, `flipH`, `flipV`, `rot90`...).
 * @packageDocumentation
 */
import { crop, flipH, flipV, rot180, rot270, rot90 } from '@pixel-forge/raster';
import type { TiledImage } from '@pixel-forge/raster';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { editOutputShape, editPixels, RegionInput, resolveRegion } from '../pixel-edit.js';
import { AnimRef, DocRef, FrameRef, LayerRef } from '../refs.js';

/** `selection.transform` (MCP `selection_transform`, CLI `pf selection transform`). */
export const selectionTransform = defineOp({
  name: 'selection.transform',
  safety: 'mutate',
  group: 'draw',
  summary: 'Move, flip or rotate (90 deg steps) a rectangular region of a frame, int px.',
  description:
    'move: lifts the region, clears it (unless copy) and drops its opaque pixels at +dx,+dy over the rest. flip / rotate: replace the region in place; a 90 or 270 rotation of a non-square region becomes h x w anchored at its top-left corner. Pixels pushed off the canvas are lost (counted in clipped). On a rig omit layer: the change becomes overrides of this frame (touch-ups only).',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    layer: LayerRef.optional().describe(
      'Pixel layer to edit. Omit on a rig frame, or when the document has one pixel layer.',
    ),
    region: RegionInput.optional().describe('Pixels to transform (default: the whole canvas).'),
    action: z.enum(['move', 'flip', 'rotate']).describe('What to do.'),
    dx: z
      .int()
      .min(-32768)
      .max(32767)
      .optional()
      .describe('move: columns to the right (default 0).'),
    dy: z.int().min(-32768).max(32767).optional().describe('move: rows down (default 0).'),
    copy: z.boolean().optional().describe('move: keep the original too (default false).'),
    axis: z.enum(['h', 'v']).optional().describe('flip: "h" mirrors left-right, "v" top-bottom.'),
    angle: z
      .int()
      .optional()
      .describe('rotate: degrees clockwise, a multiple of 90 (e.g. 90, 180, -90).'),
  }),
  output: z.strictObject({
    ...editOutputShape,
    clipped: z.int().describe('Opaque pixels lost off the canvas edge.'),
  }),
  examples: [
    {
      title: 'Move a 10x10 block 3 px right',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        region: { x: 20, y: 2, w: 10, h: 10 },
        action: 'move',
        dx: 3,
      },
    },
  ],
  handler: (ctx, input) => {
    const wrong = (path: string, message: string): OpError =>
      new OpError('BAD_INPUT', message, { issues: [{ path, message }] });
    const only = (action: string, fields: Record<string, unknown>): void => {
      if (input.action === action) return;
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) throw wrong(name, `"${name}" only applies to action "${action}"`);
      }
    };
    only('move', { dx: input.dx, dy: input.dy, copy: input.copy });
    only('flip', { axis: input.axis });
    only('rotate', { angle: input.angle });
    let turns = 0;
    if (input.action === 'flip' && input.axis === undefined) {
      throw wrong('axis', 'flip needs "axis": "h" or "v"');
    }
    if (input.action === 'rotate') {
      if (input.angle === undefined || input.angle % 90 !== 0) {
        throw wrong('angle', 'rotate needs "angle", a multiple of 90 degrees');
      }
      turns = (((input.angle / 90) % 4) + 4) % 4;
    }
    const region = resolveRegion(ctx, input.region);
    const result = { clipped: 0 };
    const report = editPixels(ctx, input, (field) => {
      const lifted = crop(field.image, region);
      const clear = (): void => {
        for (let y = 0; y < region.h; y++) {
          for (let x = 0; x < region.w; x++) field.set(region.x + x, region.y + y, [0, 0, 0, 0]);
        }
      };
      /** Writes `piece` with its top-left at `(ox, oy)`; transparent pixels only when `all`. */
      const paste = (piece: TiledImage, ox: number, oy: number, all: boolean): void => {
        for (let y = 0; y < piece.height; y++) {
          for (let x = 0; x < piece.width; x++) {
            const c = piece.get(x, y);
            if (c[3] === 0 && !all) continue;
            if (!field.set(ox + x, oy + y, c) && c[3] !== 0) result.clipped += 1;
          }
        }
      };
      if (input.action === 'move') {
        if (input.copy !== true) clear();
        paste(lifted, region.x + (input.dx ?? 0), region.y + (input.dy ?? 0), false);
        return;
      }
      let out = lifted;
      if (input.action === 'flip') out = input.axis === 'h' ? flipH(lifted) : flipV(lifted);
      else if (turns === 1) out = rot90(lifted);
      else if (turns === 2) out = rot180(lifted);
      else if (turns === 3) out = rot270(lifted);
      clear();
      paste(out, region.x, region.y, true);
    });
    return { ...report, clipped: result.clipped };
  },
});
