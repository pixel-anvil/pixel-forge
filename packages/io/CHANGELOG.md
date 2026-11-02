# @pixel-forge/io

## 0.1.0

### Minor Changes

- 51b41e2: `.aseprite` to document mapping (`createDocumentFromAseprite`, `importAsepriteTx`): tags become animations, untagged frames `default`, overlapping tags and Aseprite linked cels become one-hop links, `part:` layers become parts and variants through `bindParts`, the palette is imported. In-place re-import (`reimportAsepriteTx`, `reimportAseprite`) matches layers and parts by name and frames by `(tag, index)`, keeps bindings, pivots and keys, appends added frames without keys, and reports removed frames. io now depends on `rig` (part-layer name parsing).
- c80c9ee: Add a pure `.aseprite` binary parser (`parseAseprite`) with typed `AseError`s and RGBA conversion helpers.
- 06533f8: `.pxf` read/write (deterministic ZIP, canonical JSON), forward-only migration registry, per-frame render cache with incremental reuse, atomic save, pack/unpack to `.pxfd/`, the `FileSystem` and `Clock` ports with an in-memory fake, and the `@pixel-forge/io/node` adapter entry point.
- 6f5258c: Spritesheet import (`importSpritesheetTx`, `createDocumentFromSpritesheet`, `cc0SheetInputs`), spritesheet + Aseprite hash-format JSON export (`exportSpritesheet`) and labelled contact sheet (`contactSheet`).
- d2cea32: Ops `pixels.readGrid` (per-call legend, rulers, at most 64x64), `pixels.writeGrid` (`.` transparent, `_` keep, at most 32x32, palette-checked; rig frames get overrides through `attributeEdit`, flat frames a layer cel), `render.frame` and `render.contactSheet` (PNG as `output.image`, long edge at most 1568, bone and pivot overlays). io: `contactSheet` takes a `rig` renderer and `contactSheetFrameOrigin` is exported. ops now depends on `raster` and `png`.
- a6cd5ae: Ops with logic: `doc.create`, `doc.save`, `doc.setColorMode`, `anim.create`, `anim.update`, `frame.setMeta`, `layer.update`, `cel.link`, `part.split`, `part.paintOverlap`, `rig.bindParts`, `rig.editBones`, `rig.setPivot`, `rig.mirrorAnimation`, `rig.bake`, `override.list`, `override.resolve`, `io.import`, `io.export`. New: `confirmText` for destructive ops, core `paintOverlapTx` and `setColorMode`, `rig` option of `exportSpritesheet`.
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 63d2950: G2 gate review fixes. io: a mirror animation with overrides is written with its root motion `dx` negated, so the Godot driver returns the right sign; `readPxf` reads override erase masks with transparent index 0 (a palette whose first alpha-0 entry was not 0 made valid overrides read as stale, or an all-255 mask erase nothing); `pack` takes only `images/<id>.png` (a `.DS_Store` no longer breaks the archive) and the render cache files, and refuses a symbolic link in the folder with the new error code `SYMLINK` (additive `DirEntry.isSymlink` on the `FileSystem` port); `buildPxf` returns `derivedChanged` and `readPxf` records `migratedFrom`. ops: `doc.save` rewrites an unchanged document whose file has no current render cache or an older schema version (`modified` is kept); `doc.open` takes the lock before it reads the file (new optional `OpHost.adoptFile`); `override.resolve` with `allStale` and `rebase` leaves overrides without a target out and lists them in `skipped`. server: workspace paths take the true letter case of the existing part (macOS case-insensitive volumes: one lock and one document per file). lint: render-based rules check the export render, like export and `override.list` (a frame whose art is only on a non-export layer is now reported by `anim.emptyFrame`). png: the decoder bounds the inflated size of `IDAT`.
- Updated dependencies [e816090]
- Updated dependencies [31f9724]
- Updated dependencies [65941c1]
- Updated dependencies [f3ec9ec]
- Updated dependencies [b923010]
- Updated dependencies [b63fa6e]
- Updated dependencies [57e8121]
- Updated dependencies [63d2950]
- Updated dependencies [cf65db9]
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
  - @pixel-forge/schema@0.1.0
  - @pixel-forge/convert@0.1.0
