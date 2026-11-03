/**
 * `frame.add`: insert an empty frame before or after one frame of an animation.
 * @packageDocumentation
 */
import { insertFrame } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef, FrameRef, resolveAuthoredAnimation, resolveFrame } from '../refs.js';

/** `frame.add` (MCP `frame_add`, CLI `pf frame add`). */
export const frameAdd = defineOp({
  name: 'frame.add',
  safety: 'mutate',
  group: 'core',
  summary:
    'Insert an empty frame before or after a frame; the new frame gets no bone or part keys.',
  description:
    'The new frame has no keys, so bones and parts interpolate into it from the neighbouring keys. Cels and overrides are not copied (frame_duplicate copies them). Set its keys with rig_set_pose.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef.describe('Reference frame: the new frame goes next to it.'),
    position: z
      .enum(['before', 'after'])
      .default('after')
      .describe('"after" (default) inserts behind the reference frame, "before" in front of it.'),
    durationMs: z
      .int()
      .min(1)
      .optional()
      .describe('Duration of the new frame in ms (default: the reference frame duration).'),
  }),
  output: z.strictObject({
    frameId: z.string().describe('Id of the new frame.'),
    frameIndex: z.int().describe('Index of the new frame in the animation.'),
    frames: z.int().describe('Frame count of the animation afterwards.'),
  }),
  examples: [
    {
      title: 'Add an empty frame after frame 0 of the hero',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, frame: 0 },
      output: { frameId: 'frm_j83g8j', frameIndex: 1, frames: 2 },
    },
  ],
  handler: (ctx, input) => {
    const frameId = insertFrame(ctx.tx, input.animation, input.frame, {
      position: input.position,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
    const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
    const { index } = resolveFrame(animation, frameId);
    return { frameId, frameIndex: index, frames: animation.frames.length };
  },
});
