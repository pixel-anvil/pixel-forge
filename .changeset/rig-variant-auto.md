---
'@pixel-forge/rig': minor
'@pixel-forge/core': patch
---

Variant auto-select (FR-RIG-14). A part key `variant: 'auto'` now draws the variant whose `drawnAngle` is nearest to the bone's world angle, rotated by the residual only. The previous frame's variant holds until another is closer by more than 5 degrees. The choice is a fold from frame 0, so a frame renders the same however it is reached; frame 0 has no history, also in a loop. An explicit variant key wins. Ties go to the earlier variant. `PART_RENDER_VERSION` is 2, so cached frames with auto keys are re-rendered. New in `@pixel-forge/rig`: `partResiduals` (the residual per drawn part and frame, for lint).
