---
'@pixel-forge/png': patch
'@pixel-forge/io': patch
'@pixel-forge/lint': patch
'@pixel-forge/ops': patch
'@pixel-forge/server': patch
---

G2 gate review fixes. io: a mirror animation with overrides is written with its root motion `dx` negated, so the Godot driver returns the right sign; `readPxf` reads override erase masks with transparent index 0 (a palette whose first alpha-0 entry was not 0 made valid overrides read as stale, or an all-255 mask erase nothing); `pack` takes only `images/<id>.png` (a `.DS_Store` no longer breaks the archive) and the render cache files, and refuses a symbolic link in the folder with the new error code `SYMLINK` (additive `DirEntry.isSymlink` on the `FileSystem` port); `buildPxf` returns `derivedChanged` and `readPxf` records `migratedFrom`. ops: `doc.save` rewrites an unchanged document whose file has no current render cache or an older schema version (`modified` is kept); `doc.open` takes the lock before it reads the file (new optional `OpHost.adoptFile`); `override.resolve` with `allStale` and `rebase` leaves overrides without a target out and lists them in `skipped`. server: workspace paths take the true letter case of the existing part (macOS case-insensitive volumes: one lock and one document per file). lint: render-based rules check the export render, like export and `override.list` (a frame whose art is only on a non-export layer is now reported by `anim.emptyFrame`). png: the decoder bounds the inflated size of `IDAT`.
