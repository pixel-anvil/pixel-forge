/**
 * `@pixel-forge/rig`: pure functions over schema types. This release: forward kinematics, key
 * interpolation and quantisation, hierarchical snapping, templates and binding, and the part render
 * pipeline with overrides and staleness (FR-RIG-10/11/12, FR-RIG-20 steps 1–4, FR-RIG-21/22).
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
export {
  PART_RENDER_KEY,
  PART_RENDER_VERSION,
  createPartCache,
  partTarget,
  renderParts,
} from './render.js';
export type {
  FrameOverride,
  PartAnimation,
  PartFrame,
  PartRender,
  PartRenderCache,
  PartRig,
  PartVariant,
  PartView,
  PlacedImage,
  RenderPartsInput,
  RigPart,
} from './render.js';
export {
  baseHash,
  checkOverride,
  discard,
  hashRegion,
  maskAt,
  overrideBox,
  overrideRegion,
  paintOverride,
  rebase,
  staleOverrides,
  unionRect,
} from './overrides.js';
export type {
  ImageLookup,
  OverrideCheck,
  OverrideLike,
  OverrideTargetRender,
  StaleReason,
} from './overrides.js';
