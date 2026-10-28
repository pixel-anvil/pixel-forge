# fixtures

Test inputs shared by the packages. Everything here is synthetic or CC0; never commit licensed or
third-party game art. Prettier and ESLint ignore this folder.

- `cc0/`: third-party art released under CC0, each pack with its licence file.
- `generated/`: output of the committed generator scripts in `src/`. Rebuild with `pnpm fixtures`;
  `pnpm fixtures:check` fails when a file drifts.
- `frozen/`: files frozen at a schema version (for example `frozen/v1/minimal-document.json`). Never
  regenerated; future migrations must keep them opening.
- `src/`: the generator scripts for `generated/`.
- `src/godot.ts` writes the Godot importer's test fixtures into `../godot/test/fixtures/` (outside this folder;
  generators may write under `../godot/` only): `walker.pxf` (RGBA; two directions, a mirror, markers, events, root
  motion, trimmed and empty frames, a shared PNG), `skins.pxf` (indexed; a palette skin and a remap skin) and
  `expected.json` (facts computed from the generator's rectangle lists, used as the GUT oracle). `pnpm fixtures:check`
  covers them.
- `generated/hero.pxf`: the synthetic 48x48 humanoid (T3.9) from `src/hero.ts`. Its Aseprite twin is
  `aseprite/hero_parts.aseprite` (`src/aseprite/hero_parts.lua`).
