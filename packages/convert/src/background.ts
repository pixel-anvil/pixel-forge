import type { RgbaImage } from '@pixel-forge/raster';
import { assertImage } from './crop.js';
import { ConvertError } from './errors.js';

/** An opaque RGB colour, channels 0..255 integers. */
export type RgbTriple = readonly [number, number, number];

/** Where the key or flood reference colour comes from. */
export type BackgroundColor = RgbTriple | 'auto';

/** Remove nothing; returns a copy. */
export interface BackgroundNone {
  readonly mode: 'none';
}

/** Colour key: every pixel close to the key colour becomes transparent. */
export interface BackgroundKey {
  readonly mode: 'key';
  /** Key colour, or `'auto'` (default) for the most common corner colour (see {@link autoKeyColor}). */
  readonly color?: BackgroundColor;
  /** Max RGB distance (see {@link rgbDistanceSq}), 0..442. Default 0 = exact match. */
  readonly tolerance?: number;
}

/** Edge flood fill: only pixels connected (4-way) to the border become transparent. */
export interface BackgroundFlood {
  readonly mode: 'flood';
  /** Reference colour, or `'auto'` (default) for the most common corner colour. */
  readonly color?: BackgroundColor;
  /** Max RGB distance to the reference colour, 0..442. Default 0. */
  readonly tolerance?: number;
}

/** Keep the existing alpha; optionally drop weak pixels. */
export interface BackgroundAlpha {
  readonly mode: 'alpha';
  /** Pixels with alpha below this (0..255) become fully transparent. Default 0 = change nothing. */
  readonly threshold?: number;
}

/** Options of the `removeBackground` step. Becomes the `background` recipe field later (E4.4). */
export type BackgroundOptions = BackgroundNone | BackgroundKey | BackgroundFlood | BackgroundAlpha;

/** Largest tolerance accepted, above the largest RGB distance `sqrt(3 * 255^2) = 441.67`. */
export const MAX_RGB_TOLERANCE = 442;

/**
 * Squared Euclidean distance in 8-bit sRGB. Integer maths, so identical on every platform. A pixel
 * matches when `rgbDistanceSq <= floor(tolerance^2)`. RGB was chosen over OKLab because the user picks
 * the key colour from the screen and the result must not depend on floating point.
 */
export function rgbDistanceSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * The most common colour of the four corners, ignoring alpha, skipping fully transparent corners.
 * Ties go to the first in the order top-left, top-right, bottom-left, bottom-right.
 * @returns the colour, or `undefined` if every corner is fully transparent
 */
export function autoKeyColor(img: RgbaImage): RgbTriple | undefined {
  assertImage(img);
  const { width: w, height: h, data } = img;
  const corners: RgbTriple[] = [];
  for (const [cx, cy] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ] as const) {
    const o = (cy * w + cx) * 4;
    if ((data[o + 3] ?? 0) === 0) continue;
    corners.push([data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0]);
  }
  let best: RgbTriple | undefined;
  let bestCount = 0;
  for (const c of corners) {
    let n = 0;
    for (const d of corners) if (d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) n++;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function checkTolerance(t: number | undefined): number {
  const v = t ?? 0;
  if (!Number.isFinite(v) || v < 0 || v > MAX_RGB_TOLERANCE) {
    throw new ConvertError('BAD_OPTION', `tolerance must be 0..${String(MAX_RGB_TOLERANCE)}`);
  }
  return v;
}

function resolveColor(img: RgbaImage, c: BackgroundColor | undefined): RgbTriple | undefined {
  if (c === undefined || c === 'auto') return autoKeyColor(img);
  if (
    (c as readonly number[]).length !== 3 ||
    !c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  ) {
    throw new ConvertError('BAD_OPTION', 'colour must be three integers 0..255 or "auto"');
  }
  return c;
}

/** Makes pixel `p` fully transparent. RGB is zeroed too, so equal images hash equal. */
function clear(data: Uint8Array, p: number): void {
  data.fill(0, p * 4, p * 4 + 4);
}

/**
 * Removes the background of `img` and returns a new image; the input is not changed. Removed pixels
 * become `0,0,0,0`. Pure and deterministic (integer maths, fixed scan order).
 *
 * - `none`: copy.
 * - `key`: every pixel whose RGB is within `tolerance` of the key colour becomes transparent, wherever it is.
 * - `flood`: the same match test, but only pixels reachable from the image border through matching
 *   pixels (4-connected) are cleared, so a same-colour area enclosed by the subject stays. Every pixel
 *   is compared with the reference colour, not with its neighbour, so soft gradients do not creep.
 *   Pixels that are already fully transparent count as matching and are passable.
 * - `alpha`: pixels with alpha below `threshold` become transparent; the rest keep their alpha.
 *
 * With `color: 'auto'` and four transparent corners, `key` does nothing and `flood` only clears
 * border-connected pixels that are already transparent (so the colours of the rest stay).
 * @throws ConvertError `BAD_OPTION` for an out-of-range tolerance, threshold or colour; `BAD_IMAGE`
 */
export function removeBackground(img: RgbaImage, opts: BackgroundOptions): RgbaImage {
  assertImage(img);
  const { width: w, height: h } = img;
  const data = img.data.slice();
  const out: RgbaImage = { width: w, height: h, data };
  const n = w * h;
  switch (opts.mode) {
    case 'none':
      return out;
    case 'alpha': {
      const t = opts.threshold ?? 0;
      if (!Number.isInteger(t) || t < 0 || t > 255) {
        throw new ConvertError('BAD_OPTION', 'alpha threshold must be an integer 0..255');
      }
      for (let p = 0; p < n; p++) if ((data[p * 4 + 3] ?? 0) < t) clear(data, p);
      return out;
    }
    case 'key':
    case 'flood': {
      const tol = checkTolerance(opts.tolerance);
      const tolSq = Math.floor(tol * tol);
      const ref = resolveColor(img, opts.color);
      const isFlood = opts.mode === 'flood';
      // Tests the unchanged input (`img.data`), so clearing never affects later tests.
      const src = img.data;
      const matches = (p: number): boolean => {
        const o = p * 4;
        if ((src[o + 3] ?? 0) === 0) return isFlood;
        if (ref === undefined) return false;
        return (
          rgbDistanceSq(src[o] ?? 0, src[o + 1] ?? 0, src[o + 2] ?? 0, ref[0], ref[1], ref[2]) <=
          tolSq
        );
      };
      if (!isFlood) {
        for (let p = 0; p < n; p++) if (matches(p)) clear(data, p);
        return out;
      }
      const seen = new Uint8Array(n);
      const stack: number[] = [];
      const push = (p: number): void => {
        if (seen[p] === 0 && matches(p)) {
          seen[p] = 1;
          stack.push(p);
        }
      };
      for (let x = 0; x < w; x++) {
        push(x);
        push((h - 1) * w + x);
      }
      for (let y = 0; y < h; y++) {
        push(y * w);
        push(y * w + w - 1);
      }
      for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
        const x = p % w;
        if (x > 0) push(p - 1);
        if (x < w - 1) push(p + 1);
        if (p >= w) push(p - w);
        if (p < n - w) push(p + w);
      }
      for (let p = 0; p < n; p++) if (seen[p] === 1) clear(data, p);
      return out;
    }
  }
}
