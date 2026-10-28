---
'@pixel-forge/raster': minor
'@pixel-forge/rig': minor
'@pixel-forge/core': minor
---

Part render pipeline: `renderParts` (variants, RotSprite on the snapped pivot, `(variant, angle)` cache, part overrides), `baseHash` over the override bbox ±1, `staleOverrides`, `rebase`, `discard`, and the shared `paintOverride`, `maskAt`, `unionRect`, `PART_RENDER_KEY` (rig); `ROTSPRITE_VERSION` (raster); `createRigRenderer` as the `renderFrame` rig hook with an optional `RigRenderer.renderKey`, `checkOverrides` (per-override `reason: 'error'` when a render fails), `rebaseOverrides`, `discardOverrides`, and a narrower rig input in `renderInputKey` for renderers that give a `renderKey` (core).
