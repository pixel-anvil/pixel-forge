# @pixel-forge/core

## 0.1.0

### Minor Changes

- e816090: bakeAnimation: bake a rig animation into a plain pixel animation (new, or in place), overrides merged.
- 31f9724: Document store with transactions (copy-on-write drafts, path helpers, image create/write/delete, seeded ids), structural and tile patches, linear undo/redo history with an exact tile-byte memory cap, change events, `documentHash`, and the `RigRenderer` hook interface.
- 65941c1: Frame operations (insert, duplicate, delete with link materialisation, reorder) and validate() with 46 finding codes.
- f3ec9ec: Mirror markers (`frameMarkers`, `mirrorMarkers`, `x' = 2·origin.x − x`), pose clipboard transactions `copyPoseTx` / `pastePoseTx`, and the documented decision that a mirror's part overrides are never rendered.
- b923010: renderFrame: layer tree compositing with rig block, post-passes, final overrides, mirror, skin; memoised renderer and per-frame input hash.
- b63fa6e: `splitRegion` (FR-RIG-07, W2b): moves a rectangle, lasso or colour-bounded flood selection of a flat cel into a new layer, leaving transparency behind, and binds it to a part by name or by overlap. One transaction; the split parts recomposite to the source frame by hash.
- cf65db9: Operation API framework: defineOp, the registry (one transaction = one undo step labelled `AI: <op>`, validate guard, confirm for destructive ops), OpContext, OpError with mapping of core/io/rig errors, reference resolution by id or name, the OpHost interface with an in-memory host, generators for MCP tool JSON, CLI metadata and OPERATIONS.md, and the ops doc.open, doc.summary and rig.setPose. A change listener that throws after a commit is reported as a `warnings` entry, not as a failed call. core: `validate(view, {images})` limits the pixel content checks to the given images.
- a6cd5ae: Ops with logic: `doc.create`, `doc.save`, `doc.setColorMode`, `anim.create`, `anim.update`, `frame.setMeta`, `layer.update`, `cel.link`, `part.split`, `part.paintOverlap`, `rig.bindParts`, `rig.editBones`, `rig.setPivot`, `rig.mirrorAnimation`, `rig.bake`, `override.list`, `override.resolve`, `io.import`, `io.export`. New: `confirmText` for destructive ops, core `paintOverlapTx` and `setColorMode`, `rig` option of `exportSpritesheet`.
- de82d2f: Edit attribution (FR-RIG-22/24): `attributeEdit(ctx, before, edited)` turns an edited frame into part overrides (an edit inside exactly one part's footprint that shows through the composite) and a final override for the rest, with 8-bit erase masks (`IndexedImage`, 255), pivot-relative or canvas anchors and `baseHash` taken as `checkOverride` checks it (rig); `attributeEditTx(tx, animRef, frameRef, edited)` builds the context from the export render and writes the overrides, the entry point of `pf override import` (core); `attributeEditTxReport` also lists the existing overrides (this frame, and its mirrors') that the import made stale. `EditContext.finalOnly` and `RigError` code `BAD_ARGUMENT` (reason `before-mismatch`) are additive.
- 2abc56f: Part render pipeline: `renderParts` (variants, RotSprite on the snapped pivot, `(variant, angle)` cache, part overrides), `baseHash` over the override bbox ±1, `staleOverrides`, `rebase`, `discard`, and the shared `paintOverride`, `maskAt`, `unionRect`, `PART_RENDER_KEY` (rig); `ROTSPRITE_VERSION` (raster); `createRigRenderer` as the `renderFrame` rig hook with an optional `RigRenderer.renderKey`, `checkOverrides` (per-override `reason: 'error'` when a render fails), `rebaseOverrides`, `discardOverrides`, and a narrower rig input in `renderInputKey` for renderers that give a `renderKey` (core).
- 3f62785: Humanoid skeleton templates, part layer name parsing, bind by overlap (rig); bone/view CRUD, rest poses, pivots, applySkeletonTemplate and bindParts transactions (core).
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 57e8121: G1 gate review fixes. core: `bakeAnimation` inserts the baked layer at the top level (it no longer inherits a group's opacity, visibility or export flag) and hides the rig on every baked frame; `applySkeletonTemplate` refuses (`bone-mismatch`) a reused root whose template parent is missing; `deleteView` refuses (`view-in-use`) a view an authored animation resolves to; `bindParts` counts cel opacity (`animated`, new skip reason `translucent`, cel opacity moves to the layer); `splitRegion` refuses `rig-block-order` when a pixel layer would change which pixels cover which, and `translucent` when translucent art would fold into a part as a variant. rig: `overlapMask` / `overlapMasks` / `checkOverlapPaint` count only fully opaque upper pixels on a layer of opacity 255 as hiding paint (`overlapMasks` takes `layerOpacity`); `attributeEdit` no longer overflows the stack on very large edits; `jointCheck` rejects a sweep with too many steps instead of spinning. raster: `ellipse` / `ellipsePixels` reach the last row of 84 flat sizes up to 24x24 (other sizes unchanged). ops: `rig.bindParts` and `part.split` descriptions list the new skip and refusal reasons.
- 9cfdc57: part.paintOverlap keeps the rest composite when two joint parts tie on z: `overlapMasks` takes `layerOrder`, so the mask uses the render's draw order.
- Updated dependencies [57e8121]
- Updated dependencies [9cfdc57]
- Updated dependencies [b9642b1]
- Updated dependencies [81ca754]
- Updated dependencies [eff07e8]
- Updated dependencies [de82d2f]
- Updated dependencies [a5112e2]
- Updated dependencies [ba84728]
- Updated dependencies [b63fa6e]
- Updated dependencies [2abc56f]
- Updated dependencies [f3ec9ec]
- Updated dependencies [3f62785]
- Updated dependencies [a2dbd50]
- Updated dependencies
  - @pixel-forge/rig@0.1.0
  - @pixel-forge/raster@0.1.0
  - @pixel-forge/schema@0.1.0
