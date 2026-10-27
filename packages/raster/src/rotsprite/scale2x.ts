import type { Packed } from './packed.js';

/**
 * @internal Scale2x on a dense packed block, from its public description by Andrea Mazzoleni
 * (Scale2x, https://www.scale2x.it/algorithm.html; the same rule as AdvMAME2x). It is the "EPX"
 * rule that Eric Johnston devised for LucasArts' SCUMM-era ports. Written from that description, not
 * from any other implementation.
 *
 * Every source pixel `E` with 4-neighbours `B` (above), `D` (left), `F` (right), `H` (below) becomes
 * a 2×2 block `E0 E1 / E2 E3`, chosen by exact equality:
 *
 * ```
 * if (B != H && D != F) {
 *   E0 = D == B ? D : E      E1 = B == F ? F : E
 *   E2 = D == H ? D : E      E3 = H == F ? F : E
 * } else { E0 = E1 = E2 = E3 = E }
 * ```
 *
 * which is Mazzoleni's `E0 = D == B && B != F && D != H ? D : E` (and likewise for `E1..E3`) once the
 * equality in each corner is substituted into its inequalities. The code below tests the `B != H &&
 * D != F` guard first, then the four corner equalities.
 *
 * Neighbours outside the block read as `empty`, i.e. the block is surrounded by transparency. That
 * makes the result independent of how much transparent margin the source image had (unlike edge
 * replication; see the README). The rules are symmetric under the dihedral group, so
 * `scale2x(flip(I)) = flip(scale2x(I))` exactly. Only copies existing values: no new colours.
 */
export function scale2x(src: Packed, empty: number): Packed {
  const { w, h, p } = src;
  const W = w * 2;
  const o = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const o0 = y * 2 * W;
    const o1 = o0 + W;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const E = p[i] ?? empty;
      const B = y > 0 ? (p[i - w] ?? empty) : empty;
      const H = y < h - 1 ? (p[i + w] ?? empty) : empty;
      const D = x > 0 ? (p[i - 1] ?? empty) : empty;
      const F = x < w - 1 ? (p[i + 1] ?? empty) : empty;
      const X = x * 2;
      if (B === H || D === F) {
        o[o0 + X] = E;
        o[o0 + X + 1] = E;
        o[o1 + X] = E;
        o[o1 + X + 1] = E;
        continue;
      }
      o[o0 + X] = D === B ? D : E;
      o[o0 + X + 1] = B === F ? F : E;
      o[o1 + X] = D === H ? D : E;
      o[o1 + X + 1] = H === F ? F : E;
    }
  }
  return { w: W, h: h * 2, p: o };
}

/** @internal Three Scale2x passes: the ×8 image RotSprite samples from. */
export function scale8(src: Packed, empty: number): Packed {
  return scale2x(scale2x(scale2x(src, empty), empty), empty);
}
