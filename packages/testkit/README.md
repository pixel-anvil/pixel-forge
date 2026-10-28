# @pixel-forge/testkit

Shared test helpers: ASCII fixtures, golden comparison, golden sheets, fixture runner (private, not
published, Node-only; not a pure package).

**Depends on:** `png`

**Status:** implemented (T0.3)

Images are `TestImage = { width, height, data: Uint8Array }` (RGBA8, row-major, top-left, straight
alpha), the `png` `PngImage` shape without `kind`.

## API

| Function                                          | Purpose                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hashRGBA(img)`                                   | SHA-256 hex over `uint32be width`, `uint32be height`, then the raw RGBA bytes (no PNG container bytes).                                                              |
| `expectGolden(name, img, opts?)`                  | Compare with `__golden__/<name>.png` next to the test file (decoded-RGBA hash, NFR-02).                                                                              |
| `asciiToImage(ascii, legend)`                     | Hand-written ASCII to image. `.` is transparent unless the legend overrides it. Strips blank edge lines and common indent. Ragged rows throw `AsciiError('RAGGED')`. |
| `imageToAscii(img, legend, { unknown? })`         | Reverse. Unknown colours throw `UNKNOWN_COLOUR` (listing them) or print `?` with `{ unknown: '?' }`. Any alpha-0 pixel maps to the transparent character.            |
| `expectAscii(img, ascii, legend)`                 | Assert; failure shows expected / actual side by side plus coordinates of the first differing pixels.                                                                 |
| `goldenSheet(images, { scale = 8, grid = true })` | Labelled review sheet: nearest-neighbour upscale, checkerboard behind transparency, 1-px grid, built-in 3x5 font. Size via `sheetSize`.                              |
| `runFixtures` / `checkFixtures`                   | The engine behind `pnpm fixtures` / `pnpm fixtures:check`.                                                                                                           |

### Goldens

- Location: `<dir of the test file>/__golden__/<name>.png`. Pass `{ testFile: import.meta.url }` for
  certainty; the default is Vitest's `expect.getState().testPath`. `opts.goldenDir` overrides.
- Mismatch: writes `<name>.actual.png`, `<name>.expected.png`, `<name>.diff.png` to the repo-root
  `.golden-diff/` (gitignored; override with `opts.diffDir` or env `PF_GOLDEN_DIFF_DIR`), and fails with both
  hashes and the differing-pixel count. Diff colours: magenta = pixel differs, cyan = only alpha differs,
  grey = equal. Size changes compare over the union, outside pixels count as different.
- `UPDATE_GOLDEN=1` writes or overwrites the golden, prints a notice, and passes. A missing golden without it fails.

### Reviewing goldens

1. `pnpm golden:sheet <name>` builds `.golden-diff/sheet-<name>.png` (x8, grid, labelled) from
   `__golden__/<name>.png`, `fixtures/**/<name>.png` and `.golden-diff/<name>.{expected,actual,diff}.png`.
   A glob (`pnpm golden:sheet 'packages/raster/test/__golden__/*.png'`) works too; `--scale N` changes the zoom.
2. Open the sheet and look at it. Only then write "golden reviewed" on the card.
3. Accept intended changes with `UPDATE_GOLDEN=1 pnpm --filter <pkg> test` and a note on the card.

### Fixtures

`pnpm fixtures` builds the testkit and runs every `fixtures/src/*.ts|*.mjs` in sorted order with Node
(type stripping). Each generator: `export default async function generate(ctx)` with
`ctx = { root, writePng(rel, img), writeJson(rel, obj), writeFile(rel, bytes) }`, paths relative to `fixtures/`
(a path `../godot/...` writes into the repository's `godot/` folder, the only place outside `fixtures/` allowed;
`fixtures:check` compares those files too); a throwing
generator fails the run. `pnpm fixtures:check` regenerates into a temp dir and fails if committed
outputs are missing or differ. Generators must be deterministic and import nothing from the repo
(use `ctx`). See `fixtures/src/example-checker.ts`.
