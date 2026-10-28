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
