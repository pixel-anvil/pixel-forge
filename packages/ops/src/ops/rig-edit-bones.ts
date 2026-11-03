/**
 * `rig.editBones`: add, delete, reparent, rename and resize bones, set rest poses, edit views.
 * @packageDocumentation
 */
import {
  addBone,
  addView,
  deleteBone,
  deleteView,
  renameBone,
  renameView,
  reparentBone,
  setBoneLength,
  setRestPose,
} from '@pixel-forge/core';
import type { BoneId, ViewId } from '@pixel-forge/schema';
import { DirectionName, Name } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { BoneRef, DocRef, ViewRef, resolveBone, resolveView } from '../refs.js';

const Rest = z.strictObject({
  view: ViewRef.describe('View of the rest pose.'),
  x: z.int().describe('Root: canvas pivot x. Child: canvas offset x from the parent pivot, px.'),
  y: z.int().describe('Root: canvas pivot y. Child: canvas offset y from the parent pivot, px.'),
  angle: z
    .number()
    .describe(
      "Added to the parent's world angle, deg clockwise; world 0 = +x, 90 = down, -90 = up.",
    ),
});

/** One edit of {@link rigEditBones}. */
export const BoneEdit = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('addBone'),
    name: Name.describe('New bone name.'),
    parent: BoneRef.optional().describe('Parent bone (omit for a root).'),
    length: z.int().min(0).describe('Length, int px (pivot to tip).'),
    rest: Rest.optional().describe(
      'Rest pose in one view (without it the bone is unused in every view).',
    ),
  }),
  z.strictObject({
    action: z.literal('deleteBone'),
    bone: BoneRef,
    cascade: z
      .boolean()
      .default(false)
      .describe('Also delete all descendants (default: refused when it has children).'),
  }),
  z.strictObject({
    action: z.literal('reparent'),
    bone: BoneRef,
    parent: BoneRef.nullable().describe(
      'New parent, or null to make it a root. The art stays put.',
    ),
  }),
  z.strictObject({ action: z.literal('rename'), bone: BoneRef, name: Name.describe('New name.') }),
  z.strictObject({
    action: z.literal('setLength'),
    bone: BoneRef,
    length: z.int().min(0).describe('Length, int px.'),
  }),
  z.strictObject({
    action: z.literal('setRest'),
    bone: BoneRef,
    view: ViewRef,
    x: Rest.shape.x,
    y: Rest.shape.y,
    angle: Rest.shape.angle,
  }),
  z.strictObject({
    action: z.literal('addView'),
    name: Name.describe('New view name.'),
    directions: z
      .array(DirectionName)
      .min(1)
      .describe('Directions it draws (each in one view only).'),
  }),
  z.strictObject({
    action: z.literal('renameView'),
    view: ViewRef,
    name: Name.describe('New name.'),
  }),
  z.strictObject({ action: z.literal('deleteView'), view: ViewRef }),
]);

/** `rig.editBones` (MCP `rig_edit_bones`, CLI `pf rig edit-bones`). */
export const rigEditBones = defineOp({
  name: 'rig.editBones',
  safety: 'mutate',
  group: 'rig',
  summary:
    'Edit the skeleton: add/delete/reparent/rename bones, set length and rest pose per view, add/rename/delete views.',
  description:
    "Edits run in order; one failure undoes all. A bone with parts or (without cascade) children cannot be deleted. Rest x/y: root = canvas pivot, child = canvas offset from the parent pivot. Rest angle adds to the parent's: world 0 = +x, 90 = down, so a thigh pointing down under a pelvis at -90 is 180. Returns no geometry: check with render_frame (bones).",
  input: z.strictObject({
    doc: DocRef,
    edits: z.array(BoneEdit).min(1).max(100).describe('Edits, applied in order.'),
  }),
  output: z.strictObject({
    results: z
      .array(
        z.strictObject({
          action: z.string().describe("The edit's action."),
          id: z.string().optional().describe('Id of the bone or view the edit created.'),
        }),
      )
      .describe('One entry per edit, in order.'),
    bones: z.int().describe('Bone count afterwards.'),
  }),
  examples: [
    {
      title: 'Fit a thigh: 2 px left of the pelvis pivot, pointing down',
      input: {
        doc: 'doc_g1ed5q',
        edits: [
          { action: 'setRest', bone: 'thigh_l', view: 'side', x: -2, y: 0, angle: 180 },
          { action: 'setLength', bone: 'thigh_l', length: 8 },
        ],
      },
    },
    {
      title: 'Add a tail bone under the torso, then lengthen the head',
      input: {
        doc: 'doc_g1ed5q',
        edits: [
          { action: 'addBone', name: 'tail', parent: 'torso', length: 8 },
          { action: 'setLength', bone: 'head', length: 9 },
        ],
      },
    },
  ],
  handler: (ctx, input) => {
    const { tx } = ctx;
    const bone = (ref: string): BoneId => resolveBone(ctx.doc, ref).id;
    const view = (ref: string): ViewId => resolveView(ctx.doc, ref).id;
    const results: { action: string; id?: string }[] = [];
    for (const e of input.edits) {
      switch (e.action) {
        case 'addBone': {
          const parentId = e.parent === undefined ? undefined : bone(e.parent);
          const rest =
            e.rest === undefined
              ? undefined
              : { viewId: view(e.rest.view), x: e.rest.x, y: e.rest.y, angle: e.rest.angle };
          const id = addBone(
            tx,
            { name: e.name, length: e.length, ...(parentId === undefined ? {} : { parentId }) },
            rest,
          );
          results.push({ action: e.action, id });
          break;
        }
        case 'deleteBone':
          deleteBone(tx, bone(e.bone), { cascade: e.cascade });
          results.push({ action: e.action });
          break;
        case 'reparent':
          reparentBone(tx, bone(e.bone), e.parent === null ? undefined : bone(e.parent));
          results.push({ action: e.action });
          break;
        case 'rename':
          renameBone(tx, bone(e.bone), e.name);
          results.push({ action: e.action });
          break;
        case 'setLength':
          setBoneLength(tx, bone(e.bone), e.length);
          results.push({ action: e.action });
          break;
        case 'setRest':
          setRestPose(tx, view(e.view), bone(e.bone), { x: e.x, y: e.y, angle: e.angle });
          results.push({ action: e.action });
          break;
        case 'addView':
          results.push({ action: e.action, id: addView(tx, e.name, e.directions) });
          break;
        case 'renameView':
          renameView(tx, view(e.view), e.name);
          results.push({ action: e.action });
          break;
        case 'deleteView':
          deleteView(tx, view(e.view));
          results.push({ action: e.action });
          break;
      }
    }
    return { results, bones: ctx.doc.rig?.bones.length ?? 0 };
  },
});
