# @pixel-forge/raster

## 0.1.0

### Minor Changes

- b9642b1: Sparse copy-on-write tiled RGBA and indexed images, exact integer compositing, transforms, dirty-tile capture/restore for history.
- 81ca754: Drawing primitives: symmetric lines with brushes, rectangles, ellipses (Zingl), flood fill, pixel-perfect stroke filter; orphan removal and outline post-passes.
- eff07e8: Fixed-point Q16 trig at 0.25° (`sinQ16`, `cosQ16`, `rotatePoint`, `rotatePointQ16`, `roundQ16`) and pixel-art rotation about a pivot pixel (`rotateAbout` with RotSprite, nearest or none; `prepareRotSprite` caches the ×8 image).
- 2abc56f: Part render pipeline: `renderParts` (variants, RotSprite on the snapped pivot, `(variant, angle)` cache, part overrides), `baseHash` over the override bbox ±1, `staleOverrides`, `rebase`, `discard`, and the shared `paintOverride`, `maskAt`, `unionRect`, `PART_RENDER_KEY` (rig); `ROTSPRITE_VERSION` (raster); `createRigRenderer` as the `renderFrame` rig hook with an optional `RigRenderer.renderKey`, `checkOverrides` (per-override `reason: 'error'` when a render fails), `rebaseOverrides`, `discardOverrides`, and a narrower rig input in `renderInputKey` for renderers that give a `renderKey` (core).
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 57e8121: G1 gate review fixes. core: `bakeAnimation` inserts the baked layer at the top level (it no longer inherits a group's opacity, visibility or export flag) and hides the rig on every baked frame; `applySkeletonTemplate` refuses (`bone-mismatch`) a reused root whose template parent is missing; `deleteView` refuses (`view-in-use`) a view an authored animation resolves to; `bindParts` counts cel opacity (`animated`, new skip reason `translucent`, cel opacity moves to the layer); `splitRegion` refuses `rig-block-order` when a pixel layer would change which pixels cover which, and `translucent` when translucent art would fold into a part as a variant. rig: `overlapMask` / `overlapMasks` / `checkOverlapPaint` count only fully opaque upper pixels on a layer of opacity 255 as hiding paint (`overlapMasks` takes `layerOpacity`); `attributeEdit` no longer overflows the stack on very large edits; `jointCheck` rejects a sweep with too many steps instead of spinning. raster: `ellipse` / `ellipsePixels` reach the last row of 84 flat sizes up to 24x24 (other sizes unchanged). ops: `rig.bindParts` and `part.split` descriptions list the new skip and refusal reasons.
- Updated dependencies [730ae95]
- Updated dependencies [65ade95]
- Updated dependencies [a5112e2]
- Updated dependencies [a2dbd50]
- Updated dependencies
  - @pixel-forge/color@0.1.0
  - @pixel-forge/schema@0.1.0
