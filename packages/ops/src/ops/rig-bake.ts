/**
 * `rig.bake`: turn a rig animation into plain pixels (FR-RIG-23).
 * @packageDocumentation
 */
import { bakeAnimation } from '@pixel-forge/core';
import { Name } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { AnimRef, DocRef, resolveAuthoredAnimation } from '../refs.js';

/** `rig.bake` (MCP `rig_bake`, CLI `pf rig bake`). */
export const rigBake = defineOp({
  name: 'rig.bake',
  safety: 'destructive',
  group: 'rig',
  summary: 'Bake a rig animation into one plain pixel layer: as a new animation, or in place.',
  description:
    'Renders every frame (parts, overrides, post-passes, exported layers) into a pixel layer "baked" and hides the parts. mode "new" adds animation <group>_baked; "replace" bakes in place. A mirror cannot be baked: bake its source. Baked pixels no longer follow the rig.',
  confirmText:
    'mode "replace" drops the animation\'s keys, overrides and post-passes and merges other exported layers (undo restores it); "new" only adds an animation and a layer.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    mode: z
      .enum(['new', 'replace'])
      .describe('"new" keeps the source; "replace" bakes it in place.'),
    name: Name.optional().describe(
      'mode "new": group of the baked animation (default <group>_baked).',
    ),
  }),
  output: z.strictObject({
    animation: z.string().describe('Id of the baked animation.'),
    layer: z.string().describe('Id of the new pixel layer holding the baked pixels.'),
    frames: z.array(z.string()).describe('Frame ids of the baked animation, in play order.'),
    dropped: z
      .strictObject({
        boneKeys: z.int().describe('Bone keys dropped (replace only).'),
        partKeys: z.int().describe('Part keys dropped (replace only).'),
        overrides: z.array(z.string()).describe('Override ids dropped (replace only).'),
        postPasses: z.boolean().describe('Whether post-passes were dropped.'),
        cels: z.int().describe('Cels of other exported pixel layers consumed at the baked frames.'),
      })
      .describe('What a "replace" bake removed (all zero for "new").'),
  }),
  examples: [
    {
      title: 'Bake the hero idle as a new animation',
      input: { doc: 'doc_g1ed5q', animation: { group: 'default' }, mode: 'new' },
    },
  ],
  handler: (ctx, input) => {
    resolveAuthoredAnimation(ctx.doc, input.animation);
    const r = bakeAnimation(ctx.tx, input.animation, {
      mode: input.mode,
      ...(input.name === undefined ? {} : { name: input.name }),
      rig: ctx.renderer,
    });
    return {
      animation: r.animationId,
      layer: r.layerId,
      frames: [...r.frames],
      dropped: {
        boneKeys: r.dropped.boneKeys,
        partKeys: r.dropped.partKeys,
        overrides: [...r.dropped.overrides],
        postPasses: r.dropped.postPasses,
        cels: r.dropped.cels,
      },
    };
  },
});
