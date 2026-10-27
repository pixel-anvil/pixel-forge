# @pixel-forge/io

.pxf read/write and migrations, render cache, PNG/GIF/JPEG/WebP codecs, spritesheet JSON and .aseprite import. Takes a FileSystem port.

**Depends on:** `core`, `convert`, `png`, plus `schema` and `raster` (types and images; the dependency-cruiser table was extended for this in T4.3)

**Status:** spritesheet import/export and contact sheet (T4.3). `.pxf`, `.aseprite` and the `FileSystem` port: later cards.

The T4.3 functions are pure byte-in/byte-out (PNG bytes, objects, `TiledImage`); no Node built-ins, no port needed.

## Spritesheet import (FR-DOC-05)

```ts
import { createDocumentFromSpritesheet, importSpritesheetTx } from '@pixel-forge/io';

const { store, result } = createDocumentFromSpritesheet({
  png, // Uint8Array
  cell: [64, 64],
  animations: [{ group: 'run', direction: 'side', frames: [[2, 3], [2, 4], [2, 5]], fps: 12 }],
  outlinePng, // optional, same pixel size: becomes layer "outline" above "body"
});
store.transact('More', (tx) => importSpritesheetTx(tx, { png: other, cell: [64, 64], animations: [...] }));
```

- `frames` are `[row, col]` cells in playback order. Duration: `durationMs`, else `fps` (`round(1000/fps)`), else `defaultDurationMs` (100).
- A fully transparent cell gives a frame without a cel; a cell repeated within one import becomes a `linkTo` cel.
- Layers `body` / `outline` (`layerName`, `outlineLayerName`): an existing top-level pixel layer of that name is reused, else created on top.
- **Origin default:** `createDocumentFromSpritesheet` makes a canvas of the cell size and origin = bottom-centre pixel `(floor(w/2), h-1)` (`defaultOrigin`); override with `options.origin`. On any document a cel is placed so the cell's bottom-centre lands on `meta.origin` (`cellOffset`), i.e. offset `(0, 0)` for the default.
- `cc0SheetInputs(json, readPng, opts)` adapts `fixtures/cc0` `sheet.json` (`{cell, animations: {name: {file, frames}}}`, one PNG per animation) into one input per animation; import them all into one document.
- Errors are `IoError` (`BAD_INPUT`, `CELL_OUT_OF_RANGE`, `SIZE_MISMATCH`, `DUPLICATE_ANIMATION`, `TOO_LARGE`); input is validated before the transaction is touched.

## Spritesheet export (FR-DOC-06)

`exportSpritesheet(view, { animations?, layout: 'rows' | 'packed', scale = 1, skin?, exportOnly = true, imageName? }) -> { png, json }`.

- `rows`: one row per animation. `packed`: reading-order near-square grid (`ceil(sqrt(n))` columns); no trimming, rotation or de-duplication.
- JSON is Aseprite's `--format json-hash`: `frames` keyed `"<tag> <n>"` (`tag` = `group` or `group/direction`, `n` = 0-based index in the animation; identical to Aseprite's `--filename-format '{tag} {tagframe}'`), each with `frame`, `rotated`, `trimmed`, `spriteSourceSize`, `sourceSize`, `duration`; `meta` with `app`, `version`, `image`, `format: "RGBA8888"`, `size`, `scale: "1"` (as Aseprite writes it even with `--scale`) and `frameTags` (`name`, `from`, `to` as sheet indices, `direction` `forward`, or `pingpong` for pingpong animations; `once` exports `forward`).
- Not emitted (Aseprite does, on request): `meta.layers`, `meta.slices`, `frameTags[].color`. `meta.app` is `pixel-forge`.
- Oracle: `test/oracle/` (Aseprite CLI output, generator `make-oracle.sh` + `make-oracle.lua`).

## Contact sheet (FR-AI-12)

`contactSheet(view, { animations?, scale?, labels = true, maxLongEdge = 1568, skin?, overlay?: { origin?, markers? } }) -> TiledImage`.

Frames on a grey checkerboard, integer scale (default: the largest 1..16 that fits), label `group/direction #n` (0-based) in a 3x5 bitmap font under each frame (a copy of the testkit font in `src/font.ts`, so io has no dev-only dependency), 2 px gutter. If the requested scale (or a label width) does not fit `maxLongEdge`, the scale (then the font scale 2 -> 1) is reduced; the column count is chosen to minimise the long edge. `contactSheetPlan` returns the layout without rendering. `TOO_LARGE` if even scale 1 does not fit.
