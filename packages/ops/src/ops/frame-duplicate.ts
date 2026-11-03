/**
 * `frame.duplicate`: copy one frame of an animation right after itself.
 * @packageDocumentation
 */
import { duplicateFrame } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef, FrameRef, resolveAuthoredAnimation, resolveFrame } from '../refs.js';

/** `frame.duplicate` (MCP `frame_duplicate`, CLI `pf frame duplicate`). */
export const frameDuplicate = defineOp({
  name: 'frame.duplicate',
  safety: 'mutate',
  group: 'core',
  summary: 'Duplicate one frame; the copy goes right after it, with linked cels and copied keys.',
  description:
    'Cels of the copy link to the source frame (edit one, both change). Bone keys, part keys, markers, events, root motion, duration and overrides are copied, so the copy starts from the same pose: change it with rig_set_pose.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
  }),
  output: z.strictObject({
    frameId: z.string().describe('Id of the new frame.'),
    frameIndex: z.int().describe('Index of the new frame (source index + 1).'),
    frames: z.int().describe('Frame count of the animation afterwards.'),
  }),
  examples: [
    {
      title: 'Duplicate frame 0 of the hero',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, frame: 0 },
      output: { frameId: 'frm_j83g8j', frameIndex: 1, frames: 2 },
    },
  ],
  handler: (ctx, input) => {
    const frameId = duplicateFrame(ctx.tx, input.animation, input.frame);
    const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
    const { index } = resolveFrame(animation, frameId);
    return { frameId, frameIndex: index, frames: animation.frames.length };
  },
});
