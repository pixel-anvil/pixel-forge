/**
 * `rig.fitTemplate`: fit a humanoid template to landmark points (bone lengths and rest pose) in one call.
 * @packageDocumentation
 */
import { applySkeletonTemplate, setBoneLength } from '@pixel-forge/core';
import { fitHumanoid } from '@pixel-forge/rig';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { DocRef, ViewRef, resolveView } from '../refs.js';

const Point = z.strictObject({
  x: z.int(),
  y: z.int(),
});

const KINDS = {
  'humanoid-side': 'side',
  'humanoid-front': 'front',
  'humanoid-back': 'back',
} as const;

/** `rig.fitTemplate` (MCP `rig_fit_template`, CLI `pf rig fit-template`). */
export const rigFitTemplate = defineOp({
  name: 'rig.fitTemplate',
  safety: 'mutate',
  group: 'rig',
  summary: 'Fit a humanoid template to landmark points: lengths and rest pose in one call.',
  description:
    'Like rig_apply_template, but sizes the bones from landmarks (canvas px, arms hanging): headTop, hips, feet (between the soles; becomes the root), optional handL/handR fingertips. Existing bones are resized. Check with render_frame (bones), then touch up with rig_edit_bones.',
  mcp: { name: 'rig_fit_template' },
  input: z.strictObject({
    doc: DocRef,
    template: z
      .enum(['humanoid-side', 'humanoid-front', 'humanoid-back'])
      .describe('Skeleton template.'),
    landmarks: z
      .strictObject({
        headTop: Point.describe('Top pixel of the head.'),
        hips: Point.describe('Hip joint (thigh pivot); between headTop and feet.'),
        feet: Point.describe('Between the feet on the sole row: the root pivot.'),
        handL: Point.optional().describe('Fingertip of the left hand (+x in front view).'),
        handR: Point.optional().describe('Fingertip of the right hand; one hand serves both.'),
      })
      .describe('Landmarks in canvas px.'),
    view: ViewRef.optional().describe('Existing view to set the rest pose in (default: new).'),
    viewName: z.string().min(1).optional().describe('Name of the new view; ignored with view.'),
  }),
  output: z.strictObject({
    viewId: z.string().describe('Id of the view the fit was written to.'),
    height: z.int().describe('Character height, px.'),
    created: z.array(z.string()).describe('Names of the bones that were created.'),
    resized: z.array(z.string()).describe('Names of the existing bones whose length changed.'),
  }),
  examples: [
    {
      title: 'Fit the side template to a 47 px character',
      input: {
        doc: 'doc_g1ed5q',
        template: 'humanoid-side',
        view: 'side',
        landmarks: {
          headTop: { x: 31, y: 16 },
          hips: { x: 30, y: 44 },
          feet: { x: 30, y: 63 },
          handR: { x: 38, y: 47 },
        },
      },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const fitted = fitHumanoid(KINDS[input.template], {
      headTop: input.landmarks.headTop,
      hips: input.landmarks.hips,
      feet: input.landmarks.feet,
      ...(input.landmarks.handL === undefined ? {} : { handL: input.landmarks.handL }),
      ...(input.landmarks.handR === undefined ? {} : { handR: input.landmarks.handR }),
    });
    const before = new Map((doc.rig?.bones ?? []).map((b) => [b.name, b.length]));
    const applied = applySkeletonTemplate(ctx.tx, fitted.template, {
      ...(input.view === undefined ? {} : { viewId: resolveView(doc, input.view).id }),
      ...(input.viewName === undefined ? {} : { viewName: input.viewName }),
    });
    const resized: string[] = [];
    for (const tb of fitted.template.bones) {
      const old = before.get(tb.name);
      const id = applied.bones[tb.name];
      if (old !== undefined && id !== undefined && old !== tb.length) {
        setBoneLength(ctx.tx, id, tb.length);
        resized.push(tb.name);
      }
    }
    return {
      viewId: applied.viewId,
      height: fitted.height,
      created: [...applied.created],
      resized,
    };
  },
});
