/**
 * `rig.bindParts`: turn pixel layers into parts by name or by overlap with the bones.
 * @packageDocumentation
 */
import { bindParts } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef, LayerRef, ViewRef, requireRig, resolveLayer, resolveView } from '../refs.js';

/** `rig.bindParts` (MCP `rig_bind_parts`, CLI `pf rig bind-parts`). */
export const rigBindParts = defineOp({
  name: 'rig.bindParts',
  safety: 'mutate',
  summary:
    'Bind pixel layers to bones as parts, by layer name ("part:<bone>[.<part>][@variant][#view]") or by overlap.',
  description:
    "By name: a layer called part:upper_arm_r (or just a bone name) becomes that bone's part; @variant adds another variant of the same part, #view another view. By overlap: remaining layers bind to the bone their opaque pixels cover, only with a clear winner (ties are listed as ambiguous). Layers with several drawings (animated) or a translucent layer and cel are skipped. Running it again changes nothing. Cut flat art into layers first with part_split.",
  input: z.strictObject({
    doc: DocRef,
    layers: z
      .array(LayerRef)
      .optional()
      .describe('Only these layers (default: every pixel layer).'),
    byName: z.boolean().default(true).describe('Bind by layer name (default true).'),
    byOverlap: z
      .boolean()
      .default(true)
      .describe('Bind the rest by overlap with the bones (default true).'),
    rawNames: z
      .record(LayerRef, z.string().min(1))
      .optional()
      .describe(
        'Source names to parse instead of layer names, by layer: {"arm": "part:upper_arm_r@open#side"}.',
      ),
    view: ViewRef.optional().describe(
      'View for names without #view and for overlap (default: the first).',
    ),
    zByBone: z
      .record(z.string(), z.int())
      .optional()
      .describe('Default z of new parts by part-layer name, then bone name; higher draws on top.'),
  }),
  output: z.strictObject({
    bound: z
      .array(
        z.strictObject({
          layer: z.string().describe('Layer id.'),
          part: z.string().describe('Part id.'),
          variant: z.string().describe('Variant id.'),
          bone: z.string().describe('Bone id.'),
          view: z.string().describe('View id.'),
          how: z.enum(['name', 'overlap']),
          merged: z.boolean().describe('True when folded into an existing part as a variant.'),
        }),
      )
      .describe('Layers that became (part of) a part.'),
    ambiguous: z
      .array(
        z.strictObject({
          layer: z.string(),
          candidates: z.array(z.string()).describe('Bone ids.'),
        }),
      )
      .describe('Layers whose overlap has no clear winner (left alone).'),
    skipped: z
      .array(
        z.strictObject({
          layer: z.string(),
          reason: z.string().describe('Kebab-case reason, e.g. "animated".'),
        }),
      )
      .describe('Layers left alone, with the reason.'),
  }),
  examples: [
    {
      title: 'Bind every layer named after a bone, no overlap guessing',
      input: { doc: 'doc_g1ed5q', byOverlap: false },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    requireRig(doc);
    const layers = input.layers?.map((l) => resolveLayer(doc, l).layer.id);
    const rawNames =
      input.rawNames === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.rawNames).map(([ref, raw]) => [
              resolveLayer(doc, ref).layer.id,
              raw,
            ]),
          );
    const viewId = input.view === undefined ? undefined : resolveView(doc, input.view).id;
    const r = bindParts(ctx.tx, {
      byName: input.byName,
      byOverlap: input.byOverlap,
      ...(layers === undefined ? {} : { layers }),
      ...(rawNames === undefined ? {} : { rawNames }),
      ...(viewId === undefined ? {} : { viewId }),
      ...(input.zByBone === undefined ? {} : { zByBone: input.zByBone }),
    });
    return {
      bound: r.bound.map((b) => ({
        layer: b.layerId,
        part: b.partId,
        variant: b.variantId,
        bone: b.boneId,
        view: b.viewId,
        how: b.how,
        merged: b.merged,
      })),
      ambiguous: r.ambiguous.map((a) => ({ layer: a.layerId, candidates: [...a.candidates] })),
      skipped: r.skipped.map((s) => ({ layer: s.layerId, reason: s.reason })),
    };
  },
});
