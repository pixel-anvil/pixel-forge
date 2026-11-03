/**
 * `rig.setPivot`: move a variant's pivot pixel.
 * @packageDocumentation
 */
import { setPivot } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import {
  DocRef,
  PartRef,
  VariantRef,
  ViewRef,
  resolvePart,
  resolveVariant,
  resolveView,
} from '../refs.js';

/** `rig.setPivot` (MCP `rig_set_pivot`, CLI `pf rig set-pivot`). */
export const rigSetPivot = defineOp({
  name: 'rig.setPivot',
  safety: 'mutate',
  group: 'rig',
  summary:
    "Set a part variant's pivot: the pixel (int px, in the variant image) that sits on the bone pivot.",
  description:
    "Binding already puts the pivot on the bone: use this to shift a part against its bone. Coordinates are in the variant image, origin top-left, pixel centre; the pivot may lie outside the image (a floating hand). It moves the part's art relative to the bone, so do not nudge it to clear joint gaps: use part_paint_overlap. Run rig_joint_check next. Variant names repeat across views: pass view when the name is ambiguous.",
  input: z.strictObject({
    doc: DocRef,
    part: PartRef,
    variant: VariantRef.default('default').describe('Variant name or id (default "default").'),
    view: ViewRef.optional().describe("Resolve the variant name among this view's variants."),
    pivot: z
      .strictObject({ x: z.int(), y: z.int() })
      .describe('New pivot, int px in the variant image.'),
  }),
  output: z.strictObject({
    part: z.string().describe('Part layer name.'),
    variant: z.string().describe('Variant id.'),
    pivot: z.strictObject({ x: z.int(), y: z.int() }).describe('Pivot afterwards.'),
    previous: z.strictObject({ x: z.int(), y: z.int() }).describe('Pivot before.'),
  }),
  examples: [
    {
      title: 'Move the forearm pivot two pixels right',
      input: { doc: 'doc_g1ed5q', part: 'lower_arm_r', pivot: { x: 3, y: 1 } },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const { part, name } = resolvePart(doc, input.part);
    const viewId = input.view === undefined ? undefined : resolveView(doc, input.view).id;
    const variant = resolveVariant(part, input.variant, viewId);
    const previous = { x: variant.pivot.x, y: variant.pivot.y };
    setPivot(ctx.tx, part.id, variant.id, input.pivot);
    return { part: name, variant: variant.id, pivot: { ...input.pivot }, previous };
  },
});
