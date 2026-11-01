---
"@pixel-forge/ops": minor
"@pixel-forge/io": minor
---

Ops `pixels.readGrid` (per-call legend, rulers, at most 64x64), `pixels.writeGrid` (`.` transparent, `_` keep, at most 32x32, palette-checked; rig frames get overrides through `attributeEdit`, flat frames a layer cel), `render.frame` and `render.contactSheet` (PNG as `output.image`, long edge at most 1568, bone and pivot overlays). io: `contactSheet` takes a `rig` renderer and `contactSheetFrameOrigin` is exported. ops now depends on `raster` and `png`.
