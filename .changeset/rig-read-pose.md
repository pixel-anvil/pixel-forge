---
"@pixel-forge/ops": minor
"@pixel-forge/server": minor
---

Add the `rig.readPose` op (MCP `rig_read_pose`): one frame's bone and part values in the form `rig.setPose` takes, and the list of real keys. The resources `pf://doc/{id}/animations/{group}[/{direction}]/pose/{frame}` serve the same output. The `tools/list` byte budget in the server test goes from 80,000 to 82,500 (MCP-04).
