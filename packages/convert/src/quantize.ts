import {
  type Oklab,
  createNearestCache,
  nearestIndex,
  oklabDistanceSq,
  srgb8ToOklab,
} from '@pixel-forge/color';
import type { RgbaImage } from '@pixel-forge/raster';
import type { RGBA8 } from '@pixel-forge/schema';
import { assertImage } from './crop.js';
import { type BayerSize, FLOYD_STEINBERG, bayerThreshold } from './dither.js';
import { ConvertError } from './errors.js';

/** Dither modes of {@link quantize}. */
export type DitherMode = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'floyd-steinberg';

/** Largest palette {@link quantize} accepts. */
export const MAX_QUANTIZE_COLORS = 256;
/** Index written for a transparent pixel in {@link QuantizeResult.indices}. */
export const TRANSPARENT_INDEX = -1;
/** Default `alphaThreshold`: pixels with alpha below 128 become transparent. */
export const DEFAULT_ALPHA_THRESHOLD = 128;
/** Default ordered-dither `spread`, in 8-bit sRGB units. */
export const DEFAULT_DITHER_SPREAD = 64;

/** Options of {@link quantize}. */
export interface QuantizeOptions {
  /** Dither mode. Default `'none'`. */
  readonly dither?: DitherMode;
  /**
   * Dither strength, 0..1, default 1. Ordered modes scale the threshold offset by it; Floyd-Steinberg
   * scales the diffused error. 0 gives exactly the result of `'none'`; low values approach it.
   * Any mode with `strength < 1` is the "strength-limited" dither of FR-CONV-06.
   */
  readonly strength?: number;
  /**
   * Ordered modes only: peak-to-peak size of the threshold offset in 8-bit sRGB units, added equally
   * to R, G and B before the nearest-colour search (default 64, so +-32 at strength 1). Use about
   * 255 for a two-colour palette, less for dense palettes.
   */
  readonly spread?: number;
  /** Pixels with alpha below this (integer 0..255) become transparent. Default 128. 0 keeps all pixels. */
  readonly alphaThreshold?: number;
}

/** Output of {@link quantize}. */
export interface QuantizeResult {
  /** Same size as the input. Opaque pixels hold the palette RGB with alpha 255; transparent ones `0,0,0,0`. */
  readonly image: RgbaImage;
  /** One entry per pixel: palette index, or {@link TRANSPARENT_INDEX} (-1) for a transparent pixel. */
  readonly indices: Int16Array;
}

/** The colour list of an explicit palette or of an object with `colors`. Internal to the package. */
export function colorsOf(
  palette: readonly RGBA8[] | { readonly colors: readonly RGBA8[] },
): readonly RGBA8[] {
  return 'colors' in palette ? palette.colors : palette;
}

/** Nearest visible palette entry to an OKLab point; ties go to the lowest index. */
function nearestLab(labs: readonly Oklab[], visible: readonly boolean[], p: Oklab): number {
  let best = Infinity;
  let result = 0;
  for (let i = 0; i < labs.length; i++) {
    const lab = labs[i];
    if (lab === undefined || visible[i] !== true) continue;
    const d = oklabDistanceSq(p, lab);
    if (d < best) {
      best = d;
      result = i;
    }
  }
  return result;
}

function validate(
  colors: readonly RGBA8[],
  opts: QuantizeOptions,
): { dither: DitherMode; strength: number; spread: number; threshold: number } {
  if (colors.length === 0) throw new ConvertError('BAD_PALETTE', 'palette is empty');
  if (colors.length > MAX_QUANTIZE_COLORS) {
    throw new ConvertError(
      'BAD_PALETTE',
      `palette has ${String(colors.length)} colours, the maximum is ${String(MAX_QUANTIZE_COLORS)}`,
    );
  }
  for (const c of colors) {
    if (!c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new ConvertError('BAD_PALETTE', 'palette entries must be [r,g,b,a] integers 0..255');
    }
  }
  if (!colors.some((c) => c[3] !== 0)) {
    throw new ConvertError('BAD_PALETTE', 'palette has no visible (alpha > 0) colour');
  }
  const dither = opts.dither ?? 'none';
  if (!['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'].includes(dither)) {
    throw new ConvertError('BAD_OPTION', `unknown dither mode ${JSON.stringify(dither)}`);
  }
  const strength = opts.strength ?? 1;
  if (!(strength >= 0 && strength <= 1)) {
    throw new ConvertError('BAD_OPTION', 'strength must be a number from 0 to 1');
  }
  const spread = opts.spread ?? DEFAULT_DITHER_SPREAD;
  if (!(spread > 0 && Number.isFinite(spread))) {
    throw new ConvertError('BAD_OPTION', 'spread must be a positive finite number');
  }
  const threshold = opts.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new ConvertError('BAD_OPTION', 'alphaThreshold must be an integer from 0 to 255');
  }
  return { dither, strength, spread, threshold };
}

/**
 * Maps every pixel of `img` to its nearest palette colour by squared Euclidean distance in OKLab
 * (FR-CONV-05), with optional dithering (FR-CONV-06). Pure; the input is not changed.
 *
 * - `palette` is an explicit RGBA list or any object with `colors` (a `Palette`, the result of
 *   `generatePalette`). 1 to 256 entries. Entries with alpha 0 are never chosen; at least one entry
 *   must be visible. Palette alpha is otherwise ignored: output pixels are opaque.
 * - Alpha: a pixel with alpha below `alphaThreshold` is transparent in the output (`0,0,0,0`, index -1)
 *   and takes no part in dithering (it neither receives nor sends error); every other pixel is opaque.
 * - Ties between equally near entries go to the lowest palette index.
 * - Ordered dither (`bayer2|4|8`, Bayer 1973): each pixel's sRGB channels are moved by
 *   `bayerThreshold * spread * strength`, clamped and rounded, then matched. The pattern is anchored at
 *   the image origin.
 * - `floyd-steinberg` (Floyd and Steinberg 1976): error is computed and diffused in OKLab, scanning rows
 *   top to bottom and pixels left to right (no serpentine), with weights 7/16, 3/16, 5/16, 1/16 times
 *   `strength`. Error sent to a transparent or off-image pixel is dropped. Working values may leave
 *   the gamut; they are not clamped.
 * - Determinism: only `+ - * /` and `Math.sqrt` on IEEE doubles (the `@pixel-forge/color` policy), so
 *   results are identical on every platform.
 *
 * @throws ConvertError `BAD_IMAGE` for a malformed image; `BAD_PALETTE` for an empty palette, more than
 *   256 entries, an entry that is not four integers 0..255, or no visible entry; `BAD_OPTION` for an
 *   unknown dither mode, a `strength` outside 0..1, a non-positive `spread` or a bad `alphaThreshold`.
 */
export function quantize(
  img: RgbaImage,
  palette: readonly RGBA8[] | { readonly colors: readonly RGBA8[] },
  opts: QuantizeOptions = {},
): QuantizeResult {
  assertImage(img);
  const colors = colorsOf(palette);
  const { dither, strength, spread, threshold } = validate(colors, opts);

  const { width, height, data: src } = img;
  const count = width * height;
  const indices = new Int16Array(count).fill(TRANSPARENT_INDEX);

  if (dither === 'floyd-steinberg' && strength > 0) {
    const labs = colors.map((c) => srgb8ToOklab(c[0], c[1], c[2]));
    const visible = colors.map((c) => c[3] !== 0);
    const work = new Float64Array(count * 3);
    const live = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      if ((src[i * 4 + 3] ?? 0) < threshold) continue;
      live[i] = 1;
      const lab = srgb8ToOklab(src[i * 4] ?? 0, src[i * 4 + 1] ?? 0, src[i * 4 + 2] ?? 0);
      work[i * 3] = lab.L;
      work[i * 3 + 1] = lab.a;
      work[i * 3 + 2] = lab.b;
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (live[i] === 0) continue;
        const L = work[i * 3] ?? 0;
        const a = work[i * 3 + 1] ?? 0;
        const b = work[i * 3 + 2] ?? 0;
        const k = nearestLab(labs, visible, { L, a, b });
        indices[i] = k;
        const target = labs[k] ?? { L, a, b };
        const eL = (L - target.L) * strength;
        const ea = (a - target.a) * strength;
        const eb = (b - target.b) * strength;
        for (const tap of FLOYD_STEINBERG) {
          const nx = x + tap.dx;
          const ny = y + tap.dy;
          if (nx < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (live[j] === 0) continue;
          const w = tap.weight / 16;
          work[j * 3] = (work[j * 3] ?? 0) + eL * w;
          work[j * 3 + 1] = (work[j * 3 + 1] ?? 0) + ea * w;
          work[j * 3 + 2] = (work[j * 3 + 2] ?? 0) + eb * w;
        }
      }
    }
  } else {
    const size: BayerSize | 0 =
      dither === 'bayer2' ? 2 : dither === 'bayer4' ? 4 : dither === 'bayer8' ? 8 : 0;
    const cache = createNearestCache(1 << 16);
    const pal = { colors: [...colors] };
    const amp = spread * strength;
    const clamp8 = (v: number): number => {
      const r = Math.floor(v + 0.5);
      return r < 0 ? 0 : r > 255 ? 255 : r;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if ((src[i * 4 + 3] ?? 0) < threshold) continue;
        let r = src[i * 4] ?? 0;
        let g = src[i * 4 + 1] ?? 0;
        let b = src[i * 4 + 2] ?? 0;
        if (size !== 0 && amp > 0) {
          const off = bayerThreshold(size, x, y) * amp;
          r = clamp8(r + off);
          g = clamp8(g + off);
          b = clamp8(b + off);
        }
        indices[i] = nearestIndex(pal, [r, g, b, 255], { cache });
      }
    }
  }

  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const k = indices[i] ?? TRANSPARENT_INDEX;
    if (k < 0) continue;
    const c = colors[k] ?? [0, 0, 0, 0];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return { image: { width, height, data: out }, indices };
}

/**
 * A default ordered-dither `spread` derived from a palette: the mean distance from each visible
 * colour to its nearest other colour (Euclidean in 8-bit sRGB), divided by `sqrt(3)` and rounded,
 * clamped to 1..255. The ordered offset is added equally to R, G and B, so a grey shift of `d` moves a
 * colour by `d * sqrt(3)`; a threshold range that spans the gap between neighbouring palette colours
 * is the one that mixes them. Checks: a black and white palette gives 255 (the value advised for two
 * colours), a grey ramp with step `s` gives `s`. It is a heuristic of this project, not from a paper;
 * it ignores palette shape, so strongly clustered palettes still want a hand-set `spread`.
 * Duplicate colours count once; entries with alpha 0 are ignored. With fewer than two distinct visible
 * colours it returns {@link DEFAULT_DITHER_SPREAD}. Only integer maths and one `Math.sqrt` per colour
 * and one division, so it is the same on every platform. {@link quantize} itself keeps its fixed
 * default; the recipe runner uses this function when `spread` is `'auto'`.
 */
export function autoDitherSpread(
  palette: readonly RGBA8[] | { readonly colors: readonly RGBA8[] },
): number {
  const colors = colorsOf(palette).filter((c) => c[3] !== 0);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < colors.length; i++) {
    const a = colors[i];
    if (a === undefined) continue;
    let best = Infinity;
    for (let j = 0; j < colors.length; j++) {
      const b = colors[j];
      if (i === j || b === undefined) continue;
      const dr = a[0] - b[0];
      const dg = a[1] - b[1];
      const db = a[2] - b[2];
      const d = dr * dr + dg * dg + db * db;
      if (d > 0 && d < best) best = d;
    }
    if (best !== Infinity) {
      sum += Math.sqrt(best);
      n++;
    }
  }
  if (n === 0) return DEFAULT_DITHER_SPREAD;
  const v = Math.round(sum / n / Math.sqrt(3));
  return v < 1 ? 1 : v > 255 ? 255 : v;
}
