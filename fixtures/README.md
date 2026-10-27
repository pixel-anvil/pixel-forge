# fixtures

Test inputs shared by the packages. Everything here is synthetic or CC0; never commit licensed or
third-party game art. Prettier and ESLint ignore this folder.

- `cc0/`: third-party art released under CC0, each pack with its licence file.
- `generated/`: output of the committed generator scripts in `src/`. Rebuild with `pnpm fixtures`;
  `pnpm fixtures:check` fails when a file drifts.
- `frozen/`: files frozen at a schema version (for example `frozen/v1/minimal-document.json`). Never
  regenerated; future migrations must keep them opening.
- `src/`: the generator scripts for `generated/`.
