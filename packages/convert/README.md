# @pixel-forge/convert

Image-to-sprite steps. Every step is a pure function over `RgbaImage` (from `@pixel-forge/raster`):
no DOM, no Node built-ins, integer maths, no randomness. Steps never change their input.

**Depends on:** `schema`, `color`, `raster`

## Input (FR-CONV-01)

This package does not decode files. M1b accepts **PNG only** (decision E4.0). `decodeImageFile` in
`@pixel-forge/io` checks the magic bytes and refuses JPEG and WebP with an error that tells the user to
convert to PNG first.

## Steps

| Step       | Function                       | Notes                                                                |
| ---------- | ------------------------------ | -------------------------------------------------------------------- |
| Crop       | `cropImage(img, {x, y, w, h})` | Integers, fully inside the image, else `ConvertError` `BAD_RECT`.    |
| Background | `removeBackground(img, opts)`  | Modes `none`, `key`, `flood`, `alpha`.                               |
| Quantise   | `quantize(img, palette, opts)` | Nearest colour in OKLab, optional dither. Returns image + index map. |
| Grid       | `detectGrid(img, opts?)`       | Cell size and phase of upscaled art, or a clear "no grid".           |
| Downscale  | `downscale(img, opts)`         | `box`, `kcentroid`, `nearest`, `mode`; by size or by grid.           |

Option types (`CropOptions`, `BackgroundOptions`, `DetectGridOptions`, `DownscaleOptions`) are named
so the ConvertRecipe (E4.4) can reuse them.

### Background removal

- Tolerance is a Euclidean distance in 8-bit **sRGB**, 0..442 (`rgbDistanceSq`, compared as squared
  integers). 0 means exact match.
- `color: 'auto'` (default) is the most common corner colour (`autoKeyColor`); a tie goes to the first
  of top-left, top-right, bottom-left, bottom-right. Fully transparent corners are skipped.
- `key` clears every matching pixel. `flood` clears only matching pixels connected (4-way) to the
  border, so same-colour areas enclosed by the subject stay.
- `alpha` keeps the alpha and clears pixels below `threshold`.
- Removed pixels become `0,0,0,0`.

### Quantise and dither (FR-CONV-05, FR-CONV-06)

`quantize(img, palette, { dither, strength, spread, alphaThreshold })` returns `{ image, indices }`.

- `palette` is a list of `[r,g,b,a]` (1..256 entries) or any object with `colors` (a `Palette`, the
  result of `generatePalette` from `@pixel-forge/color`). Entries with alpha 0 are never chosen.
- Distance is squared Euclidean in OKLab (`@pixel-forge/color`). A tie goes to the lowest index.
- Alpha: below `alphaThreshold` (default 128) the pixel is transparent (`0,0,0,0`, index `-1`); all
  others are opaque (alpha 255, palette RGB). Transparent pixels do not take part in dithering.
- `dither`: `none` (default), `bayer2`, `bayer4`, `bayer8` (Bayer 1973; offsets of
  `threshold * spread * strength` added to sRGB, `spread` default 64, use about 255 for two colours),
  `floyd-steinberg` (Floyd and Steinberg 1976; error diffused in OKLab, rows top to bottom, pixels left
  to right, no serpentine, weights 7/16 3/16 5/16 1/16).
- `strength` 0..1 scales the offset or the diffused error. 0 equals `none`. Any mode with
  `strength < 1` is the strength-limited dither.
- Only `+ - * /` and `sqrt` on doubles, so results are the same on every platform. Pinned hashes in
  `test/quantize.test.ts` guard this.

### Grid detection (FR-CONV-03)

`detectGrid` finds the cell size and phase of art that was upscaled by a whole number (or AI "fake
pixel art" with whole-pixel cells).

1. Edge histogram: per axis, the difference of neighbour pixels (sum of the 4 channel differences,
   0..1020; alpha 0 reads as `0,0,0,0`). Only local maxima along the line count (1-D non-maximum
   suppression, Canny 1986), less `noiseFloor` (default 24).
2. Period and phase: the histogram is folded modulo each trial size `p` (2..`maxCell`, default 64),
   "epoch folding" (Leahy et al. 1983). The score is the share of edge energy on the best comb, above
   chance: 1 for a perfect grid, about 0 for no grid.
3. Choice: the **largest** `p` whose score is at least `minConfidence` (0.5) and 3/4 of the best
   score, with edges on at least 3 grid lines. Divisors of the true size also fit, so this is the
   coarsest grid that explains the edges.

The result is `{ found: true, cellWidth, cellHeight, offsetX, offsetY, confidence, ... }`, or
`{ found: false, reason }` with `reason` `too-small`, `flat` or `no-period`. A "no grid" answer is
definite: native pixel art and photos give it. Without `square` each axis is found alone (non-square
cells work) and both must succeed; `square: true` pools both axes into one size.

Offsets: cells start at `offsetX + k * cellWidth`, so a non-zero offset means a partial cell at the
left. Limit: fractional or drifting cell sizes are not modelled (they give "no grid").

### Downscale (FR-CONV-04)

Target: `width` and/or `height` (one alone keeps the aspect, rounded), or `grid` (a `GridFound` or any
`GridSpec`). A target larger than the source is refused: downscale never upscales.

- Size cells: output column `i` of `W` covers `floor(i*w/W) .. floor((i+1)*w/W) - 1`.
- Grid cells: partial cells at the edges are kept by default (`edges: 'keep'`), so no source pixel is
  lost; `edges: 'drop'` leaves them out.

Alpha, the same for every method: a pixel is visible when alpha >= `alphaThreshold` (default 128).
A cell with fewer than half visible pixels becomes `0,0,0,0` (a tie keeps the cell). Colours come
from visible pixels only.

| Method      | Colour of a cell                                                                    |
| ----------- | ----------------------------------------------------------------------------------- |
| `box`       | Mean in 8-bit sRGB, RGB weighted by alpha; alpha is the mean of the visible alphas. |
| `nearest`   | The visible pixel nearest to the centre (even cells: top-left of the middle 2x2).   |
| `mode`      | The most common RGBA; ties go to the colour seen first in row-major order.          |
| `kcentroid` | k-means in OKLab (`k` default 2, max 8), centroid of the heaviest cluster.          |

`kcentroid` follows the public description of Astropulse's "K-Centroid" downscale; it is Lloyd's
k-means (1982) with deterministic farthest-point seeding (Gonzalez 1985). A cluster of one distinct
colour returns that colour exactly. All of it is written here from those descriptions.

Round trip: art upscaled by whole numbers at any phase, downscaled by its grid, gives the source back
exactly with every method (`box` too, because the cells are uniform).

## Errors

`ConvertError` with `code`: `BAD_IMAGE`, `BAD_RECT`, `BAD_OPTION`, `BAD_PALETTE`.
