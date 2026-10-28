/**
 * `@pixel-forge/rig`: pure functions over schema types. This release: forward kinematics, key
 * interpolation and quantisation, and hierarchical snapping (FR-RIG-10/11/12, FR-RIG-20 steps 1–2).
 * No Node built-ins, no clock, no randomness, and no floating-point trig: rotations use raster's Q16
 * table and angles are exact rationals until they are rounded (NFR-02, ADR-010, ADR-012).
 * @packageDocumentation
 */

export { RigError } from './errors.js';
export type { RigErrorCode } from './errors.js';
export { normalizeAngle, quantizeAngle } from './angle.js';
export { boneOrder } from './order.js';
export type { BoneGraph } from './order.js';
export { interpWeight, keySpan, prepareAnimation, resolvePose } from './keys.js';
export type {
  KeySpan,
  PoseAnimation,
  PoseFrame,
  PoseOptions,
  PreparedAnimation,
  ResolvedBoneKey,
  ResolvedPose,
} from './keys.js';
export { evaluatePose, selectView, snapSkeleton } from './snap.js';
export type {
  Pose,
  PoseKey,
  RestPose,
  SnapOptions,
  SnappedBone,
  SnappedSkeleton,
  ViewSet,
  WorldTransform,
} from './snap.js';
export {
  DEFAULT_PROPORTIONS,
  HUMANOID_BONES,
  humanoidBack,
  humanoidFront,
  humanoidSide,
} from './templates.js';
export type {
  HumanoidProportions,
  SkeletonTemplate,
  TemplateBone,
  TemplateOptions,
} from './templates.js';
export { DEFAULT_VARIANT_NAME, PART_PREFIX, parsePartLayerName, partLayerName } from './names.js';
export type { PartLayerName } from './names.js';
export { DEFAULT_OVERLAP, bindByOverlap } from './bind.js';
export type { BindSkeleton, OverlapOptions, OverlapResult, PartShape } from './bind.js';
