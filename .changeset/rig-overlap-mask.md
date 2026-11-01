---
'@pixel-forge/rig': minor
---

Overlap mask (FR-RIG-07, `docs/contracts/JOINT_CHECK.md` section 7): `overlapMask` (the pure mask of pixels that can be painted on the lower part to close a joint's gaps without changing the composite at rest), `overlapMasks` (every joint of a rig with gaps, from the same sweep as `jointCheck`), `checkOverlapPaint` (reports paint outside the mask) and the `AMBIGUOUS_PARTS` / `ROTATED_REST` joint-check error codes.
