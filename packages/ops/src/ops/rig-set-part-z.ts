/**
 * `rig.setPartZ`: change a part's default z after creation.
 * @packageDocumentation
 */
import { setPartZ } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef, PartRef, ViewRef, resolvePart, resolveView } from '../refs.js';

/**
 * `rig.setPartZ` (MCP `rig_set_part_z`, CLI `pf rig set-part-z`).
 *
 * Writes the view's `defaultZ` for one part through core's `setPartZ`, so it is one undo step. It
 * touches no part image and no frame key, so `PART_RENDER_VERSION` (`@pixel-forge/rig`) stays as it is.
 * The render input key changes by itself, because it hashes the whole rig definition. A per-frame `z`
 * key still wins over the default, so the output counts those keys.
 */
export const rigSetPartZ = defineOp({
  name: 'rig.setPartZ',
  safety: 'mutate',
  summary: "Set a part's default z (draw order) after creation.",
  description:
    'Higher z draws on top (default 0). Replaces per-frame z keys of rig_set_pose. A frame z key still wins: keyedFrames counts them. rig_joint_check and part_paint_overlap use the new order.',
  input: z.strictObject({
    doc: DocRef,
    part: PartRef,
    z: z.int().describe('New default z.'),
    view: ViewRef.optional().describe('View (default: the first).'),
  }),
  output: z.strictObject({
    part: z.string().describe('Part layer name.'),
    view: z.string().describe('View id.'),
    z: z.int().describe('Default z afterwards.'),
    previous: z.int().describe('Default z before.'),
    keyedFrames: z.int().describe('Frames with their own z key for this part.'),
  }),
  examples: [
    {
      title: 'Draw the right forearm above the torso',
      input: { doc: 'doc_g1ed5q', part: 'lower_arm_r', z: 5 },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const { part, name } = resolvePart(doc, input.part);
    const viewRef = input.view ?? doc.rig?.views[0]?.id;
    const view = resolveView(doc, viewRef ?? '');
    const previous = (view.defaultZ as Readonly<Record<string, number | undefined>>)[part.id] ?? 0;
    setPartZ(ctx.tx, view.id, part.id, input.z);
    let keyedFrames = 0;
    for (const a of doc.animations) {
      if ('mirrorOf' in a) continue;
      for (const f of a.frames) if (f.partKeys[part.id]?.z !== undefined) keyedFrames++;
    }
    return { part: name, view: view.id, z: input.z, previous, keyedFrames };
  },
});
