# @pixel-forge/rig

## 0.1.0

### Minor Changes

- de82d2f: Edit attribution (FR-RIG-22/24): `attributeEdit(ctx, before, edited)` turns an edited frame into part overrides (an edit inside exactly one part's footprint that shows through the composite) and a final override for the rest, with 8-bit erase masks (`IndexedImage`, 255), pivot-relative or canvas anchors and `baseHash` taken as `checkOverride` checks it (rig); `attributeEditTx(tx, animRef, frameRef, edited)` builds the context from the export render and writes the overrides, the entry point of `pf override import` (core); `attributeEditTxReport` also lists the existing overrides (this frame, and its mirrors') that the import made stale. `EditContext.finalOnly` and `RigError` code `BAD_ARGUMENT` (reason `before-mismatch`) are additive.
- a5112e2: FK with exact key interpolation and quantisation, hierarchical snapping (ADR-012), prepareAnimation/PreparedAnimation; schema exports isValidAngleQuantum and angleQuantumSteps.
- ba84728: Joint check (FR-RIG-05, `docs/contracts/JOINT_CHECK.md`): `jointGaps` (the pure predicate on alpha masks, checked against the hand-written `fixtures/joint` oracles), `jointCheck` (sweeps every joint of a rig through `renderParts` and reports gap pixels with exact coordinates), `JOINT_RADIUS_DEFAULT`, and `JointCheckError` (`SIZE_MISMATCH`, `BAD_ANGLE`, `BAD_RADIUS`, `BAD_PIVOT`).
- b63fa6e: Overlap mask (FR-RIG-07, `docs/contracts/JOINT_CHECK.md` section 7): `overlapMask` (the pure mask of pixels that can be painted on the lower part to close a joint's gaps without changing the composite at rest), `overlapMasks` (every joint of a rig with gaps, from the same sweep as `jointCheck`), `checkOverlapPaint` (reports paint outside the mask) and the `AMBIGUOUS_PARTS` / `ROTATED_REST` joint-check error codes.
- 2abc56f: Part render pipeline: `renderParts` (variants, RotSprite on the snapped pivot, `(variant, angle)` cache, part overrides), `baseHash` over the override bbox ±1, `staleOverrides`, `rebase`, `discard`, and the shared `paintOverride`, `maskAt`, `unionRect`, `PART_RENDER_KEY` (rig); `ROTSPRITE_VERSION` (raster); `createRigRenderer` as the `renderFrame` rig hook with an optional `RigRenderer.renderKey`, `checkOverrides` (per-override `reason: 'error'` when a render fails), `rebaseOverrides`, `discardOverrides`, and a narrower rig input in `renderInputKey` for renderers that give a `renderKey` (core).
- f3ec9ec: Pose clipboard: `copyPose`, `pastePose({mirrored})` (swaps `_l`/`_r` bones, negates angles and offset x) and `mirrorBoneName`.
- 3f62785: Humanoid skeleton templates, part layer name parsing, bind by overlap (rig); bone/view CRUD, rest poses, pivots, applySkeletonTemplate and bindParts transactions (core).
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 57e8121: G1 gate review fixes. core: `bakeAnimation` inserts the baked layer at the top level (it no longer inherits a group's opacity, visibility or export flag) and hides the rig on every baked frame; `applySkeletonTemplate` refuses (`bone-mismatch`) a reused root whose template parent is missing; `deleteView` refuses (`view-in-use`) a view an authored animation resolves to; `bindParts` counts cel opacity (`animated`, new skip reason `translucent`, cel opacity moves to the layer); `splitRegion` refuses `rig-block-order` when a pixel layer would change which pixels cover which, and `translucent` when translucent art would fold into a part as a variant. rig: `overlapMask` / `overlapMasks` / `checkOverlapPaint` count only fully opaque upper pixels on a layer of opacity 255 as hiding paint (`overlapMasks` takes `layerOpacity`); `attributeEdit` no longer overflows the stack on very large edits; `jointCheck` rejects a sweep with too many steps instead of spinning. raster: `ellipse` / `ellipsePixels` reach the last row of 84 flat sizes up to 24x24 (other sizes unchanged). ops: `rig.bindParts` and `part.split` descriptions list the new skip and refusal reasons.
- 9cfdc57: part.paintOverlap keeps the rest composite when two joint parts tie on z: `overlapMasks` takes `layerOrder`, so the mask uses the render's draw order.
- Updated dependencies [57e8121]
- Updated dependencies [b9642b1]
- Updated dependencies [81ca754]
- Updated dependencies [eff07e8]
- Updated dependencies [a5112e2]
- Updated dependencies [2abc56f]
- Updated dependencies [a2dbd50]
- Updated dependencies
  - @pixel-forge/raster@0.1.0
  - @pixel-forge/schema@0.1.0
