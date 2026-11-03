/**
 * `rig.readPose`: the bone and part values of one frame, and which of them are real keys
 * (read-only; MCP `rig_read_pose`). The pair of `rig.setPose`.
 * @packageDocumentation
 */
import { keySpan, resolvePose } from '@pixel-forge/rig';
import type { BoneKey, PartKey } from '@pixel-forge/schema';
import { z } from 'zod';
import { defineOp } from '../define.js';
import {
  AnimRef,
  DocRef,
  FrameRef,
  animationLabel,
  partResolver,
  requireRig,
  resolveAuthoredAnimation,
  resolveFrame,
  viewForAnimation,
} from '../refs.js';

const BONE_CHANNELS = ['angle', 'offset', 'flipX'] as const;
const PART_FIELDS = ['variant', 'z', 'visible'] as const;

/** A bone or part entry of the output: only the channels that are set. */
type Entry = Record<string, unknown>;

/**
 * `rig.readPose` (MCP `rig_read_pose`, CLI `pf rig read-pose`): the resolved bone and part values of
 * one frame in the form `rig.setPose` takes, plus the list of real keys on that frame.
 */
export const rigReadPose = defineOp({
  name: 'rig.readPose',
  safety: 'read',
  summary:
    'Read one frame: bone and part values, and which are real keys (the rest are interpolated or held).',
  description:
    'Output matches rig_set_pose input: pass bones and parts back unchanged. Lists only bones and channels that some frame keys; the rest are at rest. keyed names the real keys on this frame ("bones.<name>.<channel>"); other values are interpolated or held. Writing a value back makes it a key: this frame renders the same, other frames may change, so write back only what you mean to key. Mirror animations: read the source.',
  mcp: { name: 'rig_read_pose' },
  input: z.strictObject({
    doc: DocRef,
    animation: AnimRef,
    frame: FrameRef,
  }),
  output: z.strictObject({
    animation: z.string(),
    frameIndex: z.int(),
    frameId: z.string(),
    bones: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .describe('By bone name: angle, offset {x,y}, flipX, and interp of the stored key.'),
    parts: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .describe('By part name: variant name or "auto", z, visible.'),
    keyed: z.array(z.string()),
  }),
  examples: [
    {
      title: 'Read frame 2 of the run cycle',
      input: { doc: 'doc_g1ed5q', animation: { group: 'run', direction: 'side' }, frame: 2 },
    },
  ],
  handler: (ctx, input) => {
    const doc = ctx.doc;
    const rig = requireRig(doc);
    const { animation } = resolveAuthoredAnimation(doc, input.animation);
    const { index, frame } = resolveFrame(animation, input.frame);
    const frames = animation.frames;
    const keyed: string[] = [];

    // Bones: the rig package resolves the pose (interpolated, quantised).
    const pose = resolvePose(rig, animation, index);
    const bones: Record<string, Entry> = {};
    for (const bone of rig.bones) {
      const resolved = pose.get(bone.id);
      if (resolved === undefined) continue;
      const stored: Readonly<BoneKey> | undefined = frame.boneKeys[bone.id];
      const entry: Entry = {};
      for (const ch of BONE_CHANNELS) {
        if (!frames.some((f) => f.boneKeys[bone.id]?.[ch] !== undefined)) continue;
        if (ch === 'angle') entry.angle = resolved.angle;
        else if (ch === 'offset') entry.offset = { x: resolved.offset.x, y: resolved.offset.y };
        else entry.flipX = resolved.flipX;
        if (stored?.[ch] !== undefined) keyed.push(`bones.${bone.name}.${ch}`);
      }
      if (Object.keys(entry).length === 0) continue;
      if (stored?.interp !== undefined) entry.interp = stored.interp;
      bones[bone.name] = entry;
    }

    // Parts: step channels, resolved with the renderer's key span.
    const parts: Record<string, Entry> = {};
    if (rig.parts.length > 0) {
      const resolvePart = partResolver(doc);
      const viewId = viewForAnimation(doc, animation).id;
      const wrap = animation.loop === 'loop';
      for (const p of rig.parts) {
        const { part, name } = resolvePart(p.id);
        const entry: Entry = {};
        for (const field of PART_FIELDS) {
          const at: number[] = [];
          frames.forEach((f, i) => {
            if (f.partKeys[part.id]?.[field] !== undefined) at.push(i);
          });
          const span = keySpan(at, index, frames.length, wrap);
          if (span === undefined) continue;
          const key: Readonly<PartKey> | undefined = frames[span.from]?.partKeys[part.id];
          if (field === 'variant') {
            const choice = key?.variant;
            if (choice === undefined) continue;
            const variant = part.variants.find((v) => v.id === choice);
            entry.variant =
              variant === undefined
                ? choice
                : variant.viewId === viewId
                  ? variant.name
                  : variant.id;
          } else if (field === 'z') {
            if (key?.z !== undefined) entry.z = key.z;
          } else if (key?.visible !== undefined) {
            entry.visible = key.visible;
          }
          if (span.n === 0 && span.from === index) keyed.push(`parts.${name}.${field}`);
        }
        if (Object.keys(entry).length > 0) parts[name] = entry;
      }
    }

    return {
      animation: animationLabel(animation),
      frameIndex: index,
      frameId: frame.id,
      bones,
      parts,
      keyed: keyed.sort(),
    };
  },
});
