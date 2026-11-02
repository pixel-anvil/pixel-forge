---
'@pixel-forge/rig': minor
---

Add motion presets to `rig` (FR-RIG-15): the generator API (`Preset`, `PRESETS`, `getPreset`, `resolveParams`, `commonParams`, `presetContext`, `placeLeg`, `presetAnimation`) and the first preset, `walk` (side view). A preset turns numeric parameters and any skeleton with the template bone names into plain FK bone keys at the angle quantum, plus per-frame root motion and labels. `walk` plants each support foot with the two-bone IK of E1.1 (no slide beyond 1 px, measured through `snapSkeleton`), closes its loop with no duplicate frame, and runs the left foot half a cycle after the right. All time and trig use integer phases and the committed Q16 table. No MCP tool yet (that is E3.3).
