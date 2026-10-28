/** Machine-readable reason of a {@link RigError}. */
export type RigErrorCode =
  | 'UNKNOWN_BONE' // a parent, rest entry, bone key or pose entry names a bone the rig does not have (I1)
  | 'DUPLICATE_BONE' // two bones share an id (I4)
  | 'CYCLE' // the bone graph is not a forest: a bone is its own ancestor (I1)
  | 'UNKNOWN_FRAME' // the frame id is not in the animation, or the frame index is out of range
  | 'UNKNOWN_VIEW' // no view of the rig draws the requested direction (or the rig has no views)
  | 'BAD_QUANTUM' // angleQuantum is not a multiple of 0.25 in (0, 90] that divides 360
  | 'UNKNOWN_VARIANT' // a part key names a variant the part does not have
  | 'IMAGE_MISSING' // a variant or override image is not in the image lookup
  | 'BAD_VALUE'; // a non-finite angle, a non-integer or out-of-range offset or rest position, an unknown interp

/**
 * Typed error thrown by every `@pixel-forge/rig` function for invalid input. `rig` never assumes that
 * `core`'s `validate()` has run: ids, the forest invariant (I1) and value ranges are checked here.
 */
export class RigError extends Error {
  readonly code: RigErrorCode;
  constructor(code: RigErrorCode, message: string) {
    super(message);
    this.name = 'RigError';
    this.code = code;
  }
}

/** Machine-readable reason of a {@link JointCheckError}. */
export type JointCheckErrorCode =
  | 'SIZE_MISMATCH' // the images of a joint check differ in size (or a buffer does not match its size)
  | 'BAD_ANGLE' // a checked angle that is 0, not finite or duplicated, or a childDir that is not a multiple of 0.25
  | 'BAD_RADIUS' // the window radius is not an integer, or is below 1
  | 'BAD_PIVOT'; // a non-integer pivot coordinate

/**
 * Typed error of the joint check (`docs/contracts/JOINT_CHECK.md` section 3.1): invalid input of
 * `jointGaps`. `jointCheck` also throws {@link RigError} for the rig-level inputs (`BAD_VALUE` for the sweep
 * and canvas) and for everything `renderParts` rejects.
 */
export class JointCheckError extends Error {
  readonly code: JointCheckErrorCode;
  constructor(code: JointCheckErrorCode, message: string) {
    super(message);
    this.name = 'JointCheckError';
    this.code = code;
  }
}
