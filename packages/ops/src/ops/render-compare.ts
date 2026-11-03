/**
 * `render.compare`: two frames of one document side by side with a pixel difference (FR-AI-12).
 * @packageDocumentation
 */
import { z } from 'zod';
import { defineOp } from '../define.js';
import { ImageOutput, pngOutput } from '../image-output.js';
import type { RgbaBuffer } from '../image-output.js';
import { blitOver, checkerBuffer, fitScale, frameIndexOf } from '../overlay.js';
import { AnimRef, DocRef, FrameRef, animationLabel, resolveAnimation } from '../refs.js';
import { SkinArg, resolveSkin } from '../skin.js';

/** Gap between the three tiles, in canvas pixels. */
const GAP = 2;
const GAP_COLOR = [20, 20, 20, 255] as const;
const DIFF_COLOR = [255, 0, 255, 255] as const;

const Side = z.strictObject({
  animation: AnimRef,
  frame: FrameRef,
  skin: SkinArg.optional(),
});

/** `render.compare` (MCP `render_compare`, CLI `pf render compare`). */
export const renderCompare = defineOp({
  name: 'render.compare',
  safety: 'read',
  group: 'rig',
  summary:
    'Render two frames side by side (A, B) plus a difference tile with changed pixels in magenta (long edge at most 1568 px).',
  description:
    'Compare two poses, two skins or two animations of one document: tiles are A, B, diff, left to right. The diff marks pixels whose colour or alpha differ. Output counts them and gives their bounding box in canvas pixels. For a before/after of an edit, copy the frame first (frame_duplicate), edit, then compare. Vision judges gesture; lint owns precision.',
  input: z.strictObject({
    doc: DocRef,
    a: Side.describe('First frame (left).'),
    b: Side.describe('Second frame (middle).'),
    scale: z
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('Integer upscale 1..16 (default: the largest that fits 1568 px).'),
  }),
  output: z.strictObject({
    a: z.string().describe('"group/direction #frame" of A.'),
    b: z.string().describe('"group/direction #frame" of B.'),
    scale: z.int().describe('The upscale used.'),
    identical: z.boolean().describe('True when no pixel differs.'),
    changedPixels: z.int().describe('Pixels that differ between A and B.'),
    bounds: z
      .strictObject({ x: z.int(), y: z.int(), w: z.int(), h: z.int() })
      .optional()
      .describe('Bounding box of the differences, canvas pixels; missing when identical.'),
    image: ImageOutput.describe('The PNG: A, B, diff.'),
  }),
  examples: [
    {
      title: 'Compare the base look with the rival skin',
      input: {
        doc: 'doc_g1ed5q',
        a: { animation: { group: 'default' }, frame: 0 },
        b: { animation: { group: 'default' }, frame: 0, skin: 'rival' },
      },
    },
  ],
  handler: (ctx, input) => {
    const { w, h } = ctx.doc.meta.canvas;
    const scale = fitScale(3 * w + 2 * GAP, h, input.scale);
    const render = (side: z.output<typeof Side>): { img: RgbaBuffer; label: string } => {
      const { animation } = resolveAnimation(ctx.doc, side.animation);
      const index = frameIndexOf(ctx, side.animation, side.frame);
      const skin = resolveSkin(ctx.doc, side.skin);
      const frame = ctx.renderFrame(side.animation, index, {
        exportOnly: true,
        ...(skin === undefined ? {} : { skin }),
      });
      return { img: frame.toRGBA(), label: `${animationLabel(animation)} #${String(index)}` };
    };
    const a = render(input.a);
    const b = render(input.b);

    const diff: RgbaBuffer = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    let changed = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const pa = a.img.data.subarray(o, o + 4);
        const pb = b.img.data.subarray(o, o + 4);
        const aa = pa[3] ?? 0;
        const same =
          aa === (pb[3] ?? 0) &&
          (aa === 0 || (pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]));
        if (same) continue;
        changed++;
        diff.data.set(DIFF_COLOR, o);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }

    const out = checkerBuffer((3 * w + 2 * GAP) * scale, h * scale);
    const tile = (n: number): number => n * (w + GAP) * scale;
    for (const n of [1, 2]) {
      const gapX = tile(n) - GAP * scale;
      for (let y = 0; y < out.height; y++) {
        for (let x = gapX; x < gapX + GAP * scale; x++)
          out.data.set(GAP_COLOR, (y * out.width + x) * 4);
      }
    }
    blitOver(out, a.img, tile(0), 0, scale);
    blitOver(out, b.img, tile(1), 0, scale);
    blitOver(out, diff, tile(2), 0, scale);
    return {
      a: a.label,
      b: b.label,
      scale,
      identical: changed === 0,
      changedPixels: changed,
      ...(changed === 0 ? {} : { bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } }),
      image: pngOutput(out),
    };
  },
});
