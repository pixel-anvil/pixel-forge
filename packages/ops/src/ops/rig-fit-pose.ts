/**
 * `rig.fitPose`: search bone angles, and part variants, so that one frame renders like a target image
 * (B0.1). The search is `fitPose` of `@pixel-forge/rig`; this op supplies the renderer and the target.
 * @packageDocumentation
 */
import { renderFrame } from '@pixel-forge/core';
import type { DocumentView } from '@pixel-forge/core';
import { decodePng } from '@pixel-forge/png';
import { FIT_POSE_MAX_RENDERS, boneOrder, fitPose, resolvePose } from '@pixel-forge/rig';
import type { FitBone, FitImage, FitVariantSlot } from '@pixel-forge/rig';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import { readBytes } from '../file-io.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  partResolver,
  requireRig,
  resolveAuthoredAnimation,
  resolveBone,
  resolveFrame,
  viewForAnimation,
} from '../refs.js';

/** Most renders a call may ask for (a render of a large frame takes milliseconds). */
const MAX_RENDERS_LIMIT = 20_000;

/** `rig.fitPose` (MCP `rig_fit_pose`, CLI `pf rig fit-pose`). */
export const rigFitPose = defineOp({
  name: 'rig.fitPose',
  safety: 'io',
  summary:
    'Find the bone angles (deg, relative to rest) and part variants whose render of one frame matches a target image.',
  description:
    'Target: file (PNG, canvas size) or targetFrame. Searches each bone angle within ±range and each listed part variant. Pass the output bones and parts to rig_set_pose to apply them. exact: no pixel differs; else error counts them. Seeded: the same input gives the same result. A miss is not proof that no pose fits: raise maxRenders or narrow range.',
  mcp: { name: 'rig_fit_pose' },
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef.describe('The frame to pose; its other keys stay as they are.'),
    file: z.string().min(1).optional().describe('Target PNG, the size of the canvas.'),
    targetFrame: FrameRef.optional().describe('Target: another frame of this animation, rendered.'),
    bones: z
      .array(z.string().min(1))
      .optional()
      .describe('Bones whose angle to search (names or ids; default: every bone).'),
    parts: z
      .array(z.string().min(1))
      .optional()
      .describe('Parts whose variant to search (default: none).'),
    range: z
      .number()
      .gt(0)
      .max(180)
      .optional()
      .describe('Search each angle within ±range deg of rest (default 180).'),
    seed: z.int().optional().describe('Seed of the random restarts (default 1).'),
    maxRenders: z
      .int()
      .min(1)
      .max(MAX_RENDERS_LIMIT)
      .optional()
      .describe(`Most renders (default ${String(FIT_POSE_MAX_RENDERS)}).`),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the animation.'),
    frameIndex: z.int().describe('The frame that was fitted.'),
    exact: z.boolean().describe('True when the render equals the target (error 0).'),
    error: z.int().describe('Pixels that differ from the target at the best pose.'),
    renders: z.int().describe('Renders used.'),
    bones: z
      .record(z.string(), z.strictObject({ angle: z.number() }))
      .describe('Best angle by bone name: the bones input of rig_set_pose.'),
    parts: z
      .record(z.string(), z.strictObject({ variant: z.string() }))
      .describe('Best variant by part name: the parts input of rig_set_pose.'),
  }),
  examples: [
    {
      title: 'Pose the right arm like a reference image',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        file: '/work/reference.png',
        bones: ['upper_arm_r', 'lower_arm_r'],
        parts: ['lower_arm_r'],
      },
    },
  ],
  handler: async (ctx, input) => {
    const doc = ctx.doc;
    const rig = requireRig(doc);
    const { index: animIndex, animation } = resolveAuthoredAnimation(doc, input.animation);
    const { index: frameIndex, frame } = resolveFrame(animation, input.frame);
    const { w, h } = doc.meta.canvas;

    // The target image.
    if ((input.file === undefined) === (input.targetFrame === undefined)) {
      throw new OpError('BAD_INPUT', 'give either file or targetFrame', {
        issues: [{ path: 'file', message: 'exactly one of file and targetFrame' }],
      });
    }
    let target: FitImage;
    if (input.file !== undefined) {
      const path = ctx.host.resolvePath(input.file);
      const png = decodePng(await readBytes(ctx, path));
      if (png.width !== w || png.height !== h) {
        throw new OpError(
          'REFUSED',
          `${path} is ${String(png.width)}x${String(png.height)} px, the canvas is ${String(w)}x${String(h)}; the target must have the canvas size`,
          { reason: 'bad-size', canvas: { w, h }, image: { w: png.width, h: png.height } },
        );
      }
      target = png;
    } else {
      const { index } = resolveFrame(animation, input.targetFrame ?? 0);
      target = ctx.renderFrame({ id: animation.id }, index, { exportOnly: true }).toRGBA();
    }

    // The unknowns, parents first.
    const view = viewForAnimation(doc, animation);
    const range = input.range ?? 180;
    const wanted =
      input.bones === undefined
        ? undefined
        : new Set(input.bones.map((b) => resolveBone(doc, b).id));
    const resolved = resolvePose(rig, animation, frameIndex);
    const boneSpecs: (FitBone & { readonly id: string })[] = [];
    for (const id of boneOrder(rig)) {
      if (wanted !== undefined && !wanted.has(id)) continue;
      const bone = rig.bones.find((b) => b.id === id);
      if (bone === undefined || view.rest[id] === undefined) continue;
      boneSpecs.push({
        id,
        bone: bone.name,
        min: -range,
        max: range,
        start: resolved.get(id)?.angle ?? 0,
      });
    }
    const resolvePart = partResolver(doc);
    const partSpecs: (FitVariantSlot & { readonly id: string; readonly names: string[] })[] = [];
    for (const ref of input.parts ?? []) {
      const { part, name } = resolvePart(ref);
      const own = part.variants.filter((v) => v.viewId === view.id);
      if (own.length < 2) {
        throw new OpError(
          'REFUSED',
          `part ${name} has ${String(own.length)} variant${own.length === 1 ? '' : 's'} in view ${view.name}; there is nothing to choose`,
          { reason: 'no-variants', part: name },
        );
      }
      if (partSpecs.some((p) => p.id === part.id)) continue;
      partSpecs.push({
        id: part.id,
        part: name,
        choices: own.map((v) => v.id),
        names: own.map((v) => v.name),
      });
    }
    if (boneSpecs.length + partSpecs.length === 0) {
      throw new OpError('REFUSED', 'nothing to search: no bone is drawn in this view', {
        reason: 'nothing-to-search',
      });
    }

    // The renderer: the document with the candidate keys on the fitted frame, nothing written.
    const base: DocumentView = ctx.view;
    const render = (pose: {
      angles: Readonly<Record<string, number>>;
      variants: Readonly<Record<string, string>>;
    }): FitImage => {
      const boneKeys = { ...frame.boneKeys };
      for (const b of boneSpecs) {
        const angle = pose.angles[b.bone];
        if (angle !== undefined)
          boneKeys[b.id as keyof typeof boneKeys] = {
            ...boneKeys[b.id as keyof typeof boneKeys],
            angle,
          };
      }
      const partKeys = { ...frame.partKeys };
      for (const p of partSpecs) {
        const variant = pose.variants[p.part];
        if (variant !== undefined)
          partKeys[p.id as keyof typeof partKeys] = {
            ...partKeys[p.id as keyof typeof partKeys],
            variant: variant as never,
          };
      }
      const nextAnimation = {
        ...animation,
        frames: animation.frames.map((f, i) =>
          i === frameIndex ? { ...f, boneKeys, partKeys } : f,
        ),
      };
      const next: DocumentView = {
        doc: {
          ...base.doc,
          animations: base.doc.animations.map((a, i) => (i === animIndex ? nextAnimation : a)),
        },
        image: (id) => base.image(id),
        imageIds: () => base.imageIds(),
      };
      return renderFrame(next, { id: animation.id }, frameIndex, {
        rig: ctx.renderer,
        exportOnly: true,
      }).toRGBA();
    };

    const result = fitPose({
      target,
      render,
      bones: boneSpecs,
      variants: partSpecs,
      seed: input.seed ?? 1,
      quantum: animation.angleQuantum ?? 1,
      ...(input.maxRenders === undefined ? {} : { maxRenders: input.maxRenders }),
    });

    return {
      animation: animationLabel(animation),
      frameIndex,
      exact: result.exact,
      error: result.error,
      renders: result.renders,
      bones: Object.fromEntries(
        boneSpecs.map((b) => [b.bone, { angle: result.angles[b.bone] ?? 0 }]),
      ),
      parts: Object.fromEntries(
        partSpecs.map((p) => {
          const choice = result.variants[p.part];
          const i = choice === undefined ? -1 : p.choices.indexOf(choice);
          return [p.part, { variant: p.names[i] ?? p.names[0] ?? '' }];
        }),
      ),
    };
  },
});
