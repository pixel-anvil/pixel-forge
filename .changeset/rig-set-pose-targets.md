---
"@pixel-forge/ops": minor
"@pixel-forge/server": minor
---

`rig.setPose` (MCP `rig_set_pose`) accepts end-effector targets (FR-AI-17): `targets: {hand_r: {x, y, chain?, bend?}}`, also inside each `frames` item. IK (`solveIk`) turns the effector's parent bones (default 2) and stores plain FK angle keys, in the same undo step. The output adds `targets` with `reached` (within 1 px), the real pivot and the bones keyed. `bend` works for a chain of 2 only. No separate `rig_ik_target` tool.
