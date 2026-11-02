---
"@pixel-forge/rig": patch
"@pixel-forge/core": patch
"@pixel-forge/ops": patch
---

part.paintOverlap keeps the rest composite when two joint parts tie on z: `overlapMasks` takes `layerOrder`, so the mask uses the render's draw order.
