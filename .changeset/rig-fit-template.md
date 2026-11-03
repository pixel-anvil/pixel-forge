---
"@pixel-forge/rig": minor
"@pixel-forge/ops": minor
"@pixel-forge/server": minor
---

Add `fitHumanoid` to `rig` and the `rig.fitTemplate` op (MCP `rig_fit_template`): fit a humanoid template to landmark points (head top, hips, feet, hands) and set bone lengths and rest pose in one undo step. The `tools/list` byte limit in the server test goes from 76,300 to 79,000 (MCP-04).
