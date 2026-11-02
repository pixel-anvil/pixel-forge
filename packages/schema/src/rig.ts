/**
 * The rig: bones, parts, variants and views (spec 3.1, FR-RIG-01…06, FR-RIG-14, FR-RIG-21).
 * Evaluation semantics live in `rig` (evaluatePose, renderParts); this file fixes the data.
 * @packageDocumentation
 */
import { z } from 'zod';
import { ROTATION_ALGORITHMS } from './constants.js';
import { BoneId, ImageId, LayerId, PartId, VariantId, ViewId } from './ids.js';
import { Angle, DirectionName, Int, Name, Point } from './primitives.js';
import { record } from './record.js';

/**
 * A bone. Rest poses live in views. A missing `parentId` makes a root; the bone graph is a forest
 * (I1). Names ending `_l`/`_r` pair bones for mirrored pose paste (FR-RIG-17).
 */
export const Bone = z.strictObject({
  id: BoneId,
  name: Name,
  parentId: BoneId.exactOptional(),
  /** Length in pixels from the pivot to the tip at rest (gizmos, IK, joint checks). */
  length: z.int().min(0),
});
/** A bone. */
export type Bone = z.infer<typeof Bone>;

/**
 * Rest transform of one bone in one view. For a root bone `x, y` is the pivot's canvas position;
 * for a child it is the pivot's offset from the parent's pivot, both at rest. `angle` is the rest
 * angle in degrees (clockwise, 0° along +x).
 */
export const RestTransform = z.strictObject({ x: Int, y: Int, angle: Angle });
/** Rest transform of one bone in one view. */
export type RestTransform = z.infer<typeof RestTransform>;

/**
 * One authored direction set of the character (ADR-011). Bones without a `rest` entry are unused
 * and hidden in this view. An animation uses the view whose `directions` contain its direction.
 */
export const View = z.strictObject({
  id: ViewId,
  /** Machine name, matched by the `#<view>` suffix of `part:` layer names (FR-DOC-04). */
  name: Name,
  /** Directions this view draws, e.g. `["side"]`. */
  directions: z.array(DirectionName).min(1),
  /** Rest pose per bone used in this view. */
  rest: record(BoneId, RestTransform),
  /** Whether a part is shown in this view; a missing part is shown. */
  partVisibility: record(PartId, z.boolean()),
  /** Default z per part in this view (higher draws on top); a missing part has z 0. */
  defaultZ: record(PartId, Int),
});
/** One authored direction set of the character. */
export type View = z.infer<typeof View>;

/** One drawing of a part for one view (FR-RIG-04). */
export const Variant = z.strictObject({
  id: VariantId,
  /** Machine name, matched by the `@<variant>` suffix of `part:` layer names (FR-DOC-04). */
  name: Name,
  viewId: ViewId,
  imageId: ImageId,
  /** Pivot pixel in image coordinates; rotation is about its centre (pixel-centre convention). */
  pivot: Point,
  /**
   * World angle in degrees at which the art was drawn, used by variant auto-select (FR-RIG-14).
   * Missing: drawn at the bone's rest angle in the variant's view.
   */
  drawnAngle: Angle.exactOptional(),
  /** Free labels, e.g. `["open"]`. */
  tags: z.array(Name),
});
/** One drawing of a part for one view. */
export type Variant = z.infer<typeof Variant>;

/** Per-part rotation algorithm (FR-RIG-21). */
export const RotationAlgorithm = z.enum(ROTATION_ALGORITHMS);
/** Per-part rotation algorithm (FR-RIG-21). */
export type RotationAlgorithm = z.infer<typeof RotationAlgorithm>;

/**
 * A rigid piece of the character bound to one bone, drawn into its own {@link PartLayer}. The
 * default variant for a view is the first variant with that `viewId` (`variants[0]` when the part
 * has one view).
 */
export const Part = z.strictObject({
  id: PartId,
  boneId: BoneId,
  /** The part layer this part renders into (one part per part layer). */
  layerId: LayerId,
  variants: z.array(Variant).min(1),
  /** Rotation algorithm; missing means `rotsprite`. */
  rotation: RotationAlgorithm.exactOptional(),
  /** Residual-rotation lint threshold for this part in degrees; missing means 22.5. */
  maxResidualDeg: z.number().gt(0).max(180).exactOptional(),
});
/** A rigid piece of the character bound to one bone. */
export type Part = z.infer<typeof Part>;

/** The character rig (spec 3): one skeleton, its parts, and one view per authored direction. */
export const Rig = z.strictObject({
  bones: z.array(Bone),
  parts: z.array(Part),
  /** Views; an animation without a direction uses `views[0]`. */
  views: z.array(View),
});
/** The character rig. */
export type Rig = z.infer<typeof Rig>;
