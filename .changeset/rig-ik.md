---
'@pixel-forge/rig': minor
---

Add IK to `rig` (FR-RIG-13): `solveTwoBone` (analytic, with a bend side), `solveFabrik` (FABRIK, Aristidou and Lasenby 2011) and the rig-level `solveIk` (move an effector bone's pivot onto a target by turning its nearest ancestors). All results are baked to plain FK key angles at the angle quantum; the maths is integer (Q16 fixed point, exact square roots, the committed sine table), so results are the same on every platform.
