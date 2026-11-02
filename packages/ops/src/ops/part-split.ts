/**
 * `part.split`: move a region of a flat layer's cel into a new layer and bind it to a bone.
 * @packageDocumentation
 */
import { splitRegion } from '@pixel-forge/core';
import type { SplitSelection } from '@pixel-forge/core';
import { z } from 'zod';
import { defineOp } from '../define.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  LayerRef,
  ViewRef,
  resolveAuthoredAnimation,
  resolveFrame,
  resolveLayer,
  resolveView,
} from '../refs.js';

const Rgba = z.tuple([
  z.int().min(0).max(255),
  z.int().min(0).max(255),
  z.int().min(0).max(255),
  z.int().min(0).max(255),
]);

/** What to split off, in canvas pixels. */
export const SplitSelectionInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rect'),
    x: z.int().describe('Left pixel.'),
    y: z.int().describe('Top pixel.'),
    w: z.int().min(1).describe('Width, px.'),
    h: z.int().min(1).describe('Height, px.'),
  }),
  z.strictObject({
    kind: z.literal('lasso'),
    points: z
      .array(z.tuple([z.int(), z.int()]))
      .min(3)
      .describe('Closed polygon through canvas pixels [[x, y], ...] (the last joins the first).'),
  }),
  z.strictObject({
    kind: z.literal('flood'),
    x: z.int().describe('Seed pixel x.'),
    y: z.int().describe('Seed pixel y.'),
    boundary: z
      .array(z.union([Rgba, z.int().min(0).max(255)]))
      .optional()
      .describe(
        'Colours ([r,g,b,a], or palette indices) that stop the flood; default: only the seed colour.',
      ),
    connectivity: z
      .union([z.literal(4), z.literal(8)])
      .default(4)
      .describe('4 (default) or 8 neighbours.'),
    includeBoundary: z
      .boolean()
      .default(false)
      .describe('Also take the boundary-coloured pixels touching the region (an outline).'),
  }),
]);

/** `part.split` (MCP `part_split`, CLI `pf part split`). */
export const partSplit = defineOp({
  name: 'part.split',
  safety: 'mutate',
  summary:
    "Split a region (rect, lasso or flood) of a flat layer's cel into a new layer bound to a bone.",
  description:
    'Fit the bones first: the part keeps the bone pivot of this moment. partName ("part:upper_arm_r") binds it, else overlap, else it stays a pixel layer. The part draws in every frame of every animation: key visible false (rig_set_pose) where other art shows. Refused: rig-block-order (a pixel layer covers the part), duplicate-variant (a second cut into one part: undo, recut it whole).',
  input: z.strictObject({
    doc: DocRef,
    layer: LayerRef.describe('The flat pixel layer to cut from (id or name).'),
    animation: AnimRef,
    frame: FrameRef.describe('The frame whose cel is cut.'),
    selection: SplitSelectionInput.describe('The region to cut.'),
    partName: z
      .string()
      .min(1)
      .optional()
      .describe('Bind as "part:<bone>[.<part>][@variant][#view]" or a bone name.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Name of the new layer while it is not a part (default "split").'),
    bind: z
      .boolean()
      .default(true)
      .describe('Without partName: try to bind by overlap (default true).'),
    view: ViewRef.optional().describe(
      'View for names without #view and for overlap (default: the first).',
    ),
    zByBone: z
      .record(z.string(), z.int())
      .optional()
      .describe(
        'Default z of the new part by part-layer name, then bone name; higher draws on top. Set once, at creation: plan the draw order before the first split.',
      ),
  }),
  output: z.strictObject({
    layer: z.string().describe('Layer holding the moved pixels (the part layer once bound).'),
    image: z.string().describe('Image id of the moved pixels.'),
    bounds: z
      .strictObject({ x: z.int(), y: z.int(), w: z.int(), h: z.int() })
      .describe('Canvas rectangle of the moved pixels.'),
    pixels: z.int().describe('Pixels moved.'),
    bound: z
      .strictObject({
        part: z.string().describe('Part id.'),
        variant: z.string().describe('Variant id.'),
        bone: z.string().describe('Bone name.'),
        view: z.string().describe('View name.'),
        how: z.enum(['name', 'overlap']),
        merged: z.boolean().describe('True when folded into an existing part as a variant.'),
      })
      .optional()
      .describe('Present when the layer became (part of) a part.'),
    ambiguous: z
      .array(z.string())
      .optional()
      .describe('Bones tied for the overlap (nothing bound).'),
    skipped: z.string().optional().describe('Why automatic binding was skipped (kebab-case).'),
    unlinked: z.int().describe('Other frames whose linked cel now owns the original drawing.'),
  }),
  examples: [
    {
      title: 'Cut the head rectangle of a flat run frame into the head part',
      input: {
        doc: 'doc_g1ed5q',
        layer: 'body',
        animation: { group: 'run' },
        frame: 0,
        selection: { kind: 'rect', x: 24, y: 16, w: 18, h: 12 },
        partName: 'part:head',
      },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const layer = resolveLayer(doc, input.layer).layer;
    const { animation } = resolveAuthoredAnimation(doc, input.animation);
    const frame = resolveFrame(animation, input.frame).frame;
    const viewId = input.view === undefined ? undefined : resolveView(doc, input.view).id;
    const selection: SplitSelection =
      input.selection.kind === 'flood'
        ? {
            kind: 'flood',
            x: input.selection.x,
            y: input.selection.y,
            connectivity: input.selection.connectivity,
            includeBoundary: input.selection.includeBoundary,
            ...(input.selection.boundary === undefined
              ? {}
              : {
                  boundary: input.selection.boundary.map((b) =>
                    typeof b === 'number' ? b : ([b[0], b[1], b[2], b[3]] as const),
                  ),
                }),
          }
        : input.selection.kind === 'lasso'
          ? { kind: 'lasso', points: input.selection.points.map((p) => [p[0], p[1]] as const) }
          : { ...input.selection };
    const r = splitRegion(ctx.tx, layer.id, frame.id, selection, {
      ...(input.partName === undefined ? {} : { partName: input.partName }),
      ...(input.name === undefined ? {} : { name: input.name }),
      bind: input.bind,
      ...(viewId === undefined ? {} : { viewId }),
      ...(input.zByBone === undefined ? {} : { zByBone: input.zByBone }),
    });
    const rig = ctx.doc.rig;
    const bone = (id: string): string => rig?.bones.find((b) => b.id === id)?.name ?? id;
    const view = (id: string): string => rig?.views.find((v) => v.id === id)?.name ?? id;
    return {
      layer: r.layerId,
      image: r.imageId,
      bounds: { x: r.bounds.x, y: r.bounds.y, w: r.bounds.w, h: r.bounds.h },
      pixels: r.pixels,
      ...(r.bound === undefined
        ? {}
        : {
            bound: {
              part: r.bound.partId,
              variant: r.bound.variantId,
              bone: bone(r.bound.boneId),
              view: view(r.bound.viewId),
              how: r.bound.how,
              merged: r.bound.merged,
            },
          }),
      ...(r.ambiguous === undefined ? {} : { ambiguous: r.ambiguous.map(bone) }),
      ...(r.skipped === undefined ? {} : { skipped: r.skipped }),
      unlinked: r.unlinked.length,
    };
  },
});
