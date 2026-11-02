/**
 * `rig.setPose`: set bone keys and part keys on one frame (spec 6.3's worked example).
 * @packageDocumentation
 */
import { jsonEqual } from '@pixel-forge/core';
import { AUTO_VARIANT, Interpolation } from '@pixel-forge/schema';
import type { BoneKey, PartKey, VariantChoice } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  resolveAuthoredAnimation,
  resolveBone,
  partResolver,
  resolveFrame,
  resolveVariant,
  viewForAnimation,
} from '../refs.js';

/** A bone key to merge into the frame's key: the channels given replace the stored ones. */
export const BoneKeyInput = z
  .strictObject({
    angle: z
      .number()
      .optional()
      .describe('Rotation from the rest angle, degrees clockwise (child bones follow, FK).'),
    offset: z
      .strictObject({ x: z.int(), y: z.int() })
      .optional()
      .describe('Pivot translation from its rest position, integer px.'),
    flipX: z.boolean().optional().describe('Mirror the bone horizontally about its pivot.'),
    interp: Interpolation.optional().describe(
      'Interpolation from this key to the next: "linear" (default), "step", "ease-in-out".',
    ),
  })
  .refine(
    (k) =>
      k.angle !== undefined ||
      k.offset !== undefined ||
      k.flipX !== undefined ||
      k.interp !== undefined,
    'set at least one of angle, offset, flipX, interp (or null to remove the key)',
  );

/** A part key to merge into the frame's key. */
export const PartKeyInput = z
  .strictObject({
    variant: z
      .string()
      .min(1)
      .optional()
      .describe('Variant name or id, or "auto" (FR-RIG-14); holds until the next key.'),
    z: z
      .int()
      .optional()
      .describe(
        "Draw order in this animation; holds until the next key; higher draws on top (default: the view's).",
      ),
    visible: z.boolean().optional().describe('Show or hide the part from this frame on.'),
  })
  .refine(
    (k) => k.variant !== undefined || k.z !== undefined || k.visible !== undefined,
    'set at least one of variant, z, visible (or null to remove the key)',
  );

const keyName = (kind: 'bones' | 'parts', name: string): string => `${kind}.${name}`;

/** Merges the given channels into `stored`, in a fixed key order. */
function mergeBoneKey(
  stored: Readonly<BoneKey> | undefined,
  given: z.output<typeof BoneKeyInput>,
): BoneKey {
  const angle = given.angle ?? stored?.angle;
  const offset = given.offset ?? stored?.offset;
  const flipX = given.flipX ?? stored?.flipX;
  const interp = given.interp ?? stored?.interp;
  return {
    ...(angle === undefined ? {} : { angle }),
    ...(offset === undefined ? {} : { offset: { x: offset.x, y: offset.y } }),
    ...(flipX === undefined ? {} : { flipX }),
    ...(interp === undefined ? {} : { interp }),
  };
}

function mergePartKey(
  stored: Readonly<PartKey> | undefined,
  variant: VariantChoice | undefined,
  given: z.output<typeof PartKeyInput>,
): PartKey {
  const v = variant ?? stored?.variant;
  const zz = given.z ?? stored?.z;
  const visible = given.visible ?? stored?.visible;
  return {
    ...(v === undefined ? {} : { variant: v }),
    ...(zz === undefined ? {} : { z: zz }),
    ...(visible === undefined ? {} : { visible }),
  };
}

/** `rig.setPose` (MCP `rig_set_pose`, CLI `pf rig set-pose`). */
export const rigSetPose = defineOp({
  name: 'rig.setPose',
  safety: 'mutate',
  summary:
    'Set bone keys (angle deg clockwise, offset int px) and/or part keys (variant, z, visible) on one frame.',
  description:
    'Channels you pass replace the stored ones; null removes the whole key of that bone or part. Angles are from rest and compose down the hierarchy. A channel with no key here interpolates between its keys on other frames (wrapping in a loop), not back to rest: key offsets on every frame or on none. Part keys hold both ways: set z or visible once per animation. Art past the canvas edge is cut off. Next: render_contact_sheet.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
    bones: z
      .record(z.string().min(1), BoneKeyInput.nullable())
      .optional()
      .describe('Bone keys by bone name (or id); null removes the key.'),
    parts: z
      .record(z.string().min(1), PartKeyInput.nullable())
      .optional()
      .describe('Part keys by part-layer name (or part id); null removes the key.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the posed animation.'),
    frameIndex: z.int(),
    frameId: z.string(),
    changed: z
      .array(z.string())
      .describe('Keys that changed, as "bones.<name>" / "parts.<name>"; empty when nothing did.'),
  }),
  examples: [
    {
      title: 'Raise the right arm on frame 0',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'default' },
        frame: 0,
        bones: { upper_arm_r: { angle: -45 }, lower_arm_r: { angle: -30 } },
      },
      output: {
        animation: 'default',
        frameIndex: 0,
        frameId: 'frm_j83g8j',
        changed: ['bones.lower_arm_r', 'bones.upper_arm_r'],
      },
    },
    {
      title: 'Switch the forearm to its sleeve variant and drop the torso key',
      input: {
        doc: 'doc_g1ed5q',
        animation: { group: 'run', direction: 'side' },
        frame: 2,
        bones: { torso: null },
        parts: { lower_arm_r: { variant: 'sleeve' } },
      },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const { index: animIndex, animation } = resolveAuthoredAnimation(doc, input.animation);
    const { index: frameIndex, frame } = resolveFrame(animation, input.frame);
    const bones = Object.entries(input.bones ?? {});
    const parts = Object.entries(input.parts ?? {});
    if (bones.length === 0 && parts.length === 0) {
      throw new OpError('BAD_INPUT', 'rig.setPose needs "bones" or "parts"', {
        issues: [{ path: '', message: 'give at least one bone or part key' }],
      });
    }

    // Resolve every reference before touching the document.
    const seen = new Set<string>();
    const unique = (id: string, path: string): void => {
      if (seen.has(id)) {
        throw new OpError('BAD_INPUT', `${path} names an entity that is already keyed`, {
          issues: [{ path, message: 'the same bone or part appears twice (by name and id)' }],
        });
      }
      seen.add(id);
    };
    const boneEdits = bones.map(([ref, key]) => {
      const bone = resolveBone(doc, ref);
      unique(bone.id, keyName('bones', ref));
      const stored = frame.boneKeys[bone.id];
      const next = key === null ? undefined : mergeBoneKey(stored, key);
      if (
        next !== undefined &&
        next.angle === undefined &&
        next.offset === undefined &&
        next.flipX === undefined
      ) {
        throw new OpError(
          'REFUSED',
          `bone ${bone.name} has no stored key to attach "interp" to; give angle, offset or flipX`,
          { reason: 'empty-key', bone: bone.name },
        );
      }
      return { id: bone.id, name: bone.name, stored, next };
    });
    const viewId = parts.length === 0 ? undefined : viewForAnimation(doc, animation).id;
    const resolvePart = partResolver(doc);
    const partEdits = parts.map(([ref, key]) => {
      const { part, name } = resolvePart(ref);
      unique(part.id, keyName('parts', ref));
      const stored = frame.partKeys[part.id];
      let next: PartKey | undefined;
      if (key !== null) {
        const variant =
          key.variant === undefined
            ? undefined
            : key.variant === AUTO_VARIANT
              ? AUTO_VARIANT
              : resolveVariant(part, key.variant, viewId).id;
        next = mergePartKey(stored, variant, key);
      }
      return { id: part.id, name, stored, next };
    });

    const changed = [
      ...boneEdits
        .filter((e) => !jsonEqual(e.stored ?? null, e.next ?? null))
        .map((e) => keyName('bones', e.name)),
      ...partEdits
        .filter((e) => !jsonEqual(e.stored ?? null, e.next ?? null))
        .map((e) => keyName('parts', e.name)),
    ].sort();
    if (changed.length > 0) {
      ctx.tx.update((d) => {
        const anim = d.animations[animIndex];
        const target = anim !== undefined && 'frames' in anim ? anim.frames[frameIndex] : undefined;
        if (target === undefined) return;
        for (const e of boneEdits) {
          if (e.next === undefined) Reflect.deleteProperty(target.boneKeys, e.id);
          else target.boneKeys[e.id] = e.next;
        }
        for (const e of partEdits) {
          if (e.next === undefined) Reflect.deleteProperty(target.partKeys, e.id);
          else target.partKeys[e.id] = e.next;
        }
      });
    }
    return {
      animation: animationLabel(animation),
      frameIndex,
      frameId: frame.id,
      changed,
    };
  },
});
