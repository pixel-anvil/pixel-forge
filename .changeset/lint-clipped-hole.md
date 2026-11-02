---
'@pixel-forge/lint': minor
'@pixel-forge/ops': minor
---

Add two lint rules. `pixels.clipped` (warning) reports posed part art that falls outside the canvas, per frame, with the sides and bones. `rig.partHole` (warning) reports 1 px holes that rotation opens inside a part, when the drawn art has fewer. The rule id enum of `lint` grows by two values; no other op changes. Closes KNOWN_ISSUES LINT-01 and the hole part of LINT-02.
