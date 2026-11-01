/**
 * `render.frame`: one frame as an upscaled PNG, optionally with the bone and pivot overlay (FR-AI-12).
 * @packageDocumentation
 */
import { z } from 'zod';
import { defineOp } from '../define.js';
import { ImageOutput, pngOutput } from '../image-output.js';
import {
  boneMarks,
  blitOver,
  checkerBuffer,
  fitScale,
  frameIndexOf,
  paintMarks,
} from '../overlay.js';
import { resolveSkin, SkinArg } from '../skin.js';
import { AnimRef, DocRef, FrameRef, animationLabel, resolveAnimation } from '../refs.js';

/** The bones of an overlay, in canvas pixels. */
export const OverlayBone = z.strictObject({
  name: z.string().describe('Bone name.'),
  parent: z.string().optional().describe('Parent bone name; missing for a root bone.'),
  pivot: z.tuple([z.int(), z.int()]).describe('Snapped pivot pixel [x, y], canvas coordinates.'),
  tip: z
    .tuple([z.int(), z.int()])
    .describe('Bone tip [x, y]: the pivot plus the bone length along its world direction.'),
});

/** `render.frame` (MCP `render_frame`, CLI `pf render frame`). */
export const renderFrame = defineOp({
  name: 'render.frame',
  safety: 'read',
  summary:
    'Render one frame to an upscaled PNG on a checkerboard (long edge at most 1568 px), optionally with bone lines and pivot markers.',
  description:
    'Look at the result of an edit: vision judges gesture, proportions and readability, lint.run owns precision (1 px gaps, off-palette pixels). The image is `output.image` (PNG, base64). `bones` draws a yellow line from each bone pivot to its tip, `pivots` a red square on each snapped pivot pixel (both need a rig; `output.bones` lists the points as numbers). Transparent pixels show a grey checkerboard.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    scale: z
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Integer upscale 1..16 (default and maximum: the largest that keeps the long edge within 1568 px).',
      ),
    skin: SkinArg.optional(),
    bones: z
      .boolean()
      .optional()
      .describe('Draw a line from each bone pivot to its tip (default false).'),
    pivots: z
      .boolean()
      .optional()
      .describe('Draw a marker on each bone pivot pixel (default false).'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the rendered animation.'),
    frameIndex: z.int().describe('0-based index of the rendered frame.'),
    scale: z.int().describe('The upscale used (may be lower than requested to fit 1568 px).'),
    image: ImageOutput.describe('The rendered PNG.'),
    bones: z
      .array(OverlayBone)
      .optional()
      .describe('The overlay bones in canvas pixels; present when bones or pivots was set.'),
  }),
  examples: [
    {
      title: 'Look at frame 0 of the hero with the skeleton drawn',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        scale: 8,
        bones: true,
        pivots: true,
      },
    },
  ],
  handler: (ctx, input) => {
    const { animation } = resolveAnimation(ctx.doc, input.animation);
    const skin = resolveSkin(ctx.doc, input.skin);
    const frameIndex = frameIndexOf(ctx, input.animation, input.frame);
    const { w, h } = ctx.doc.meta.canvas;
    const scale = fitScale(w, h, input.scale);
    const wantBones = input.bones === true;
    const wantPivots = input.pivots === true;
    const marks = wantBones || wantPivots ? boneMarks(ctx, input.animation, frameIndex) : undefined;

    const frame = ctx.renderFrame(input.animation, frameIndex, {
      exportOnly: true,
      ...(skin === undefined ? {} : { skin }),
    });
    const out = checkerBuffer(w * scale, h * scale);
    blitOver(out, frame.toRGBA(), 0, 0, scale);
    if (marks !== undefined) {
      paintMarks(out, { x: 0, y: 0, scale, width: w, height: h }, marks, {
        bones: wantBones,
        pivots: wantPivots,
      });
    }
    return {
      animation: animationLabel(animation),
      frameIndex,
      scale,
      image: pngOutput(out),
      ...(marks === undefined
        ? {}
        : {
            bones: marks.map((m) => ({
              name: m.name,
              ...(m.parent === undefined ? {} : { parent: m.parent }),
              pivot: [m.pivot[0], m.pivot[1]] as [number, number],
              tip: [m.tip[0], m.tip[1]] as [number, number],
            })),
          }),
    };
  },
});
