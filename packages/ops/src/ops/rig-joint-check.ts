/**
 * `rig.jointCheck`: the joint-gap report of one rig view (read-only; MCP `rig_joint_check`).
 * @packageDocumentation
 */
import { jointCheck } from '@pixel-forge/rig';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { DocRef, ViewRef, requireRig, resolveView } from '../refs.js';

const Px = z.tuple([z.int(), z.int()]).describe('A pixel [x, y], canvas coordinates.');

const AngleGaps = z.strictObject({
  angle: z.number().describe('Swept angle, degrees clockwise.'),
  gaps: z.array(Px).describe('Gap pixels at this angle.'),
});

/** `rig.jointCheck` (MCP `rig_joint_check`, CLI `pf rig joint-check`). */
export const rigJointCheck = defineOp({
  name: 'rig.jointCheck',
  safety: 'read',
  group: 'rig',
  summary:
    'Sweep each joint of one rig view and report the pixel gaps that open on the outer side of a bend.',
  description:
    'A rig passes when summary.gapCount is 0. The full output is about 400 characters per joint: pass compact for a short form, or use lint with enable ["rig.jointGap"] for pass or fail. The sweep moves one joint at a time, rangeDeg around rest (default 30): a pose beyond that is not checked, so look at the render. Fix gaps with part_paint_overlap, or by moving part pivots, then check again. Checks the view that draws the first direction of the given view (default: the first view).',
  mcp: { name: 'rig_joint_check' },
  input: z.strictObject({
    doc: DocRef,
    view: ViewRef.optional().describe('Rig view to check (default: the first view).'),
    rangeDeg: z
      .number()
      .positive()
      .optional()
      .describe('Sweep range, degrees either side of rest.'),
    stepDeg: z.number().positive().optional().describe('Sweep step, degrees.'),
    radius: z.int().min(1).optional().describe('Window radius of the check, px.'),
    compact: z.boolean().optional().describe('Short form: summary and problems, no joints.'),
  }),
  output: z.strictObject({
    view: z.string().describe('Name of the checked view.'),
    params: z.strictObject({
      rangeDeg: z.number().describe('Sweep range, degrees either side of rest.'),
      stepDeg: z.number().describe('Sweep step, degrees.'),
      radius: z.int().describe('Window radius of the check, px.'),
    }),
    joints: z
      .array(
        z.strictObject({
          bone: z.string().describe('Child bone name.'),
          parent: z.string().describe('Parent bone name.'),
          pivot: Px.describe('Joint pivot, canvas coordinates.'),
          gapCount: z.int().describe('Gap pixels summed over the sweep.'),
          union: z.array(Px).describe('Distinct gap pixels over the sweep, sorted by y then x.'),
          angles: z.array(AngleGaps).describe('Every checked angle, ascending.'),
        }),
      )
      .optional()
      .describe('One entry per joint, sorted by bone name. Absent when compact.'),
    problems: z
      .array(
        z.strictObject({
          bone: z.string().describe('Child bone name.'),
          kind: z.literal('gap').describe('Kind of problem.'),
          gapCount: z.int().describe('Gap pixels summed over the sweep.'),
          unionCount: z.int().describe('Distinct gap pixels.'),
        }),
      )
      .optional()
      .describe('Joints with gaps. Only when compact.'),
    summary: z.strictObject({
      joints: z.int(),
      jointsWithGaps: z.int(),
      gapCount: z.int().describe('0 when the rig passes.'),
      unionCount: z.int(),
    }),
  }),
  examples: [
    {
      title: 'Check the first view of the hero',
      input: { doc: 'doc_g1ed5q' },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const rig = requireRig(doc);
    const view = input.view === undefined ? rig.views[0] : resolveView(doc, input.view);
    if (view === undefined) {
      throw new OpError('REFUSED', 'the rig has no view to check', { reason: 'no-view' });
    }
    const direction = view.directions[0];
    // Same input as the lint rule rig.jointGap: the active palette resolves indexed variants.
    const palette =
      doc.meta.colorMode === 'indexed'
        ? (doc.palettes.find((p) => p.id === doc.activePaletteId)?.colors ?? []).map(
            (c): [number, number, number, number] => [c[0], c[1], c[2], c[3]],
          )
        : undefined;
    const report = jointCheck({
      rig,
      images: ctx.view,
      canvas: doc.meta.canvas,
      ...(direction === undefined ? {} : { direction }),
      ...(palette === undefined ? {} : { palette }),
      ...(input.rangeDeg === undefined ? {} : { rangeDeg: input.rangeDeg }),
      ...(input.stepDeg === undefined ? {} : { stepDeg: input.stepDeg }),
      ...(input.radius === undefined ? {} : { radius: input.radius }),
    });
    // The report's pixels are readonly tuples; the output wants plain arrays (same values).
    const px = (p: readonly [number, number]): [number, number] => [p[0], p[1]];
    if (input.compact === true) {
      return {
        view: report.view,
        params: { ...report.params },
        summary: { ...report.summary },
        problems: report.joints
          .filter((j) => j.gapCount > 0)
          .map((j) => ({
            bone: j.bone,
            kind: 'gap' as const,
            gapCount: j.gapCount,
            unionCount: j.union.length,
          })),
      };
    }
    return {
      view: report.view,
      params: { ...report.params },
      joints: report.joints.map((j) => ({
        bone: j.bone,
        parent: j.parent,
        pivot: px(j.pivot),
        gapCount: j.gapCount,
        union: j.union.map(px),
        angles: j.angles.map((a) => ({ angle: a.angle, gaps: a.gaps.map(px) })),
      })),
      summary: { ...report.summary },
    };
  },
});
