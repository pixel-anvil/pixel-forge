---
'@pixel-forge/rig': minor
---

Joint check (FR-RIG-05, `docs/contracts/JOINT_CHECK.md`): `jointGaps` (the pure predicate on alpha masks, checked against the hand-written `fixtures/joint` oracles), `jointCheck` (sweeps every joint of a rig through `renderParts` and reports gap pixels with exact coordinates), `JOINT_RADIUS_DEFAULT`, and `JointCheckError` (`SIZE_MISMATCH`, `BAD_ANGLE`, `BAD_RADIUS`, `BAD_PIVOT`).
