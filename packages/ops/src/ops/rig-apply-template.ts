/**
 * `rig.applyTemplate`: add a humanoid skeleton template to the rig (new view, or an existing one).
 * @packageDocumentation
 */
import { applySkeletonTemplate } from '@pixel-forge/core';
import { humanoidBack, humanoidFront, humanoidSide } from '@pixel-forge/rig';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef, ViewRef, resolveView } from '../refs.js';

/** The humanoid templates by name. */
const TEMPLATES = {
  'humanoid-side': humanoidSide,
  'humanoid-front': humanoidFront,
  'humanoid-back': humanoidBack,
} as const;

/** `rig.applyTemplate` (MCP `rig_apply_template`, CLI `pf rig apply-template`). */
export const rigApplyTemplate = defineOp({
  name: 'rig.applyTemplate',
  safety: 'mutate',
  summary:
    'Apply a humanoid skeleton template: bones matched by name are reused, missing ones are created.',
  description:
    'Templates: humanoid-side (view "side"), humanoid-front ("front"), humanoid-back ("back"). Without view a new view is created (named after the template, or viewName); with view the rest pose is set there. The template origin is the document origin. Rest: pelvis -90 (up), limbs 180 relative to it (down). Proportions are generic: compare with render_frame (bones) and refit with rig_edit_bones before any part_split. Bones that exist with another parent are refused.',
  mcp: { name: 'rig_apply_template' },
  input: z.strictObject({
    doc: DocRef,
    template: z
      .enum(['humanoid-side', 'humanoid-front', 'humanoid-back'])
      .describe('Skeleton template: humanoid-side, humanoid-front or humanoid-back.'),
    height: z
      .int()
      .min(8)
      .max(1024)
      .optional()
      .describe('Character height in px, feet row to top of head (default 48).'),
    view: ViewRef.optional().describe(
      'Existing view to set the rest pose in (default: a new view).',
    ),
    viewName: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Name of the new view (default: the template name, e.g. "side"); ignored with view.',
      ),
  }),
  output: z.strictObject({
    viewId: z.string().describe('Id of the view the template was applied to.'),
    bones: z
      .record(z.string(), z.string())
      .describe('Bone id per template bone name (reused and created).'),
    created: z.array(z.string()).describe('Names of the bones that were created.'),
  }),
  examples: [
    {
      title: 'Set the rest pose of the hero in its existing side view',
      input: { doc: 'doc_g1ed5q', template: 'humanoid-side', view: 'side' },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const template = TEMPLATES[input.template]({
      origin: doc.meta.origin,
      ...(input.height === undefined ? {} : { height: input.height }),
    });
    const applied = applySkeletonTemplate(ctx.tx, template, {
      ...(input.view === undefined ? {} : { viewId: resolveView(doc, input.view).id }),
      ...(input.viewName === undefined ? {} : { viewName: input.viewName }),
    });
    return { viewId: applied.viewId, bones: { ...applied.bones }, created: [...applied.created] };
  },
});
