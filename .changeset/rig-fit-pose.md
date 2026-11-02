---
'@pixel-forge/rig': minor
'@pixel-forge/ops': minor
'@pixel-forge/server': minor
---

Add the pose search `fitPose` to `rig` (seeded, integer maths, the renderer is passed in) and the op `rig.fitPose` (MCP `rig_fit_pose`): find the bone angles and part variants whose render of one frame matches a target PNG or another frame, and return them in `rig.setPose` form with `exact`, `error` and `renders`. It reads files, changes nothing and records no undo entry. The `tools/list` byte budget in the server test goes from 76,300 to 79,000 (MCP-04). Limits of the search: KNOWN_ISSUES FIT-01.
