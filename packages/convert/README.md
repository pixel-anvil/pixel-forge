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

Option types (`CropOptions`, `BackgroundOptions`) are named so the ConvertRecipe (E4.4) can reuse them.

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

## Errors

`ConvertError` with `code`: `BAD_IMAGE`, `BAD_RECT`, `BAD_OPTION`, `BAD_PALETTE`.
