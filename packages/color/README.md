# @pixel-forge/color

OKLab/OKLCH, palette operations, ramps, quantisation and palette file formats.

**Depends on:** `schema`

**Status:** T1.2 implemented (conversions, nearest colour, palette ops). Ramps, quantisation, presets
and file formats arrive in later cards.

## API (T1.2)

| Area        | Functions                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversion  | `srgbToLinear`, `linearToSrgb`, `srgb8ToLinear`, `linearToSrgb8`, `linearToOklab`, `oklabToLinear`, `srgb8ToOklab`, `oklabToSrgb8`, `oklabToOklch`, `oklchToOklab`, `cbrt` |
| Distance    | `oklabDistanceSq(a, b)` (squared Euclidean in OKLab, FR-CONV-05)                                                                                                           |
| Nearest     | `nearestIndex(palette, rgba, { cache?, alphaWeight? })`, `createNearestCache(capacity)`                                                                                    |
| Palette ops | `addColor`, `removeColor`, `reorder`, `moveColor`, `sortBy(palette, 'hue'\|'luminance'\|'chroma', descending?)`, `dedupe`, `remapIndex`                                    |

Palette operations are pure (a new `Palette` is returned) and return `{ palette, remap }`:
`remap[oldIndex]` is the new index or `null` if the colour was removed (`sortBy` also returns
`order`, where `order[newIndex] = oldIndex`). Ramps are remapped automatically (removed indices are
dropped, a ramp left empty is removed). Callers must apply `remap` to pixel indices and skin remaps.

## Alpha handling in `nearestIndex`

- Input alpha 0: the first palette entry with alpha 0; if none, nearest by colour.
- Input alpha > 0: entries with alpha 0 are not candidates (unless all are transparent); distance
  is OKLab on RGB, plus `alphaWeight * (Δalpha/255)²` (default weight 0, alpha ignored).
- Ties go to the lower index. The cache (`createNearestCache`, FIFO eviction, keyed by RGBA uint32)
  is tied to `palette.colors` identity and the weight; treat palettes as immutable.

## Palette generation (FR-PAL-04)

`generatePalette(rgba, { n, method, seed, minAlpha })` makes 2 to 256 colours from straight RGBA bytes:
`'kmeans'` (k-means++ seeding, then up to 32 Lloyd iterations in OKLab, weighted by pixel count) or
`'mediancut'` (split the box with the largest squared error at the weighted median of its longest
axis). The seed (xorshift32, default 1) only affects k-means. Pixels with alpha below `minAlpha`
(default 1) are ignored, others count by their RGB, and the result is opaque. Every output colour
occurs in the image: a final centre is replaced by the nearest image colour not taken yet, so the
`n` colours are distinct. They are sorted darkest first (OKLab lightness, ties by packed RGB). An
image with `n` colours or fewer returns its own colours (`exact`). The image is never sampled; above
8,192 distinct colours they are merged into coarser cells first (`binned`), and more than 16,777,216
pixels are refused. Pure integer maths for counting, ordering and random numbers; OKLab is the
deterministic one above.

## Determinism (NFR-02)

Conversions use only IEEE-754 basic operations (`+ - * /`, `Math.sqrt`). The sRGB power curve and
the OKLab cube roots use fixed-iteration Newton solvers (`cbrt`, fifth root) rather than
`Math.pow` / `Math.cbrt`, so results are bit-identical across platforms and engines. The sole
exception is OKLCH, which uses `Math.atan2` / `cos` / `sin`; hue is only used for sorting and
display, and must not decide pixels across platforms without quantisation.

## Oracles

Tests check CSS Color 4 / Ottosson reference values (red, green, blue, white, black) to 1e-4 and
sRGB8 → OKLab → sRGB8 exactness on a 16-level grid (4096 colours) and strided 8-bit sweeps.
