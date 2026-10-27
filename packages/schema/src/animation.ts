/**
 * Animations, frames, keys and overrides (spec 3.1, FR-ANIM-02/03/07/08, FR-RIG-11/12/16/20/22).
 * @packageDocumentation
 */
import { z } from 'zod';
import { AUTO_VARIANT, INTERPOLATIONS, LOOP_MODES } from './constants.js';
import { AnimationId, BoneId, FrameId, ImageId, OverrideId, PartId, VariantId } from './ids.js';
import {
  Angle,
  Delta,
  DirectionName,
  DurationMs,
  Hash,
  Int,
  Name,
  Point,
  RGBA8,
} from './primitives.js';
import { record } from './record.js';

/** Animation loop mode (spec 3.1). */
export const LoopMode = z.enum(LOOP_MODES);
/** Animation loop mode. */
export type LoopMode = z.infer<typeof LoopMode>;

/** Bone-key interpolation (FR-RIG-12). */
export const Interpolation = z.enum(INTERPOLATIONS);
/** Bone-key interpolation. */
export type Interpolation = z.infer<typeof Interpolation>;

/**
 * A sparse bone key at one frame (R-15). Each channel (`angle`, `offset`, `flipX`) interpolates
 * independently between the frames that key it; `flipX` always steps. At least one channel is set.
 */
export const BoneKey = z
  .strictObject({
    /** Rotation relative to the rest angle, degrees clockwise; composes down the hierarchy (FK). */
    angle: Angle.exactOptional(),
    /** Integer translation of the pivot from its rest position. */
    offset: Point.exactOptional(),
    /** Mirror the bone horizontally about its pivot. */
    flipX: z.boolean().exactOptional(),
    /** Interpolation from this key to the next one of the same channel; missing means `linear`. */
    interp: Interpolation.exactOptional(),
  })
  .refine(
    (k) => k.angle !== undefined || k.offset !== undefined || k.flipX !== undefined,
    'a bone key sets at least one of angle, offset, flipX',
  );
/** A sparse bone key at one frame. */
export type BoneKey = z.infer<typeof BoneKey>;

/** A part-key variant choice: a variant id or `'auto'` (FR-RIG-14; an explicit id wins). */
export const VariantChoice = z.union([VariantId, z.literal(AUTO_VARIANT)]);
/** A part-key variant choice. */
export type VariantChoice = z.infer<typeof VariantChoice>;

/**
 * A sparse part key at one frame (R-15). Step interpolation: a value holds until the next key of
 * the same field. At least one field is set.
 */
export const PartKey = z
  .strictObject({
    variant: VariantChoice.exactOptional(),
    /** Overrides the view's default z. */
    z: Int.exactOptional(),
    /** Overrides the view's part visibility. */
    visible: z.boolean().exactOptional(),
  })
  .refine(
    (k) => k.variant !== undefined || k.z !== undefined || k.visible !== undefined,
    'a part key sets at least one of variant, z, visible',
  );
/** A sparse part key at one frame. */
export type PartKey = z.infer<typeof PartKey>;

/**
 * One frame of an authored animation. Everything keyed by the frame travels with it on reorder
 * (spec 3.2). Markers are canvas positions keyed by marker name, which keeps the anatomical side.
 */
export const Frame = z.strictObject({
  /** Stable id; unique across the document. */
  id: FrameId,
  /** A hold is a longer duration, never a duplicated frame (FR-ANIM-03). */
  durationMs: DurationMs,
  /** Marker positions on the canvas; a missing marker is absent in this frame. */
  markers: record(Name, Point),
  /** Event names fired when the frame starts, in order. */
  events: z.array(Name),
  /** Integer root motion of this frame (FR-ANIM-08). */
  rootMotion: Delta,
  /** Sparse bone keys by bone. */
  boneKeys: record(BoneId, BoneKey),
  /** Sparse part keys by part. */
  partKeys: record(PartId, PartKey),
});
/** One frame of an authored animation. */
export type Frame = z.infer<typeof Frame>;

/** Override target: one part (part override) or the composite (`'final'`). */
export const OverrideTarget = z.union([z.literal('final'), z.strictObject({ partId: PartId })]);
/** Override target. */
export type OverrideTarget = z.infer<typeof OverrideTarget>;

/**
 * A pixel touch-up on one frame of a rig render (FR-RIG-22). `erase` and `set` are both optional but
 * at least one is present, and they share one anchor (the images' top-left). Within one override,
 * `erase` applies first, then `set` (erase-then-set, spec 3.4 clarification 11).
 *
 * `erase` is an 8-bit mask image in every colour mode, RGBA and indexed alike (spec 3.4
 * clarification 8): a mask value of 255 clears the target pixel and 0 leaves it. `set` is an
 * ordinary image in the document's colour mode, painted over the result.
 *
 * A part override's `anchor` is relative to the part's snapped pivot and is applied to the part's
 * own render; a final override's anchor is a canvas position, applied after post-passes. `baseHash`
 * (lower-case hex SHA-256) hashes the override bbox dilated by 1 px over the target's pre-override
 * render; a mismatch makes the override stale.
 */
export const Override = z
  .strictObject({
    id: OverrideId,
    /** Frame the override applies to; for a mirrored animation, a frame of its source. */
    frameId: FrameId,
    target: OverrideTarget,
    anchor: Point,
    set: ImageId.exactOptional(),
    erase: ImageId.exactOptional(),
    baseHash: Hash,
  })
  .refine((o) => o.set !== undefined || o.erase !== undefined, 'an override needs set or erase');
/** A pixel touch-up on one frame of a rig render. */
export type Override = z.infer<typeof Override>;

const quarterDegrees = (q: number): boolean => {
  const quarters = q * 4;
  return Number.isInteger(quarters) && 1440 % quarters === 0;
};

/**
 * Angle quantum in degrees, `0 < q ≤ 90`: a multiple of 0.25 that divides 360 (e.g. 0.25, 0.5, 1,
 * 1.5, 2, 5, 22.5, 45, 90). The fixed-point trig table is exact at these angles (NFR-02).
 */
export const AngleQuantum = z
  .number()
  .gt(0)
  .max(90)
  .refine(quarterDegrees, 'angleQuantum must be a multiple of 0.25 that divides 360');

/** Outline post-pass options (T1.7 `outline`). */
export const OutlinePass = z.strictObject({
  color: RGBA8,
  /** Outline only the outer silhouette, not holes. */
  outsideOnly: z.boolean().exactOptional(),
  /** Also fill diagonal corners. */
  corners: z.boolean().exactOptional(),
});
/** Outline post-pass options. */
export type OutlinePass = z.infer<typeof OutlinePass>;

/**
 * Opt-in post-passes over the composite (FR-RIG-20 step 6), applied in this order: orphan removal,
 * then outline. A missing field means the pass is off.
 */
export const PostPasses = z.strictObject({
  removeOrphans: z.strictObject({}).exactOptional(),
  outline: OutlinePass.exactOptional(),
});
/** Opt-in post-passes over the composite. */
export type PostPasses = z.infer<typeof PostPasses>;

/** An animation that owns its frames (spec 3.1). */
export const AuthoredAnimation = z.strictObject({
  id: AnimationId,
  /** Group name, e.g. `run`; `(group, direction)` is unique (I6). */
  group: Name,
  /** Direction, e.g. `side`; missing means undirected. */
  direction: DirectionName.exactOptional(),
  loop: LoopMode,
  /** Missing means 1°. */
  angleQuantum: AngleQuantum.exactOptional(),
  postPasses: PostPasses.exactOptional(),
  /** At least one frame, in play order. */
  frames: z.array(Frame).min(1),
  /** Overrides in application order. */
  overrides: z.array(Override),
});
/** An animation that owns its frames. */
export type AuthoredAnimation = z.infer<typeof AuthoredAnimation>;

/**
 * A derived mirror (FR-RIG-16, ADR-011): the source's render flipped about `origin.x`, with markers
 * mirrored and names kept. It stores only `mirrorOf` plus optional extra overrides, keyed by the
 * source's frame ids. Frames, loop, timing and post-passes come from the source.
 */
export const MirrorAnimation = z.strictObject({
  id: AnimationId,
  group: Name,
  direction: DirectionName.exactOptional(),
  /** Source animation: same group, not itself a mirror (I6). */
  mirrorOf: AnimationId,
  /** Extra overrides applied after mirroring, in application order. */
  overrides: z.array(Override),
});
/** A derived mirror animation. */
export type MirrorAnimation = z.infer<typeof MirrorAnimation>;

/** An animation: {@link AuthoredAnimation} or {@link MirrorAnimation} (narrow with `'mirrorOf' in a`). */
export const Animation = z.union([AuthoredAnimation, MirrorAnimation]);
/** An animation. */
export type Animation = z.infer<typeof Animation>;

/** The `(group, direction)` identity of an animation (I6). */
export type AnimationKey = Pick<Animation, 'group' | 'direction'>;
