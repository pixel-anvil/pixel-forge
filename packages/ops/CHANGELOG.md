# @pixel-forge/ops

## 0.1.0

### Minor Changes

- 1d5e510: CLI: hand-named commands on top of the registry wiring. `pf render <file>`, `pf export <file> <sheet.png>`, `pf lint <file>`, `pf override import|list|resolve`, `pf pack`, `pf unpack` take the document as a positional argument (animations as `group[/direction]`) and keep `--save`, `--confirm`, `--root`, `--home`, JSON on stdout and exit codes 0/1/2. `pf godot install <res-dir>` copies the Godot addon (excluding tests, replacing only `addons/pixel_forge`, refusing a folder without `project.godot`) from `bundle/addon`, which the build now fills. ops: new `override.import` (an edited PNG of a rig frame becomes overrides through `attributeEdit`; the attribution is shared with `pixels.writeGrid` in `frame-edit.ts`), `pxf.pack` and `pxf.unpack` (MCP `pxf_pack`, `pxf_unpack`, CLI `pf pack`, `pf unpack`).
- cf65db9: Operation API framework: defineOp, the registry (one transaction = one undo step labelled `AI: <op>`, validate guard, confirm for destructive ops), OpContext, OpError with mapping of core/io/rig errors, reference resolution by id or name, the OpHost interface with an in-memory host, generators for MCP tool JSON, CLI metadata and OPERATIONS.md, and the ops doc.open, doc.summary and rig.setPose. A change listener that throws after a commit is reported as a `warnings` entry, not as a failed call. core: `validate(view, {images})` limits the pixel content checks to the given images.
- d2cea32: Ops `pixels.readGrid` (per-call legend, rulers, at most 64x64), `pixels.writeGrid` (`.` transparent, `_` keep, at most 32x32, palette-checked; rig frames get overrides through `attributeEdit`, flat frames a layer cel), `render.frame` and `render.contactSheet` (PNG as `output.image`, long edge at most 1568, bone and pivot overlays). io: `contactSheet` takes a `rig` renderer and `contactSheetFrameOrigin` is exported. ops now depends on `raster` and `png`.
- 51f51bc: `rig.jointCheck` (MCP `rig_joint_check`) takes optional `rangeDeg`, `stepDeg` and `radius`, so a check can be narrowed. The defaults are unchanged.
- a6cd5ae: Ops with logic: `doc.create`, `doc.save`, `doc.setColorMode`, `anim.create`, `anim.update`, `frame.setMeta`, `layer.update`, `cel.link`, `part.split`, `part.paintOverlap`, `rig.bindParts`, `rig.editBones`, `rig.setPivot`, `rig.mirrorAnimation`, `rig.bake`, `override.list`, `override.resolve`, `io.import`, `io.export`. New: `confirmText` for destructive ops, core `paintOverlapTx` and `setColorMode`, `rig` option of `exportSpritesheet`.
- 400c35f: Ops that wrap existing functions: `doc.undo` and `doc.redo` (MCP `undo`/`redo`, history ops without a transaction), `frame.add`, `frame.delete` and `frame.duplicate`, `lint.run` (MCP `lint`, read-only), `rig.jointCheck` (MCP `rig_joint_check`, read-only) and `rig.applyTemplate` (MCP `rig_apply_template`).
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 57e8121: G1 gate review fixes. core: `bakeAnimation` inserts the baked layer at the top level (it no longer inherits a group's opacity, visibility or export flag) and hides the rig on every baked frame; `applySkeletonTemplate` refuses (`bone-mismatch`) a reused root whose template parent is missing; `deleteView` refuses (`view-in-use`) a view an authored animation resolves to; `bindParts` counts cel opacity (`animated`, new skip reason `translucent`, cel opacity moves to the layer); `splitRegion` refuses `rig-block-order` when a pixel layer would change which pixels cover which, and `translucent` when translucent art would fold into a part as a variant. rig: `overlapMask` / `overlapMasks` / `checkOverlapPaint` count only fully opaque upper pixels on a layer of opacity 255 as hiding paint (`overlapMasks` takes `layerOpacity`); `attributeEdit` no longer overflows the stack on very large edits; `jointCheck` rejects a sweep with too many steps instead of spinning. raster: `ellipse` / `ellipsePixels` reach the last row of 84 flat sizes up to 24x24 (other sizes unchanged). ops: `rig.bindParts` and `part.split` descriptions list the new skip and refusal reasons.
- 63d2950: G2 gate review fixes. io: a mirror animation with overrides is written with its root motion `dx` negated, so the Godot driver returns the right sign; `readPxf` reads override erase masks with transparent index 0 (a palette whose first alpha-0 entry was not 0 made valid overrides read as stale, or an all-255 mask erase nothing); `pack` takes only `images/<id>.png` (a `.DS_Store` no longer breaks the archive) and the render cache files, and refuses a symbolic link in the folder with the new error code `SYMLINK` (additive `DirEntry.isSymlink` on the `FileSystem` port); `buildPxf` returns `derivedChanged` and `readPxf` records `migratedFrom`. ops: `doc.save` rewrites an unchanged document whose file has no current render cache or an older schema version (`modified` is kept); `doc.open` takes the lock before it reads the file (new optional `OpHost.adoptFile`); `override.resolve` with `allStale` and `rebase` leaves overrides without a target out and lists them in `skipped`. server: workspace paths take the true letter case of the existing part (macOS case-insensitive volumes: one lock and one document per file). lint: render-based rules check the export render, like export and `override.list` (a frame whose art is only on a non-export layer is now reported by `anim.emptyFrame`). png: the decoder bounds the inflated size of `IDAT`.
- 2d2c699: Revise every MCP tool description after the M1a dogfood evaluation (T5.8): what a check does not catch, how keys interpolate and hold, the rest-angle rule, a `setRest` first example for `rig_edit_bones`, that overrides are for touch-ups, and tool names instead of op names. `undo` and `redo` no longer claim to be an undo step. The conventions line, the safety notes and the `doc` field text are shorter. No op, input or output changed.
- 9cfdc57: part.paintOverlap keeps the rest composite when two joint parts tie on z: `overlapMasks` takes `layerOrder`, so the mask uses the render's draw order.
- 4ff76c1: MCP stdio server on the official SDK (`createMcpServer`, `serveStdio`): the registry's ops as tools (image content, errors as tool results, `NOT_IMPLEMENTED` forwarding to a running `pf serve`, optional trace sink) and read-only `pf://` resources. `SERVER_PROTOCOL_VERSION` added. Ops: shorter tool descriptions (at most 800 characters), `toHex` exported.
- Updated dependencies [e816090]
- Updated dependencies [31f9724]
- Updated dependencies [65941c1]
- Updated dependencies [f3ec9ec]
- Updated dependencies [b923010]
- Updated dependencies [b63fa6e]
- Updated dependencies [57e8121]
- Updated dependencies [63d2950]
- Updated dependencies [51b41e2]
- Updated dependencies [c80c9ee]
- Updated dependencies [06533f8]
- Updated dependencies [6f5258c]
- Updated dependencies [d5a3f80]
- Updated dependencies [cf65db9]
- Updated dependencies [d2cea32]
- Updated dependencies [a6cd5ae]
- Updated dependencies [9cfdc57]
- Updated dependencies [637978d]
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
  - @pixel-forge/core@0.1.0
  - @pixel-forge/rig@0.1.0
  - @pixel-forge/raster@0.1.0
  - @pixel-forge/png@0.1.0
  - @pixel-forge/io@0.1.0
  - @pixel-forge/lint@0.1.0
  - @pixel-forge/schema@0.1.0
  - @pixel-forge/convert@0.1.0
