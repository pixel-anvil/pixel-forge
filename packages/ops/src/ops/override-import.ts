/**
 * `override.import`: diff an externally edited PNG of a frame against its render and store the
 * differences as overrides (FR-RIG-24, W4). The attribution is `attributeEdit`, shared with
 * `pixels.writeGrid` through `attributeFrameEdit`.
 * @packageDocumentation
 */
import { decodePng } from '@pixel-forge/png';
import type { Rgba } from '@pixel-forge/raster';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { readBytes } from '../file-io.js';
import { attributeFrameEdit, sameColor } from '../frame-edit.js';
import { frameIndexOf } from '../overlay.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  requireRig,
  resolveAnimation,
} from '../refs.js';

/** `override.import` (MCP `override_import`, CLI `pf override import`). */
export const overrideImport = defineOp({
  name: 'override.import',
  safety: 'io',
  group: 'rig',
  summary:
    'Import an edited PNG of a rig frame: the pixels that differ from the render become overrides.',
  description:
    'Touch-up path: export the frame (export, scale 1, one animation), edit the PNG, import it. The PNG must be canvas-sized; it is compared with the exported render. Each changed stroke becomes a part override when one part owns it, else a final one, and survives re-posing. `newlyStale` lists earlier overrides it made stale: see override_list. Needs a rig; palette-locked and indexed documents only take palette colours.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    file: z
      .string()
      .min(1)
      .describe('The edited PNG (absolute, inside the workspace roots), canvas size, scale 1.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the animation edited.'),
    frameIndex: z.int().describe('0-based index of the frame edited.'),
    changed: z.int().describe('Pixels that differ from the render (0: nothing was written).'),
    overrides: z.array(z.string()).describe('Ids of the overrides created, in order.'),
    newlyStale: z
      .array(z.string())
      .describe('Ids of earlier overrides this import made stale (still applied).'),
  }),
  examples: [
    {
      title: 'Import the touched-up frame 2 of the run animation',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'run', direction: 'side' },
        frame: 2,
        file: '/work/run-2-edited.png',
      },
    },
  ],
  handler: async (ctx, input) => {
    requireRig(ctx.doc);
    const path = ctx.host.resolvePath(input.file);
    const png = decodePng(await readBytes(ctx, path));
    const { w, h } = ctx.doc.meta.canvas;
    if (png.width !== w || png.height !== h) {
      throw new OpError(
        'REFUSED',
        `${path} is ${String(png.width)}x${String(png.height)} px, the canvas is ${String(w)}x${String(h)}; export at scale 1 and keep the size`,
        { reason: 'bad-size', canvas: { w, h }, image: { w: png.width, h: png.height } },
      );
    }
    const { animation } = resolveAnimation(ctx.doc, input.animation);
    const frameIndex = frameIndexOf(ctx, input.animation, input.frame);
    const before = ctx.renderFrame(input.animation, frameIndex, { exportOnly: true });
    const edited = before.clone();
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const colour: Rgba = [
          png.data[o] ?? 0,
          png.data[o + 1] ?? 0,
          png.data[o + 2] ?? 0,
          png.data[o + 3] ?? 0,
        ];
        if (sameColor(before.get(x, y), colour)) continue;
        edited.set(x, y, colour);
        changed += 1;
      }
    }
    const base = { animation: animationLabel(animation), frameIndex, changed };
    if (changed === 0) return { ...base, overrides: [], newlyStale: [] };
    // Last: the transaction commits here; nothing after it may fail.
    const result = ctx.transact((tx) =>
      attributeFrameEdit(ctx, tx, input.animation, frameIndex, edited),
    );
    return { ...base, ...result };
  },
});
