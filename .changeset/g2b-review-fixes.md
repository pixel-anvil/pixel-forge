---
'@pixel-forge/ops': patch
'@pixel-forge/lint': patch
---

Fix the G2b review findings. `rig.setPose` targets now start the IK solve from the whole call (explicit bone keys on all posed frames, `null` removals) and may share chain bones with each other and with `bones` entries (the solve wins). `rig.applyPreset` refuses a direction not drawn by the `side` view and applies `durationMs` to every frame of a replaced animation. `pixels.clipped` on a mirror also counts pixels the renderer clips before the flip.
