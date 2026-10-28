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

## Primitives

Pure, integer-only drawing on `TiledImage` (colour `[r,g,b,a]`) and `IndexedImage` (colour = palette index); the colour parameter type follows the image (`PixelOf<I>`). Out-of-canvas pixels are clipped (via `set`). Backs FR-DRAW-01/02/05.

| Function                                                                                      | Notes                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `line(img, x0, y0, x1, y1, colour, {brush?})`                                                 | Bresenham (Zingl error form; equivalent output to common pixel editors for left-to-right lines). Both endpoints inclusive.                                                                                                                                                                 |
| `rect(img, x, y, w, h, colour, {fill?})`                                                      | Top-left + size; `w<=0`/`h<=0` draws nothing; outline is 1 px.                                                                                                                                                                                                                             |
| `ellipse(img, x0, y0, x1, y1, colour, {fill?})`                                               | Inclusive bounding box, corners in any order. Alois Zingl's integer `plotEllipseRect` (2012, copyright-free), implemented clean-room; fill = one horizontal span per row. Mirror symmetric in both axes for even and odd sizes (tested for all sizes up to 24x24).                         |
| `floodFill(img, x, y, colour, {connectivity: 4\|8, mode: 'contiguous'\|'global', tolerance})` | Explicit stack + visited bitmap, bounded by `width*height`. Returns the number of pixels changed; 0 for a seed outside the image or already of the target colour. `tolerance` 0 (default) is an exact match, otherwise the largest per-channel difference (index difference when indexed). |
| `pixelPerfect(points)`                                                                        | Removes L-shaped corners from a freehand stroke: for consecutive kept points `a, b, c`, if `a` and `c` are diagonal neighbours and `b` is orthogonally adjacent to both, `b` is dropped. Duplicate consecutive points are skipped, end points kept, single look-back (no cascading).       |
| `brushMask({shape: 'square'\|'round', size: 1..8})`                                           | Stamp mask; the stamp point is at `-floor(size/2)` from the top-left. Round: cell set when `(2x-(s-1))^2 + (2y-(s-1))^2 <= s^2 - s`.                                                                                                                                                       |

**Line symmetry rule.** `line(A, B)` and `line(B, A)` set exactly the same pixels. Plain Bresenham is not symmetric when the ideal line crosses a pixel-edge midpoint, so the endpoints are ordered lexicographically (smaller x first, then smaller y) before walking, and ties go to the diagonal step (`2*err >= dy` and `2*err <= dx` are both taken). With a brush the stamp is placed at each centre-line pixel, so brush lines are symmetric too.

**Aseprite oracle.** `test/oracle/aseprite-primitives.lua` draws 12 cases (5 lines, 5 ellipse outlines, 2 filled ellipses) with Aseprite's own tools through `app.useTool`; the PNGs are checked in and `test/primitives-oracle.test.ts` asserts pixel-for-pixel equality (all 12 equal). Known difference: Aseprite's line is not symmetric (its result depends on the drawing direction), so equality is only guaranteed when the line is given in the canonical order (left to right, then top to bottom) - the oracle cases are. Ellipse is identical in both directions. All 7 ellipse oracle cases (5 outlines, 2 fills) are pixel-identical to Aseprite. The ellipse is Zingl's published algorithm and not a copy of Aseprite's (proprietary) code, so other sizes may intentionally differ from Aseprite by a few pixels (licensing-driven, not a bug); symmetry and bounding box are guaranteed and tested for all sizes up to 24x24.

## Rotation

Fixed-point trigonometry and pixel-art rotation about a pivot pixel (T1.6; FR-RIG-20 steps 2-3, FR-RIG-21, NFR-02), ported from the T0.4 spike (`spikes/rotsprite/REPORT.md`, `spikes/rotsprite/reference/rot.mjs`). Angles are degrees, 0° along +x, clockwise on screen (y down), and must be multiples of **0.25°** (any sign; `RasterError('BAD_VALUE')` otherwise). Nothing calls `Math.sin`/`Math.cos` at runtime; every decision is integer maths.

| Export                                                     | Purpose                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sinQ16(deg)`, `cosQ16(deg)`                               | `round(sin · 65536)` from the committed table                                                                                                                                                                                             |
| `rotatePoint(dx, dy, deg)`                                 | integer vector rotated clockwise, each coordinate rounded **half away from zero** (the FR-RIG-20 snapping primitive)                                                                                                                      |
| `rotatePointQ16(dx, dy, deg)`                              | the same, unrounded: the exact `[C·dx − S·dy, S·dx + C·dy]` in Q16 (sub-pixel work, T3.1)                                                                                                                                                 |
| `roundQ16(v)`, `angleToStep(deg)`                          | half-away-from-zero rounding of a Q16 value (`                                                                                                                                                                                            | v   | ≤ MAX_ROUND_Q16`, else `BAD_VALUE`); angle to table step `0..1439`                            |
| `Q16`, `ANGLE_STEP_DEG`, `ANGLE_STEPS`, `MAX_ROTATE_COORD` | 65536, 0.25, 1440, 2^31 (largest offset accepted; keeps products below 2^53)                                                                                                                                                              |
| `MAX_ROUND_Q16`                                            | 2^53 − 32768: largest `                                                                                                                                                                                                                   | v   | ` `roundQ16` accepts (`v + 32768` must stay an exact double, so one more would round wrongly) |
| `rotateAbout(img, pivot, deg, algo = 'rotsprite')`         | `{ img, pivotOut }` for `TiledImage` / `IndexedImage` or a prepared handle; `algo` is the schema's `RotationAlgorithm` (`rotsprite`, `nearest`, `none`)                                                                                   |
| `prepareRotSprite(img)`, `PreparedRotSprite`               | reusable handle; its ×8 image is built lazily on the first RotSprite use that is not a multiple of 90° (`byteSize` for cache budgets)                                                                                                     |
| `ROTSPRITE_MAX_AREA`                                       | 2^18 px of opaque bounding box; above it `rotateAbout(..., 'rotsprite')` throws `BAD_SIZE` **at every angle**, quarter turns included (the ×8 image costs 256 B per source pixel); `nearest`, `none` and `prepareRotSprite` have no limit |

`ROTSPRITE_VERSION` (currently 1) versions the output of `rotateAbout`: **bump it whenever a change to the rotation code, Scale2x or the trig table changes any output pixel, `pivotOut` or canvas.** Caches that keep rotated pixels (core's render input key, rig's `PART_RENDER_VERSION` consumers) include it, so a raster change invalidates cached frames without anyone remembering to bump the rig version.

### Trig table

`src/trig-table.ts` holds the quarter wave (361 entries, 0° to 90°) of `sin · 65536`, rounded half away from zero. It is generated by `node packages/raster/scripts/gen-trig-table.mjs` (`--check` reports a stale file; `pnpm gen` runs it and `pnpm gen:check`, part of `pnpm verify`, fails if the committed file is stale) with exact BigInt arithmetic: 256 fractional bits, pi from Machin's formula, sin from its Taylor series. `trig.ts` expands it to all 1440 entries with `sin(180° − x) = sin(x)` and `sin(180° + x) = −sin(x)`, and `cos(x) = sin(x + 90°)`. Consequences, all asserted by tests:

- exact at 0/90/180/270° (0, ±65536) and 30/150/210/330° (±32768); `sin 45° = 46341`;
- `sin(−x) = −sin(x)`, `sin(180° − x) = sin(x)` and `cos(−x) = cos(x)` hold exactly for every entry;
- no entry is a rounding tie (the closest fractional part is 0.0018 from .5), so the rounding rule never decides a table value. A float64 `Math.round(Math.sin(r) · 65536)` gives the same 1440 values; the tests check that and a direct BigInt evaluation of each of the 1440 angles;
- `|sin² + cos² − 65536²| ≤ |sin| + |cos| + ½ ≤ 92683` (2.2e-5 relative; measured worst 89466).

`rotatePoint` agrees with a float64 `roundHalfAway(dx·cos θ − dy·sin θ)` except where the true value is within the table's quantisation error, `(|dx| + |dy|) / 131072`, of a `.5` boundary. Over all 1440 angles and `|dx|, |dy| ≤ 24` that is 648 of 6.9 M coordinates. 136 of them are exact Q16 ties, such as `(1, 0)` at 30°: `(56756, 32768)` rounds to `[1, 1]`, while float64 `sin 30° = 0.49999999999999994` rounds to 0.

### `rotateAbout`

**Pivot convention.** `pivot` is an integer pixel inside the image, and the rotation centre is its centre `(x + ½, y + ½)`. The result carries `pivotOut`, the output pixel the pivot pixel landed on. Draw `img` at `dst = snappedPivot − pivotOut` and the pivot pixel sits exactly on the snapped pivot (FR-RIG-20 step 3). The pivot pixel's own colour is copied onto `pivotOut`, a cheap invariant: the sample there already is that colour.

**Canvas.** For `rotsprite` and `nearest` the output is cropped to its non-empty pixels **plus the pivot pixel**, so `pivotOut` is always inside it. An empty input gives a 1×1 empty image with `pivotOut = (0, 0)`. `none` returns a copy of the whole input canvas with `pivotOut = pivot`. Outputs are new images; the input is never modified.

**Multiples of 90°** use the exact pixel permutation `d → R·d`, so they equal `rot90` / `rot180` / `rot270` / identity, cropped as above. This is tested against `transform.ts` for both image kinds. The general formula gives the same pixels there; the shortcut guarantees it.

**Colours.** Both algorithms only copy source values, so output colours ⊆ input colours (FR-RIG-21: RotSprite adds no colours; property-tested). RGBA pixels compare by exact RGBA equality. Any alpha-0 pixel counts as transparent and comes out as `(0,0,0,0)`, so partial alpha is kept, but invisible colour under alpha 0 is dropped. Indexed images compare indices; `transparentIndex` is empty and carries over to the output. Other alpha-0 palette entries are ordinary indices (raster does not know palettes).

**`nearest`.** The output pixel at offset `d` from `pivotOut` copies source pixel `pivot + roundHalfAway(Rᵀ·d / 65536)`, where `Rᵀ` is the transposed Q16 rotation. Ties go away from the pivot, so it is exactly mirror-symmetric.

**`rotsprite`.**

1. `big = scale2x³(source)`: Scale2x (Andrea Mazzoleni's public description, scale2x.it; the EPX rule of Eric Johnston) three times, with exact equality, on the opaque bounding box. RotSprite itself is Xenowhirl's 2007 algorithm (Scale2x upscale, nearest-neighbour rotation, downscale); only its public description was used. **Outside the image counts as transparent** (the spike replicated edge pixels instead). The result therefore does not depend on how much transparent margin an image has, so a part renders the same whether its variant is stored trimmed or canvas-sized. Scale2x rounds convex corners of the art wherever they are; see the area note below.
2. Fused rotate + sample: the output pixel `d` reads `big[8·py + 4 + sfloor(C·dy − S·dx, 8192)][8·px + 4 + sfloor(C·dx + S·dy, 8192)]` (box-relative), with `sfloor(n, q) = n ≥ 0 ? floor(n/q) : ceil(n/q) − 1`. That is a nearest-neighbour rotation of the ×8 image about the pivot block's centre (a ×8 pixel corner), sampled once at each output pixel's centre. A sample on a ×8 pixel edge goes to the pixel farther from the pivot, the same on both sides. There is no majority-colour downsample (the spike found it erodes thin limbs).
3. **Centre-line tie (new).** A sample with `C·dx + S·dy = 0` (or `C·dy − S·dx = 0`) and `d ≠ 0` lies exactly between two ×8 pixels of one source pixel, and neither is farther from the pivot. With `|C| = |S|` this happens on a diagonal through the pivot at 45° + k·90°. The spike took the +x/+y pixel, which breaks mirror symmetry there: 8 of 240 random palette cases in the tests, worst mask IoU 0.94. The port chooses mirror-invariantly: the shared colour, else the source pixel's own colour, else the opaque one, else the smaller packed value. With it, `flipH(rotate(I, θ)) = rotate(flipH(I), −θ)` holds **exactly** (colours and mask) at all 1440 angles on the test subjects and at every 1° on random palette images. It holds for `nearest` too.

**Caching.** The ×8 image depends only on the source. Build the handle once per variant with `prepareRotSprite(img)` and pass it to `rotateAbout` for every angle; the ×8 image is built on the first RotSprite call that is not a multiple of 90° and cached in the handle (so a handle used only with `nearest` / `none`, or only at quarter turns, never builds it or hits `ROTSPRITE_MAX_AREA`); results are cached per `(variantId, quantisedAngle)` above this layer (FR-RIG-20). The handle snapshots the image (copy-on-write clone), so later edits to the original do not leak in; prepare again after editing. Once the ×8 image exists a handle costs 260 B per pixel of the opaque box: 260 KiB for a full 32×32 box, 190 KiB for the 25×30 torso test subject.

### Evidence and differences from the spike reference

The tests are `test/trig.test.ts`, `test/rotsprite.test.ts` and `test/rotsprite-reference.test.ts`, which imports the spike's `rot.mjs` as-is. The subjects are hand-drawn ASCII in `test/rotsprite-fixtures.ts`: a 2-px upper arm, a forearm with a 1-px hook, a 4-px outlined shin and boot with six colours, and a 32×32 head and torso with twelve colours. No third-party art.

- **Sentinel:** a unique colour on the pivot lands on `pivotOut` at every 1° for all four subjects with the pin disabled (sampling alone). The same holds with every opaque pixel of the limbs, and every 9th of the torso, as the pivot, every 7.25°.
- **Agreement:** with the spike's conventions the port is pixel-identical to `rot.mjs`, including canvas and `pivotOut`, for RotSprite and nearest at every 1° on the subjects and 8 random images. The spike conventions are: edge pixels replicated (emulated by giving the reference a 1-px transparent border), no exact quarter-turn shortcut, the +x/+y centre tie, and no pin. With the production defaults the only differing pixels are centre-line ties at 45° + k·90°. Without the border, the reference differs only where the art touches its image edge.
- **Determinism:** `test/rotsprite-hashes.json` commits the SHA-256 of the decoded RGBA and `pivotOut` of RotSprite and nearest output for the four subjects at 10 angles (0.25° to 315°); update only with `UPDATE_GOLDEN=1` and a card note. Another test stubs `Math.sin`/`cos`/`tan`/`atan2` to throw while rotating at 206 angles.
- **Placement:** `nearest` matches an independent float64 nearest rotation except at near-ties (≤ 0.02 % of pixels). The RotSprite output centroid stays within 0.62 px (limbs) and 0.18 px (torso) of the float64-rotated input centroid.
- **Area:** measured over every 1° (RotSprite, production), the worst |change| in opaque pixels and the signed extremes are:

  | Subject (opaque px) | worst \|Δ\| | loss / gain | mean \|Δ\| | spike edge replication, worst \|Δ\| | `nearest`, worst \|Δ\| |
  | ------------------- | ----------- | ----------- | ---------- | ----------------------------------- | ---------------------- |
  | upper-arm (12)      | 3           | −3 / 0      | 1.22       | 3                                   | 2                      |
  | forearm (9)         | 2           | −2 / +2     | 0.74       | 3                                   | 2                      |
  | shin (37)           | 3           | −3 / +1     | 1.38       | 3                                   | 2                      |
  | torso (552)         | 10          | −10 / +3    | 3.36       | 10                                  | 9                      |

  The test asserts exactly these numbers as upper bounds per subject (worst, loss, gain and the sum of |Δ| over the 360 angles), so any regression that erodes the thin limbs fails; larger parts (37 px, 552 px) are additionally held to ±10 % (3.7 px, 55 px). The earlier generic "≤ 3 px for parts under 30 px" was too loose to catch a one-pixel erosion on the 9-px forearm. Edge replication is **not** a way to ±1 px: on the unpadded subjects the spike's Scale2x swings by 3 px on both thin limbs, the same as or more than the production transparent edge (3 and 2), so the swing is inherent to 2-px-wide art at this size. The transparent edge is chosen because it makes the output independent of the transparent margin around the art (a trimmed and a canvas-sized variant render identically), not because it preserves area; it rounds outer corners where the art touches its bounding box, and RotSprite loses area more often than it gains.

### Benchmark

`node packages/raster/bench/rotsprite.bench.mjs` (after `pnpm exec tsc -b packages/raster`). Medians on an Apple M5 with Node 26:

| Case                                      | Time        | NFR-01 target                   |
| ----------------------------------------- | ----------- | ------------------------------- |
| Cold 32×32 (snapshot, Scale2x ×3, rotate) | **0.09 ms** | < 10 ms                         |
| First call in a fresh process             | 1.9 ms      | < 10 ms                         |
| Warm 32×32                                | 0.010 ms    | —                               |
| 16 parts of 16×16, warm                   | **0.07 ms** | < 2 ms for the whole rig render |
| 16 parts of 16×16, cold                   | 0.52 ms     | —                               |
| `nearest` 32×32                           | 0.01 ms     | —                               |

### Review sheet

`PF_REVIEW_SHEET=1 pnpm exec vitest run --project raster packages/raster/test/rotsprite-sheet.test.ts` writes `.golden-diff/rotsprite-review-<subject>.png` at ×8. Each sheet shows one subject at 0–135° with RotSprite, plus `nearest` at 30° and 45°. The pivot pixel is magenta, and every cell is drawn at `centre − pivotOut`. No goldens are committed.
