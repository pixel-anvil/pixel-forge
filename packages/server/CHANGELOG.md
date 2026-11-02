# @pixel-forge/server

## 0.1.0

### Minor Changes

- d7424c0: DocumentHost (an OpHost on the memory host plus lockfiles in `~/.pixel-forge/locks/<sha1(path)>.lock`, `DOC_LOCKED` with the owner's pid, stale-lock reclaim), `server.json` discovery helpers with stale detection by pid, workspace roots with symlink resolution so a link cannot escape a root, and an injectable base folder.
- 4ff76c1: MCP stdio server on the official SDK (`createMcpServer`, `serveStdio`): the registry's ops as tools (image content, errors as tool results, `NOT_IMPLEMENTED` forwarding to a running `pf serve`, optional trace sink) and read-only `pf://` resources. `SERVER_PROTOCOL_VERSION` added. Ops: shorter tool descriptions (at most 800 characters), `toHex` exported.
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- 63d2950: G2 gate review fixes. io: a mirror animation with overrides is written with its root motion `dx` negated, so the Godot driver returns the right sign; `readPxf` reads override erase masks with transparent index 0 (a palette whose first alpha-0 entry was not 0 made valid overrides read as stale, or an all-255 mask erase nothing); `pack` takes only `images/<id>.png` (a `.DS_Store` no longer breaks the archive) and the render cache files, and refuses a symbolic link in the folder with the new error code `SYMLINK` (additive `DirEntry.isSymlink` on the `FileSystem` port); `buildPxf` returns `derivedChanged` and `readPxf` records `migratedFrom`. ops: `doc.save` rewrites an unchanged document whose file has no current render cache or an older schema version (`modified` is kept); `doc.open` takes the lock before it reads the file (new optional `OpHost.adoptFile`); `override.resolve` with `allStale` and `rebase` leaves overrides without a target out and lists them in `skipped`. server: workspace paths take the true letter case of the existing part (macOS case-insensitive volumes: one lock and one document per file). lint: render-based rules check the export render, like export and `override.list` (a frame whose art is only on a non-export layer is now reported by `anim.emptyFrame`). png: the decoder bounds the inflated size of `IDAT`.
- Updated dependencies [1d5e510]
- Updated dependencies [57e8121]
- Updated dependencies [63d2950]
- Updated dependencies [51b41e2]
- Updated dependencies [c80c9ee]
- Updated dependencies [06533f8]
- Updated dependencies [6f5258c]
- Updated dependencies [2d2c699]
- Updated dependencies [cf65db9]
- Updated dependencies [d2cea32]
- Updated dependencies [51f51bc]
- Updated dependencies [a6cd5ae]
- Updated dependencies [400c35f]
- Updated dependencies [9cfdc57]
- Updated dependencies [4ff76c1]
- Updated dependencies
  - @pixel-forge/ops@0.1.0
  - @pixel-forge/io@0.1.0
