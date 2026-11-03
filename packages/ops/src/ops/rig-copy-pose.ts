/**
 * `rig.copyPose`: copy the bone keys of one frame onto another frame, optionally mirrored (FR-RIG-17).
 * @packageDocumentation
 */
import { copyPoseTx, pastePoseTx } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  requireRig,
  resolveAuthoredAnimation,
  resolveFrame,
} from '../refs.js';

/** `rig.copyPose` (MCP `rig_copy_pose`, CLI `pf rig copy-pose`). */
export const rigCopyPose = defineOp({
  name: 'rig.copyPose',
  safety: 'mutate',
  group: 'rig',
  summary: 'Copy the bone keys of one frame onto another frame, optionally mirrored left/right.',
  description:
    'Copies the bone keys that exist on the source frame (angle, offset, flipX, interp), not interpolated values and not part keys. Each pasted bone key replaces the one on the target; other keys stay. mirrored swaps _l and _r bones and negates angles and offset x: a right-foot-forward frame becomes left-foot-forward. Source and target may be in one animation or two. Unmatched bones are listed in skipped.',
  input: z.strictObject({
    doc: DocRef,
    from: z.strictObject({ animation: AnimRef, frame: FrameRef }).describe('Source frame.'),
    to: z.strictObject({ animation: AnimRef, frame: FrameRef }).describe('Target frame.'),
    mirrored: z
      .boolean()
      .optional()
      .describe('Swap _l/_r bones, negate angles and x (default false).'),
  }),
  output: z.strictObject({
    from: z.string().describe('"group/direction #frame" of the source.'),
    to: z.string().describe('"group/direction #frame" of the target.'),
    pasted: z.array(z.string()).describe('Bone names that received a key.'),
    skipped: z.array(z.string()).describe('Source bone names that no target bone matched.'),
  }),
  examples: [
    {
      title: 'Frame 4 of the run is frame 0 with the legs swapped',
      input: {
        doc: 'doc_g1ed5q',
        from: { animation: { group: 'run', direction: 'side' }, frame: 0 },
        to: { animation: { group: 'run', direction: 'side' }, frame: 4 },
        mirrored: true,
      },
    },
  ],
  handler: (ctx, input) => {
    const rig = requireRig(ctx.doc);
    const src = resolveAuthoredAnimation(ctx.doc, input.from.animation);
    const dst = resolveAuthoredAnimation(ctx.doc, input.to.animation);
    const fromIndex = resolveFrame(src.animation, input.from.frame).index;
    const toIndex = resolveFrame(dst.animation, input.to.frame).index;
    const clip = copyPoseTx(ctx.tx, input.from.animation, fromIndex);
    const result = pastePoseTx(ctx.tx, input.to.animation, toIndex, clip, {
      mirrored: input.mirrored === true,
    });
    const nameOf = (id: string): string => rig.bones.find((b) => b.id === id)?.name ?? id;
    return {
      from: `${animationLabel(src.animation)} #${String(fromIndex)}`,
      to: `${animationLabel(dst.animation)} #${String(toIndex)}`,
      pasted: result.pasted.map(nameOf).sort(),
      skipped: [...result.skipped],
    };
  },
});
