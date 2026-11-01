/**
 * `part.paintOverlap`: paint the hidden overlap that closes joint gaps (FR-RIG-07, W2b).
 * @packageDocumentation
 */
import { paintOverlapTx } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { BoneRef, DocRef, ViewRef, partNamer, resolveBone, resolveView } from '../refs.js';

/** `part.paintOverlap` (MCP `part_paint_overlap`, CLI `pf part paint-overlap`). */
export const partPaintOverlap = defineOp({
  name: 'part.paintOverlap',
  safety: 'mutate',
  summary:
    'Close joint gaps by painting hidden overlap on the part drawn lower; the rest composite does not change.',
  description:
    'For each joint with gaps (rig_joint_check), paints only pixels the upper part covers at rest, growing the variant image and shifting its pivot to keep the part in place. The colour is the variant\'s most frequent opaque one unless you pass color ([r,g,b,a] in RGBA documents, a palette index in indexed ones). Existing pixels are kept. "uncovered" lists joints that no hidden paint can close (they need a visible art change); "skipped" joints with several parts per bone or a part drawn rotated at rest. Check with rig_joint_check afterwards.',
  input: z.strictObject({
    doc: DocRef,
    view: ViewRef.optional().describe('Rig view to check (default: the first view).'),
    bones: z
      .array(BoneRef)
      .optional()
      .describe('Only joints whose child bone is one of these (default: all joints with gaps).'),
    color: z
      .union([
        z.tuple([
          z.int().min(0).max(255),
          z.int().min(0).max(255),
          z.int().min(0).max(255),
          z.int().min(0).max(255),
        ]),
        z.int().min(0).max(255),
      ])
      .optional()
      .describe('Paint colour: [r,g,b,a], or a palette index in an indexed document.'),
  }),
  output: z.strictObject({
    painted: z
      .array(
        z.strictObject({
          part: z.string().describe('Part layer name.'),
          variant: z.string().describe('Variant id that received paint.'),
          bones: z.array(z.string()).describe('Child bones of the joints it serves.'),
          pixels: z.int().describe('Pixels painted.'),
          grew: z
            .strictObject({ left: z.int(), top: z.int(), right: z.int(), bottom: z.int() })
            .describe('Pixels the variant image grew on each side.'),
          pivot: z.strictObject({ x: z.int(), y: z.int() }).describe('Variant pivot afterwards.'),
        }),
      )
      .describe('Variants that were painted (empty when no joint has gaps).'),
    uncovered: z
      .array(z.strictObject({ bone: z.string(), pixels: z.int() }))
      .describe('Joints with gap pixels no hidden paint can close.'),
    skipped: z
      .array(
        z.strictObject({
          bone: z.string(),
          parent: z.string(),
          reason: z.enum(['ambiguous-parts', 'rotated-rest']),
        }),
      )
      .describe('Joints the helper cannot handle.'),
  }),
  examples: [
    {
      title: 'Close the elbow gap of the hero',
      input: { doc: 'doc_g1ed5q', bones: ['lower_arm_r'] },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const viewId = input.view === undefined ? undefined : resolveView(doc, input.view).id;
    const bones = input.bones?.map((b) => resolveBone(doc, b).id);
    const r = paintOverlapTx(ctx.tx, {
      ...(viewId === undefined ? {} : { viewId }),
      ...(bones === undefined ? {} : { bones }),
      ...(input.color === undefined
        ? {}
        : { color: typeof input.color === 'number' ? input.color : ([...input.color] as never) }),
    });
    const nameOf = partNamer(ctx.doc);
    return {
      painted: r.painted.map((p) => {
        const part = ctx.doc.rig?.parts.find((x) => x.id === p.partId);
        return {
          part: part === undefined ? p.partId : nameOf(part),
          variant: p.variantId,
          bones: [...p.bones],
          pixels: p.pixels,
          grew: { ...p.grew },
          pivot: { ...p.pivot },
        };
      }),
      uncovered: r.uncovered.map((u) => ({ ...u })),
      skipped: r.skipped.map((s) => ({ ...s })),
    };
  },
});
