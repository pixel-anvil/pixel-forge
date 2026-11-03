---
'@pixel-forge/ops': minor
'@pixel-forge/server': patch
---

Add the `draw` tool group: `draw_shapes` (lines, rects, ellipses, flood fills), `selection_transform` (move, flip, rotate a region) and `shade_with_ramp` (shift pixels along a palette ramp). Each is one undo step and works on a flat pixel layer or, as overrides, on a rig frame. `pixels.writeGrid` now shares its cel and override writer with them (`pixel-edit.ts`); behaviour is unchanged. The `tools/list` limit rises from 104,000 to 113,000 bytes.
