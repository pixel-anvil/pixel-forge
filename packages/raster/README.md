# @pixel-forge/raster

Sparse tiled images, compositing, primitives, transforms, RotSprite, dithering and fixed-point trig.

**Depends on:** `schema` (for `TILE_SIZE`), `color` (declared, not used yet). Pure: no Node built-ins, no `Math.random`, no `Date.now`, integer maths only (NFR-02).

**Status:** core implemented (T1.4): images, `composite`, `blit`, whole-image transforms, `hashRGBA`. Primitives (T1.5), RotSprite and trig (T1.6), orphan/outline passes (T1.7) are later cards.

## API

| Area                 | Exports                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RGBA image           | `TiledImage(w, h)`: `get`, `set`, `bounds`, `clone`, `toRGBA`, `TiledImage.fromRGBA({width,height,data})`, `hashRGBA()`                                                                          |
| Indexed image        | `IndexedImage(w, h, transparentIndex = 0)`: `get`, `set`, `bounds(isTransparent?)`, `clone`, `toIndices`, `toRGBA(palette)`, `IndexedImage.fromIndices`                                          |
| Both (`SparseImage`) | `width`, `height`, `version`, `tilesChanged(since)`, `tiles()`, `tileCount`, `byteSize()`, `captureTiles`, `restoreTiles`, `compact()`, `clear()`, `equals()`, `emptyLike()`                     |
| Blending             | `composite(dst, src, {x, y, opacity})`, `blendOver`, `div255`, `blit(dst, src, x, y, {replace})`                                                                                                 |
| Transforms           | `flipH`, `flipV`, `rot90` (clockwise), `rot180`, `rot270`, `scaleInt(img, k)`, `crop(img, rect)`, `translate(img, dx, dy)`; all return a new image of the same kind and work on both image types |
| Hashing              | `hashRGBA({width,height,data})`, `sha256Hex(bytes)`                                                                                                                                              |
| Errors               | `RasterError` with `code`: `BAD_SIZE`, `NON_INTEGER`, `BAD_VALUE`, `BAD_DATA`, `BAD_TILE`, `MISMATCH`, `SAME_IMAGE`                                                                              |

Coordinates are integers, origin top-left, y down (AGENTS.md). Rotations are clockwise.

### Out of bounds and errors

- `get` outside the image returns transparent (`[0,0,0,0]` / `transparentIndex`).
- `set` outside the image is a **no-op that returns `false`** (`true` when in bounds), so brushes and stamps can overhang the canvas. Composite, blit, crop and translate clip the same way.
- Programmer errors (non-integer coordinates, channel/opacity outside 0..255, bad sizes, mismatched kinds) throw a typed `RasterError`; they are never silently clamped.

### `hashRGBA`

Implemented with a small pure SHA-256 (`sha256.ts`), so `raster` needs no `node:crypto` and runs in the browser. The layout is the testkit one (ADR-010): `uint32be width`, `uint32be height`, raw RGBA8 bytes; a test checks equality with testkit's `hashRGBA` and `node:crypto` across the padding boundaries. Colour under alpha 0 is part of the hash: `TiledImage` stores exactly what is written and never normalises it.

## Tiles and copy-on-write

- `TILE_SIZE = 16` (from `schema`). A tile is `16*16*4 = 1024` bytes (RGBA) or `256` bytes (indexed), row-major; pixel `(x, y)` lives in tile `(x >> 4, y >> 4)` at offset `(((y & 15) << 4) | (x & 15)) * channels`. Edge tiles are full-size; the part outside the image is never written.
- An **absent tile is empty**: `(0,0,0,0)` for RGBA, `transparentIndex` for indexed. A tile is allocated by the first write of a non-empty value. Writing an empty value into an absent tile, or writing the value already stored, allocates and changes nothing. Tiles are not freed when they become empty again; `compact()` frees tiles that are entirely empty (all bytes equal the fill value) without touching `version`.
- `byteSize()` is `tileCount * tileBytes`. A 64x64 block in a 256x256 image is 16 tiles (16 KiB); 10 % fill packed into 160x41 pixels is exactly 30 tiles.
- `clone()` is O(allocated tiles): the clone shares every tile buffer; the first write to a shared tile (on either image) copies that one tile. Nothing is ever mutated in place while shared, so clones are fully independent. `byteSize()` counts shared buffers in each image.

### Indexed transparency (`transparentIndex`)

Spec 3.4.8 says transparency in indexed mode is "any palette entry with alpha 0". `raster` does not know palettes, but sparsity needs a value for "absent". We therefore store an explicit `transparentIndex` (default 0) per `IndexedImage` instead of hard-coding "index 0 is transparent": it costs one byte, keeps the door open for palettes that keep their transparent entry elsewhere (e.g. imported Aseprite/GIF palettes), and makes the choice visible in the type. Contract for `core`: `palette[transparentIndex]` must have alpha 0 (validate it there); pixels equal to `transparentIndex` are "empty" for sparsity, `bounds()`, `blit` and the transforms. Other alpha-0 palette entries are legal ordinary indices; pass `bounds(i => palette[i][3] === 0)` when they should also count as empty. `toRGBA(palette)` resolves through the palette, absent tiles included, and throws if an index is missing from it.

## Version and dirty-tile contract (for T2.1 transactions)

Every image has a monotonic `version` (0 when fresh; fresh = constructor, `fromRGBA`, `fromIndices`, any transform result). Each tile carries the version of its last change.

- Every mutating call that touches at least one tile advances `version` by exactly **1** (`set`, `composite`, `blit`, `restoreTiles`, `clear`). Reads, `clone()` (which copies version and history), `compact()` and `captureTiles` do not.
- `tilesChanged(sinceVersion)` returns the `{tx, ty}` of every tile changed in an operation with version `> sinceVersion`, row-major (deterministic). **A tile that is not listed is guaranteed unchanged.** `set` is exact; `composite` writes a tile only when a pixel in it changes; `blit` and `restoreTiles` may list a tile whose content ended up identical. Tiles removed by `restoreTiles`/`clear` are listed too.
- `captureTiles(coords)` returns `{tx, ty, data}` snapshots, `data === undefined` for an absent tile. It marks the tiles shared, so the returned buffers are **immutable**: later writes to the image copy first. Callers must not mutate them either.
- `restoreTiles(snapshots)` adopts the buffers without copying (marks them shared), removes tiles whose `data` is `undefined`, and advances `version` once.
- `tiles()` yields live views (`{tx, ty, x, y, data}`) in row-major order; `data` is valid only until the next write. Use `captureTiles` to keep data.

Recommended transaction recipe (no pixel copies except the tiles that change):

```ts
const base = img.clone(); // O(tiles), shares buffers
const v0 = img.version;
// ... apply the operations to img ...
const changed = img.tilesChanged(v0); // tiles to record
const before = base.captureTiles(changed); // pre-transaction content
const after = img.captureTiles(changed); // post-transaction content
// undo: img.restoreTiles(before); redo: img.restoreTiles(after)
```

Drop `base` after the commit; only `before`/`after` for the changed tiles stay alive. A patch that wants an exact diff can compare `before[i].data` with `after[i].data` byte for byte to drop false positives.

## Compositing and rounding

`composite(dst, src, { x, y, opacity })` is the normal "over" operator on **straight-alpha RGBA8**, integer maths only, in place on `dst`. `opacity` is an integer 0..255 (default 255). Source pixels outside `dst` are clipped; `dst === src` throws. Only allocated source tiles are visited.

`div255(v) = floor((v + 127) / 255)` is `round(v / 255)` (255 is odd, so there are no ties). Per source pixel:

1. `sa = div255(srcAlpha * opacity)` (skipped when `opacity = 255`). If `sa = 0` the pixel is skipped.
2. If `sa = 255` or the destination alpha `da = 0`, the result is `(sR, sG, sB, sa)`.
3. Otherwise, with `ida = 255 - sa`:

```
D    = 255*sa + da*ida                       (= 255 x the real result alpha)
outA = floor((D + 127) / 255)                = round(D / 255)
outC = floor((2*N_c + D) / (2*D))            = round(N_c / D),  N_c = 255*sa*sC + da*ida*dC
```

`outC` is the exact weighted mean of source and destination colour, rounded to nearest (an exact-rational BigInt oracle checks 20 000 random pixels). Worked values (hand-computed, in the tests): `(255,0,0,128)` over `(0,0,255,255)` is `(128,0,127,255)`; `(200,100,50,128)` over `(10,20,30,64)` is `(162,84,46,160)`; alpha 1 at opacity 127 vanishes, alpha 2 at opacity 127 becomes 1.

`blit` copies pixels with no blending: by default only non-empty source pixels (alpha != 0 / index != `transparentIndex`), with `{ replace: true }` the whole clipped rectangle including empty pixels.

## Transforms

All transforms read only stored (non-empty) pixels, so sparsity is preserved, and return a fresh image (the input is never modified). `rot90` maps `(x, y)` to `(h-1-y, x)` and swaps the dimensions, `rot270` maps it to `(y, w-1-x)`. `scaleInt(img, k)` replicates each pixel into a `k x k` block (nearest neighbour, `k >= 1`). `crop` accepts rectangles that stick out of the image (the outside is empty). Property tests cover flips twice, `rot90` four times, `rot90`+`rot270`, and `rot180 = flipH . flipV`.

## Benchmark

`node packages/raster/bench/composite.bench.mjs` (after `pnpm exec tsc -b packages/raster`) times a 64x64 composite onto 256x256; not run in CI. On the dev machine it is about 0.07 ms including the `clone()`.

## Post-passes

Pure, integer-only clean-up passes for the rig renderer (FR-RIG-20 step 6, run on the composite before the final overrides), for `TiledImage` and `IndexedImage`. "Opaque" means alpha != 0 (RGBA, so partial alpha counts) or index != `transparentIndex` (indexed). Neither pass modifies its input.

`removeOrphans(img, { minNeighbours = 1, connectivity = 8 }) -> { img, removed }` removes every opaque pixel that has fewer than `minNeighbours` opaque pixels among its 4 or 8 neighbours (outside the image counts as empty). It is a single pass: counts are taken on the input, so removals do not cascade (`XXX` with `minNeighbours: 2` becomes `.X.`, not empty). `minNeighbours` is an integer 0..8 (0 removes nothing); anything else throws `BAD_VALUE`.

`outline(img, colour, { outsideOnly = true, corners = 'round' }) -> { img, offset }` paints a 1-px outline on transparent pixels only, never over opaque ones. `corners: 'square'` outlines a transparent pixel if any of its 8 neighbours is opaque (diagonal corner pixels included); `'round'` uses the 4 edge neighbours only, which omits the convex corner diagonals. `colour` is an `Rgba` with alpha > 0 for `TiledImage`, a palette index (not `transparentIndex`) for `IndexedImage`. With `outsideOnly: true`, holes (transparent pixels not 4-connected to the outside) are not outlined; a ring closed only diagonally still counts as closed. `outsideOnly: false` also outlines the inside of holes.

Canvas: the result is always grown by 1 px on each side, `(w + 2) x (h + 2)`, so border-touching shapes are never clipped. `offset` is always `{ x: 1, y: 1 }` (input pixel `(x, y)` is output `(x + 1, y + 1)`); the renderer places the result at its part offset minus `offset`. Use `crop` to get the old canvas back. The schema's boolean `corners` maps `true` to `'square'` and `false` or absent to `'round'` (the default, so the defaults agree).
