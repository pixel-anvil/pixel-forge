# @pixel-forge/io

.pxf read/write and migrations, render cache, PNG/GIF/JPEG/WebP codecs, spritesheet JSON and .aseprite import. Takes a FileSystem port.

**Depends on:** `core`, `convert`, `png`, plus `schema` and `raster` (types and images; the dependency-cruiser table was extended for this in T4.3)

**Status:** spritesheet import/export and contact sheet (T4.3); `.aseprite` parser (T4.4); `.pxf` read/write, migrations, render cache, atomic save, pack/unpack and the `FileSystem` / `Clock` ports (T4.2).

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

**Status:** scaffold

## `.aseprite` parser (`aseprite/`)

`parseAseprite(bytes: Uint8Array): AseFile` is a pure parser (no Node built-ins, little-endian `DataView`, zlib via fflate) written from the published file-format specification only. It produces the header, frames (`durationMs`, decoded `chunks`, `cels`, effective `palette`), `layers`, `tags`, `slices`, the palette and the colour profile. Mapping to a pixel-forge document is a separate step (T4.5).

- **Decoded chunks:** layer 0x2004, cel 0x2005 (raw, linked, compressed image, compressed tilemap as header only), cel extra 0x2006, colour profile 0x2007, tags 0x2018, palette 0x2019, old palettes 0x0004 and 0x0011 (used only when no 0x2019 exists), user data 0x2020, slice 0x2022. Recognised but skipped with a note: external files 0x2008, mask 0x2016, path 0x2017, tileset 0x2023. Any other chunk type is skipped by its size (`kind: 'unknown'`).
- **Layers:** `opacity` is the effective value. The header flag "layer opacity valid" (1) is honoured, and for groups also flag 2; `opacityRaw` keeps the stored byte. `parentIndex` is derived from the child level. `visible` is the layer's own flag (a hidden group also hides its children).
- **User data** attaches to the object of the preceding chunk: layer, cel (a cel-extra chunk in between does not change that), slice; the chunks after a tags chunk go to the tags in order; the one after the first-frame palette is the sprite's. Text and colour are stored; the properties block is kept as raw bytes. Every user-data chunk also stays in `frame.chunks` with its `target`.
- **Pixels:** cels keep their raw form (`AseImage`: RGBA 4 bytes, grayscale value+alpha 2 bytes, or palette indices 1 byte). `aseImageToRgba` and `aseCelToRgba` convert to straight-alpha RGBA8 (grayscale to gray RGBA; indexed through the frame's palette). **Indexed transparency:** the header's transparent index is transparent only on non-background layers; on a background layer (layer flag 8) it is an ordinary colour. Indices beyond the palette render transparent. A linked cel resolves to its source cel, and position and opacity come from the source. Cel and layer opacity are reported, not baked into the pixels.
- **Errors:** every failure is an `AseError` with a `code`: `BAD_MAGIC`, `TRUNCATED` (input ends early, including fewer frames than the header says), `BAD_HEADER`, `BAD_CHUNK`, `DECOMPRESS_FAILED`, `UNSUPPORTED`, `TOO_LARGE`. Reads are bounds-checked per chunk. Limits: canvas up to 16384 x 16384, 65535 frames, 512 MiB of decoded cel pixels in total. A cel's inflated size must equal `width * height * bytes-per-pixel`, and inflation never allocates more than that plus one byte.
- **Oracles:** tests compare against the Aseprite CLI output in `fixtures/aseprite/` (`*.expected.json` and one PNG per layer and frame).

## `.pxf` read/write, render cache, atomic save, pack/unpack (T4.2)

```ts
import { buildPxf, readPxf, saveAtomic, pxfStore } from '@pixel-forge/io';
import { nodeFileSystem, systemClock } from '@pixel-forge/io/node'; // Node adapter, separate entry point

const fs = nodeFileSystem();
const file = readPxf(await fs.readFile('hero.pxf')); // PxfFile: manifest, doc, images, renderIndex?, renderPngs, warnings
const store = pxfStore(file); // a DocumentStore; edit it ...
const built = buildPxf(store, { clock: systemClock, previous: file, rig }); // { bytes, file, changed, renderedFrames, reusedFrames }
await saveAtomic(fs, 'hero.pxf', built.bytes); // temp file + rename; pass `built.file` as `previous` next time
```

- **API:** `readPxf(bytes, {migrations?, targetVersion?}) -> PxfFile`; `writePxf(view, opts) -> Uint8Array` and `buildPxf(view, opts)` (same, plus the in-memory file and counters); `view` is a store or snapshot. Options: `clock` (required `Clock` port), `renderCache` (default `true`), `skins` (document skin names besides `base`; default all), `previous`, `rig` (a core `RigRenderer`), `app`. Also `pxfStore`, `pxfView`, `pxfContentHash`, `buildRenderCache`, `saveAtomic(fs, path, bytes, {nonce?})`, `pack(fs, pxf, dir)`, `unpack(fs, pxf, dir, {overwrite?})`, `migrate` / `MIGRATIONS`, `canonicalPretty`, `buildZip` / `readZip`, `MemoryFileSystem`, `fixedClock`, `steppedClock`. Errors are `IoError` (`BAD_PXF`, `INVALID_DOCUMENT`, `UNSUPPORTED_VERSION`, `MIGRATION_MISSING`, `MIGRATION_FAILED`, `RIG_REQUIRED`, `FS_FAILED`, `EXISTS`, `BAD_INPUT`).
- **Ports:** `FileSystem` (`readFile`, `writeFile`, `rename`, `remove`, `exists`, `mkdirp`, `readdir`; POSIX paths, async) and `Clock` (`now(): Date`) are in `src/fs.ts`. The main entry point imports no Node built-in (eslint and dependency-cruiser enforce it for `packages/io/src`, except `src/node.ts`). `@pixel-forge/io/node` exports `nodeFileSystem()` and `systemClock` for the CLI and tests; the full implementation with workspace roots and lockfiles is `server`'s (T5.4). Lockfiles and the journal never live in the `.pxf` (spec 6.5).
- **Byte stability (NFR-03):** the output is a pure function of document, images, options and the clock reading. JSON is canonical (keys sorted by code unit at every level, 2-space indent, LF, trailing newline), images and frames use the deterministic `png` encoder, and the ZIP is built by `fflate` with fixed settings. Reading and writing again with `previous` (or from scratch with the same clock) gives identical bytes. This holds within one pixel-forge version: `manifest.app` carries the version, and an encoder upgrade may change PNG bytes (an opened file keeps its stored PNG bytes until a pixel changes).
- **ZIP details:** entry order is `manifest.json`, `document.json`, `images/<id>.png` (sorted), `render/index.json`, `render/<skin>/<group>/<direction>/<n>.png` (sorted by full path). `*.json` entries are **deflated** (method 8, `fflate` level 9, mem 8); `*.png` entries are **stored** (method 0) because PNG data is already deflate-compressed. Godot's `ZIPReader`, `unzip` and every ZIP library read both. Every entry has the DOS timestamp of `manifest.modified` read as UTC (2 s resolution; `fflate` formats `mtime` in local time, so the DOS fields are overwritten after `zipSync` and the bytes do not depend on the time zone). No extra fields, comments, ZIP64 or data descriptors. A test checks the archive with the independent `unzip` CLI (skipped when absent).
- **Images:** `TiledImage` is written as an RGBA8 PNG, `IndexedImage` as an 8-bit grayscale PNG of its indices; reading maps them back by PNG type. A grayscale PNG stores no transparent index, so an `IndexedImage` read from a file gets `transparentIndex` = the first alpha-0 entry of the active palette (else 0). Every image the view holds is written (including unreferenced ones); a referenced image missing from the archive is `BAD_PXF`.
- **`created` / `modified`:** `created` is set once (the clock on the first save, then taken from `previous`). `modified` is the clock reading when `documentHash(view)` differs from `previous`'s, else `previous`'s value, so a no-op save of an opened file is byte-identical. Timestamps are UTC ISO 8601 with `Z`, whole seconds. Without `previous`, both come from the clock. Toggling only the render cache does not change `modified`. Pure code never reads the system clock; callers inject the `Clock`.
- **Render cache** (spec 3.4 clarifications 1, 3, 4, 10): for every animation, direction and skin, each frame is rendered with `renderFrame(..., { exportOnly: true, skin })` (only export layers) and written as an RGBA PNG at `render/<skin>/<group>/<direction>/<n>.png` (`n` = 0-based frame index; undirected animations use direction `default`; the unskinned render is skin `base`, listed first, then the document skins in order). `render/index.json` follows the `RenderIndex` schema; `image` is relative to `render/<skin>/`. A frame's `hash` is its core `renderInputKey` (for `base` alone), or, with skins, the SHA-256 of the keys of all rendered skins joined by newlines, so a skin edit invalidates the frame. Frames with equal hashes share the PNG of the first one (sorted group, direction, index order), across animations too. A mirror animation **without** overrides is `{ loop, mirrorOf: <source direction key> }` with no PNGs; a mirror **with** overrides is a normal entry (the source's frames, rendered through the mirror) whose markers are mirrored (`x' = 2 * origin.x - x`). Part layers need a `rig` renderer (T3.3); without one `RIG_REQUIRED` is thrown (use `renderCache: false` for scratch files). A mirror's own part overrides are not in the render key until T3.6.
- **Incremental saves:** with `previous`, a frame whose hash is in the previous index reuses those PNG bytes instead of rendering (`reusedFrames` vs `renderedFrames`); unchanged images reuse their stored PNG bytes. The hash is only as complete as `renderInputKey`: if the rig renderer's behaviour changes without a document change, omit `previous` to force a full re-render.
- **Reading:** `readPxf` accepts its own output, ignores unknown entries, validates with the schema (`Document`, `Manifest`, `RenderIndex`) and applies the **migration registry**: `MigrationRegistry = Record<fromVersion, (json: { manifest, document }) => { manifest, document }>`, forward only, one step per version, run on raw JSON before validation. v1 is the baseline, so `MIGRATIONS` is empty; the frozen fixture `fixtures/frozen/v1/minimal-document.json` must keep opening. A file with a newer `schemaVersion` is rejected with `UNSUPPORTED_VERSION`. A migrated file loses its render cache (derived data, rebuilt on the next save). A broken render cache is dropped with an entry in `warnings` instead of failing the open.
- **Atomic save (FR-DOC-01):** `saveAtomic` writes `<path>.tmp-<nonce>` next to the target (default nonce: first 12 hex digits of the SHA-256 of the bytes; pass a pid or counter if you prefer), then renames it over the target. If the write or rename fails, the temp file is removed and the original is untouched; the error is `IoError('FS_FAILED')` with the cause. The port has no `fsync`.
- **`pack` / `unpack`:** `unpack` expands a `.pxf` into `<name>.pxfd/` (one file per ZIP entry, bytes verbatim) plus an empty `.gdignore` at its root; an existing folder is an error unless `overwrite`. `pack` rebuilds the `.pxf` from `manifest.json`, `document.json`, `images/**` and `render/**` (anything else, including `.gdignore`, is ignored) with the same deterministic writer, so `pack(unpack(x))` is byte-identical to any `x` written by this build (not necessarily to files from other tools).
