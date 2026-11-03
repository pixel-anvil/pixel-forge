/**
 * Dither threshold matrices and error-diffusion weights (FR-CONV-06).
 *
 * Sources (published algorithms, implemented from the descriptions, no code ported):
 * - Bayer matrices: B. E. Bayer, "An optimum method for two-level rendition of continuous-tone
 *   pictures", IEEE ICC 1973. The recursive rule `M(2n) = [[4M, 4M+2], [4M+3, 4M+1]]` with
 *   `M(2) = [[0, 2], [3, 1]]` is the standard construction (also described in the Wikipedia article
 *   "Ordered dithering"; used for the description only).
 * - Floyd-Steinberg weights 7/16, 3/16, 5/16, 1/16: R. W. Floyd and L. Steinberg, "An adaptive
 *   algorithm for spatial grey scale", Proc. SID 17/2, 1976.
 * @packageDocumentation
 */

/** Ordered-dither matrix sizes supported by {@link bayerMatrix}. */
export type BayerSize = 2 | 4 | 8;

const cache = new Map<BayerSize, readonly number[]>();

/**
 * The `n x n` Bayer index matrix, row-major, values `0 .. n*n-1`, each exactly once.
 * Built by Bayer's recursion; for n = 2: `[0,2,3,1]`.
 */
export function bayerMatrix(n: BayerSize): readonly number[] {
  const hit = cache.get(n);
  if (hit !== undefined) return hit;
  let m: number[] = [0, 2, 3, 1];
  let size = 2;
  while (size < n) {
    const next = size * 2;
    const out = new Array<number>(next * next).fill(0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = 4 * (m[y * size + x] ?? 0);
        out[y * next + x] = v;
        out[y * next + x + size] = v + 2;
        out[(y + size) * next + x] = v + 3;
        out[(y + size) * next + x + size] = v + 1;
      }
    }
    m = out;
    size = next;
  }
  cache.set(n, m);
  return m;
}

/**
 * Threshold at pixel `(x, y)` in `[-0.5, 0.5)`: `(M[y mod n][x mod n] + 0.5) / n^2 - 0.5`.
 * The matrix tiles from the image origin, so a crop that moves the origin moves the pattern.
 */
export function bayerThreshold(n: BayerSize, x: number, y: number): number {
  const m = bayerMatrix(n);
  const v = m[(y % n) * n + (x % n)] ?? 0;
  return (v + 0.5) / (n * n) - 0.5;
}

/** One Floyd-Steinberg tap: offset from the current pixel and its weight numerator (denominator 16). */
export interface DiffusionTap {
  readonly dx: number;
  readonly dy: number;
  readonly weight: number;
}

/**
 * Floyd-Steinberg taps in the fixed order used by the quantiser: right (7), below-left (3),
 * below (5), below-right (1); all over 16.
 */
export const FLOYD_STEINBERG: readonly DiffusionTap[] = [
  { dx: 1, dy: 0, weight: 7 },
  { dx: -1, dy: 1, weight: 3 },
  { dx: 0, dy: 1, weight: 5 },
  { dx: 1, dy: 1, weight: 1 },
];
