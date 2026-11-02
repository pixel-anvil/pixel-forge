/**
 * `frame.delete`: remove one frame of an animation (its keys, cels and overrides go with it).
 * @packageDocumentation
 */
import { deleteFrame } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef, FrameRef, resolveAuthoredAnimation, resolveFrame } from '../refs.js';

/**
 * `frame.delete` (MCP `frame_delete`, CLI `pf frame delete`). `mutate`, not `destructive`: the spec
 * (section 9.2, "Everything can be undone") asks for confirmation only on bake-in-place and on
 * deleting an animation, and a frame delete is one undo step.
 */
export const frameDelete = defineOp({
  name: 'frame.delete',
  safety: 'mutate',
  summary:
    'Delete one frame with its bone and part keys, cels and overrides; the last frame cannot go.',
  description:
    "Links to the frame's cels are materialised first: the other linked frames keep their picture as their own copy. Images nothing references any more are removed. Later frames move down one index. An animation keeps at least one frame.",
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
  }),
  output: z.strictObject({
    frameId: z.string().describe('Id of the deleted frame.'),
    frames: z.int().describe('Frame count of the animation afterwards.'),
  }),
  examples: [
    {
      title: 'Delete frame 1 of the hero (add a second frame first; the hero has one)',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, frame: 1 },
      output: { frameId: 'frm_j83g8j', frames: 1 },
    },
  ],
  handler: (ctx, input) => {
    const { animation: before } = resolveAuthoredAnimation(ctx.doc, input.animation);
    const { frame } = resolveFrame(before, input.frame);
    const frameId = frame.id;
    deleteFrame(ctx.tx, input.animation, input.frame);
    const { animation } = resolveAuthoredAnimation(ctx.doc, input.animation);
    return { frameId, frames: animation.frames.length };
  },
});
