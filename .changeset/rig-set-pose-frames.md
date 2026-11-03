---
"@pixel-forge/ops": minor
"@pixel-forge/server": minor
---

`rig.setPose` (MCP `rig_set_pose`) poses several frames in one call with `frames: [{frame, bones, parts}]`, as one undo step; `frame`, `bones` and `parts` still work alone. New `keyAll` keys every bone not named at rest on each posed frame. The output adds `keyed` (bones the call keys) and `interpolated` (bones keyed on other frames but not on a posed one, which interpolate there). The `tools/list` budget stays at 76,300 bytes.
