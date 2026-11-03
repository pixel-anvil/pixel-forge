---
'@pixel-forge/lint': minor
---

Implement the lint rule `rig.rotationResidual` (it was a stub). It warns when the residual rotation of a drawn part, from `partResiduals`, is above `Part.maxResidualDeg` (default 22.5 degrees), one finding per part and animation at the worst frame. Closes the lint half of FR-RIG-14.
