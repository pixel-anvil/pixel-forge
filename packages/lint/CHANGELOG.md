# @pixel-forge/lint

## 0.1.0

### Minor Changes

- d5a3f80: lint(doc, opts): structured findings for palette (render output, per skin), opacity in locked documents, orphan pixels, joint gaps, stale and failing overrides, empty frames; rotationResidual registered as a stub.
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
- Updated dependencies [cf65db9]
- Updated dependencies [a6cd5ae]
- Updated dependencies [9cfdc57]
- Updated dependencies [de82d2f]
- Updated dependencies [a5112e2]
- Updated dependencies [ba84728]
- Updated dependencies [b63fa6e]
- Updated dependencies [2abc56f]
- Updated dependencies [f3ec9ec]
- Updated dependencies [3f62785]
- Updated dependencies
  - @pixel-forge/core@0.1.0
  - @pixel-forge/rig@0.1.0
