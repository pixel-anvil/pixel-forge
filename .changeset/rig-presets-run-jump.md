---
'@pixel-forge/rig': minor
---

Add the `run` and `jump` motion presets to `rig` (FR-RIG-15). `run` is a side-view loop with a flight phase (both feet off the ground), a longer stride, higher knee lift, bent elbows and a forward lean; planted feet slide at most 1 px. `jump` plays once (`loop: 'once'`): anticipation, push-off, rise, apex, fall, land and recover, with the height in the pelvis offset and optional forward travel as root motion. Both write plain FK keys and use integer maths only.
