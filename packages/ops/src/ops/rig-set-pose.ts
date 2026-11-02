/**
 * `rig.setPose`: set bone keys and part keys on one frame (spec 6.3's worked example).
 * @packageDocumentation
 */
import { jsonEqual } from '@pixel-forge/core';
import { AUTO_VARIANT, FrameRef as FrameIndex, Interpolation } from '@pixel-forge/schema';
import type { BoneId, BoneKey, PartId, PartKey, VariantChoice } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import { OpError } from '../errors.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  resolveAuthoredAnimation,
  requireRig,
  resolveBone,
  partResolver,
  resolveFrame,
  resolveVariant,
  viewForAnimation,
} from '../refs.js';

/** A bone key to merge into the frame's key: the channels given replace the stored ones. */
export const BoneKeyInput = z
  .strictObject({
    angle: z.number().optional().describe('Degrees clockwise from rest; child bones follow (FK).'),
    offset: z
      .strictObject({ x: z.int(), y: z.int() })
      .optional()
      .describe('Pivot shift from rest, integer px.'),
    flipX: z.boolean().optional().describe('Mirror the bone horizontally about its pivot.'),
    interp: Interpolation.optional().describe(
      'To the next key: "linear" (default), "step", "ease-in-out".',
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
      .describe("Draw order, held until the next key; higher on top (default: the view's)."),
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

/** One frame of the multi-frame form: the same shape as the top-level frame, bones and parts. */
const FramePose = z.strictObject({
  frame: FrameIndex,
  bones: z.record(z.string(), z.unknown()).optional(),
  parts: z.record(z.string(), z.unknown()).optional(),
});

const BoneKeys = z.record(z.string().min(1), BoneKeyInput.nullable());
const PartKeys = z.record(z.string().min(1), PartKeyInput.nullable());

/** Parses a loosely typed `bones` or `parts` map of a `frames` item with the strict schema. */
function strictMap<T>(schema: z.ZodType<T>, value: unknown, path: string): T | undefined {
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new OpError('BAD_INPUT', `invalid ${path}`, {
    issues: r.error.issues.map((i) => ({
      path: [path, ...i.path.map(String)].join('.'),
      message: i.message,
    })),
  });
}

interface BoneEdit {
  id: BoneId;
  name: string;
  stored: Readonly<BoneKey> | undefined;
  next: BoneKey | undefined;
}
interface PartEdit {
  id: PartId;
  name: string;
  stored: Readonly<PartKey> | undefined;
  next: PartKey | undefined;
}
interface FramePlan {
  frameIndex: number;
  frameId: string;
  bones: BoneEdit[];
  parts: PartEdit[];
}

const hasChannel = (k: Readonly<BoneKey> | undefined): boolean =>
  k !== undefined && (k.angle !== undefined || k.offset !== undefined || k.flipX !== undefined);

/** `rig.setPose` (MCP `rig_set_pose`, CLI `pf rig set-pose`). */
export const rigSetPose = defineOp({
  name: 'rig.setPose',
  safety: 'mutate',
  summary:
    'Set bone keys (angle deg clockwise, offset int px) and/or part keys (variant, z, visible) on one frame or many.',
  description:
    'Channels you pass replace the stored ones; null removes a bone or part key. A channel with no key here interpolates between keys on other frames, not back to rest: key offsets on every frame or on none. Part keys hold both ways: set z or visible once. "frames" poses many frames as one undo step. Output keyed lists bones keyed; interpolated, bones keyed elsewhere but not on a posed frame (keyAll keys them at rest). Art past the canvas edge is cut off. Next: render_contact_sheet.',
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef.optional(),
    bones: BoneKeys.optional().describe('Bone keys by bone name (or id); null removes the key.'),
    parts: PartKeys.optional().describe(
      'Part keys by part-layer name (or part id); null removes the key.',
    ),
    frames: z.array(FramePose).min(1).optional().describe('Many frames, instead of frame.'),
    keyAll: z.boolean().optional().describe('Also key all other bones at rest on posed frames.'),
  }),
  output: z.strictObject({
    animation: z.string().describe('"group/direction" of the posed animation.'),
    frameIndex: z.int().describe('The posed frame; the first with "frames".'),
    frameId: z.string(),
    frames: z.array(z.int()).optional().describe('Posed frame indexes, with "frames".'),
    changed: z
      .array(z.string())
      .describe('Keys that changed, as "bones.<name>" / "parts.<name>"; empty when nothing did.'),
    keyed: z.array(z.string()).describe('Bones this call keys.'),
    interpolated: z.array(z.string()).describe('Bones that interpolate on a posed frame.'),
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
        keyed: ['lower_arm_r', 'upper_arm_r'],
        interpolated: [],
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
    const multi = input.frames !== undefined;
    if (multi && (input.frame !== undefined || input.bones || input.parts)) {
      throw new OpError('BAD_INPUT', 'give "frames", or frame with bones and parts, not both', {
        issues: [{ path: 'frames', message: 'frame, bones and parts go inside each item' }],
      });
    }
    if (input.frames === undefined && input.frame === undefined) {
      throw new OpError('BAD_INPUT', 'rig.setPose needs "frame" (or "frames")', {
        issues: [{ path: 'frame', message: 'required without "frames"' }],
      });
    }
    const items =
      input.frames !== undefined
        ? input.frames.map((f, i) => ({
            path: `frames.${String(i)}.`,
            frame: f.frame,
            bones: strictMap(BoneKeys, f.bones, `frames.${String(i)}.bones`),
            parts: strictMap(PartKeys, f.parts, `frames.${String(i)}.parts`),
          }))
        : [{ path: '', frame: input.frame ?? 0, bones: input.bones, parts: input.parts }];
    const keyAll = input.keyAll === true;
    const rig = keyAll ? requireRig(doc) : doc.rig;
    const viewId = items.some((it) => Object.keys(it.parts ?? {}).length > 0)
      ? viewForAnimation(doc, animation).id
      : undefined;
    const resolvePart = partResolver(doc);
    const frameSeen = new Set<number>();

    // Resolve every reference before touching the document.
    const seenByFrame: Set<string>[] = [];
    const plans: FramePlan[] = items.map((it) => {
      const { index: frameIndex, frame } = resolveFrame(animation, it.frame);
      if (frameSeen.has(frameIndex)) {
        throw new OpError('BAD_INPUT', `${it.path}frame names a frame that is already posed`, {
          issues: [{ path: `${it.path}frame`, message: 'the same frame appears twice' }],
        });
      }
      frameSeen.add(frameIndex);
      const bones = Object.entries(it.bones ?? {});
      const parts = Object.entries(it.parts ?? {});
      if (bones.length === 0 && parts.length === 0) {
        throw new OpError('BAD_INPUT', 'rig.setPose needs "bones" or "parts"', {
          issues: [{ path: it.path, message: 'give at least one bone or part key' }],
        });
      }
      const seen = new Set<string>();
      seenByFrame.push(seen);
      const unique = (id: string, path: string): void => {
        if (seen.has(id)) {
          throw new OpError('BAD_INPUT', `${path} names an entity that is already keyed`, {
            issues: [{ path, message: 'the same bone or part appears twice (by name and id)' }],
          });
        }
        seen.add(id);
      };
      const boneEdits: BoneEdit[] = bones.map(([ref, key]) => {
        const bone = resolveBone(doc, ref);
        unique(bone.id, it.path + keyName('bones', ref));
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
      const partEdits: PartEdit[] = parts.map(([ref, key]) => {
        const { part, name } = resolvePart(ref);
        unique(part.id, it.path + keyName('parts', ref));
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
      return { frameIndex, frameId: frame.id, bones: boneEdits, parts: partEdits };
    });

    if (rig !== undefined && keyAll) {
      // Key every bone the call did not name, at rest. Offsets only for bones whose offset is keyed
      // somewhere in the animation or by this call (an offset on some frames only interpolates).
      const offsetBones = new Set<string>();
      for (const b of rig.bones) {
        if (animation.frames.some((f) => f.boneKeys[b.id]?.offset !== undefined)) {
          offsetBones.add(b.id);
        }
      }
      for (const p of plans) for (const e of p.bones) if (e.next?.offset) offsetBones.add(e.id);
      plans.forEach((p, i) => {
        const frame = animation.frames[p.frameIndex];
        for (const b of rig.bones) {
          if (seenByFrame[i]?.has(b.id)) continue;
          const stored = frame?.boneKeys[b.id];
          const next = mergeBoneKey(stored, {
            angle: stored?.angle ?? 0,
            ...(offsetBones.has(b.id) && stored?.offset === undefined
              ? { offset: { x: 0, y: 0 } }
              : {}),
          });
          p.bones.push({ id: b.id, name: b.name, stored, next });
        }
      });
    }

    const names = new Set<string>();
    for (const p of plans) {
      for (const e of p.bones) {
        if (!jsonEqual(e.stored ?? null, e.next ?? null)) names.add(keyName('bones', e.name));
      }
      for (const e of p.parts) {
        if (!jsonEqual(e.stored ?? null, e.next ?? null)) names.add(keyName('parts', e.name));
      }
    }
    const changed = [...names].sort();

    // The trap: a bone keyed on some frames but not on a posed one interpolates there.
    const keyed = new Set<string>();
    const interpolated = new Set<string>();
    for (const bone of rig?.bones ?? []) {
      const keyedAt = animation.frames.map((f, i) => {
        const edit = plans.find((p) => p.frameIndex === i)?.bones.find((e) => e.id === bone.id);
        return edit === undefined ? hasChannel(f.boneKeys[bone.id]) : hasChannel(edit.next);
      });
      if (plans.some((p) => p.bones.some((e) => e.id === bone.id && hasChannel(e.next)))) {
        keyed.add(bone.name);
      }
      if (keyedAt.some(Boolean) && plans.some((p) => keyedAt[p.frameIndex] !== true)) {
        interpolated.add(bone.name);
      }
    }

    if (changed.length > 0) {
      ctx.tx.update((d) => {
        const anim = d.animations[animIndex];
        if (anim === undefined || !('frames' in anim)) return;
        for (const p of plans) {
          const target = anim.frames[p.frameIndex];
          if (target === undefined) continue;
          for (const e of p.bones) {
            if (e.next === undefined) Reflect.deleteProperty(target.boneKeys, e.id);
            else target.boneKeys[e.id] = e.next;
          }
          for (const e of p.parts) {
            if (e.next === undefined) Reflect.deleteProperty(target.partKeys, e.id);
            else target.partKeys[e.id] = e.next;
          }
        }
      });
    }
    const first = plans[0];
    return {
      animation: animationLabel(animation),
      frameIndex: first?.frameIndex ?? 0,
      frameId: first?.frameId ?? '',
      ...(multi ? { frames: plans.map((p) => p.frameIndex) } : {}),
      changed,
      keyed: [...keyed].sort(),
      interpolated: [...interpolated].sort(),
    };
  },
});
