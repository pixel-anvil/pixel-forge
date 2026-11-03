# @pixel-forge/convert

Image-to-sprite steps. Every step is a pure function over `RgbaImage` (from `@pixel-forge/raster`):
no DOM, no Node built-ins, integer maths, no randomness. Steps never change their input.

**Depends on:** `schema`, `color`, `raster`

## Input (FR-CONV-01)

This package does not decode files. M1b accepts **PNG only** (decision E4.0). `decodeImageFile` in
`@pixel-forge/io` checks the magic bytes and refuses JPEG and WebP with an error that tells the user to
convert to PNG first.

## Steps

| Step       | Function                       | Notes                                                             |
| ---------- | ------------------------------ | ----------------------------------------------------------------- |
| Crop       | `cropImage(img, {x, y, w, h})` | Integers, fully inside the image, else `ConvertError` `BAD_RECT`. |
| Background | `removeBackground(img, opts)`  | Modes `none`, `key`, `flood`, `alpha`.                            |

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

## Errors

`ConvertError` with `code`: `BAD_IMAGE`, `BAD_RECT`, `BAD_OPTION`.
