import { TILE_SIZE } from '@pixel-forge/schema';
import { RasterError } from './errors.js';
import type { SparseImage, TiledImage } from './image.js';
import { checkInts } from './store.js';

/** Options of {@link composite}. All optional. */
export interface CompositeOptions {
  /** Destination x of the source's top-left pixel (integer, may be negative). Default 0. */
  readonly x?: number;
  /** Destination y of the source's top-left pixel (integer, may be negative). Default 0. */
  readonly y?: number;
  /** Extra source opacity, integer 0 (nothing) .. 255 (as is). Default 255. */
  readonly opacity?: number;
}

/** `round(v / 255)` for an integer `v >= 0`: `floor((v + 127) / 255)`. 255 is odd, so there are no ties. */
export function div255(v: number): number {
  return Math.floor((v + 127) / 255);
}

/**
 * Normal "over" blend of one straight-alpha source pixel onto one straight-alpha destination pixel,
 * integer maths only (NFR-02). `sa` is the effective source alpha (already scaled by opacity), 1..255.
 *
 * ```
 * ida = 255 - sa
 * D   = 255*sa + da*ida                  // = 255 * (real result alpha)
 * outA = floor((D + 127) / 255)          // round(D / 255)
 * N_c  = 255*sa*sC + da*ida*dC           // per colour channel
 * outC = floor((2*N_c + D) / (2*D))      // round(N_c / D), exact rational rounding
 * ```
 * Because `N_c / D` is a weighted mean of `sC` and `dC`, `outC` stays in 0..255 and equals `sC` when `sa = 255`
 * or `da = 0`. If `outA = 0` cannot happen for `sa >= 1`. Results are written to `out[0..3]`.
 */
export function blendOver(
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  dr: number,
  dg: number,
  db: number,
  da: number,
  out: Uint8Array | number[],
): void {
  if (sa === 255 || da === 0) {
    out[0] = sr;
    out[1] = sg;
    out[2] = sb;
    out[3] = sa;
    return;
  }
  const ida = 255 - sa;
  const ws = 255 * sa;
  const wd = da * ida;
  const D = ws + wd;
  const D2 = 2 * D;
  out[0] = Math.floor((2 * (ws * sr + wd * dr) + D) / D2);
  out[1] = Math.floor((2 * (ws * sg + wd * dg) + D) / D2);
  out[2] = Math.floor((2 * (ws * sb + wd * db) + D) / D2);
  out[3] = Math.floor((D + 127) / 255);
}

/**
 * Composites `src` onto `dst` in place with the normal "over" operator (straight alpha, RGBA8).
 *
 * Rules, all integer (see {@link blendOver} for the exact formula):
 * 1. effective source alpha `sa = div255(srcAlpha * opacity)` where `div255(v) = floor((v + 127) / 255)`;
 *    `opacity = 255` leaves the alpha untouched;
 * 2. `sa = 0` skips the pixel; `sa = 255` or destination alpha 0 copies the source colour with alpha `sa`;
 * 3. otherwise the weighted formula of {@link blendOver}.
 *
 * Source pixels outside `dst` are clipped. Only tiles of `src` that are allocated are visited, and a
 * destination tile is allocated or copied (if shared) only when a pixel in it actually changes.
 * Throws `RasterError` for `dst === src`, non-integer `x`/`y`, or `opacity` outside 0..255.
 */
export function composite(dst: TiledImage, src: TiledImage, options: CompositeOptions = {}): void {
  const { x = 0, y = 0, opacity = 255 } = options;
  checkInts('composite offset', x, y);
  if (!Number.isInteger(opacity) || opacity < 0 || opacity > 255) {
    throw new RasterError('BAD_VALUE', `opacity must be an integer 0..255, got ${String(opacity)}`);
  }
  if (dst === src)
    throw new RasterError('SAME_IMAGE', 'cannot composite an image onto itself; clone it first');
  if (opacity === 0) return;

  const ds = dst.store;
  const W = dst.width;
  const H = dst.height;
  const px: number[] = [0, 0, 0, 0];
  let ck = -1;
  let cbuf: Uint8Array | undefined;
  let wbuf: Uint8Array | undefined;

  try {
    for (const tile of src.tiles()) {
      const sx0 = Math.max(0, -x - tile.x);
      const sy0 = Math.max(0, -y - tile.y);
      const sx1 = Math.min(TILE_SIZE, src.width - tile.x, W - x - tile.x);
      const sy1 = Math.min(TILE_SIZE, src.height - tile.y, H - y - tile.y);
      for (let ly = sy0; ly < sy1; ly++) {
        const dy = y + tile.y + ly;
        for (let lx = sx0; lx < sx1; lx++) {
          const so = (ly * TILE_SIZE + lx) * 4;
          const a = tile.data[so + 3] ?? 0;
          if (a === 0) continue;
          const sa = opacity === 255 ? a : div255(a * opacity);
          if (sa === 0) continue;
          const dx = x + tile.x + lx;
          const key = ds.keyOf(dx, dy);
          if (key !== ck) {
            ck = key;
            cbuf = ds.peek(key);
            wbuf = undefined;
          }
          const dof = ds.offsetOf(dx, dy);
          const da = cbuf === undefined ? 0 : (cbuf[dof + 3] ?? 0);
          blendOver(
            tile.data[so] ?? 0,
            tile.data[so + 1] ?? 0,
            tile.data[so + 2] ?? 0,
            sa,
            cbuf === undefined ? 0 : (cbuf[dof] ?? 0),
            cbuf === undefined ? 0 : (cbuf[dof + 1] ?? 0),
            cbuf === undefined ? 0 : (cbuf[dof + 2] ?? 0),
            da,
            px,
          );
          if (
            cbuf !== undefined &&
            cbuf[dof] === px[0] &&
            cbuf[dof + 1] === px[1] &&
            cbuf[dof + 2] === px[2] &&
            cbuf[dof + 3] === px[3]
          ) {
            continue;
          }
          wbuf ??= ds.writable(key);
          cbuf = wbuf;
          const t = wbuf;
          t[dof] = px[0] ?? 0;
          t[dof + 1] = px[1] ?? 0;
          t[dof + 2] = px[2] ?? 0;
          t[dof + 3] = px[3] ?? 0;
        }
      }
    }
  } finally {
    ds.commit();
  }
}

/** Options of {@link blit}. */
export interface BlitOptions {
  /**
   * When `true`, every source pixel of the clipped rectangle is copied, empty ones too (the destination
   * rectangle is overwritten, erasing what was there). Default `false`: only non-empty source pixels are copied.
   */
  readonly replace?: boolean;
}

/**
 * Copies pixels of `src` into `dst` at `(x, y)` with **no blending** (stamp). Works on two `TiledImage`s or
 * two `IndexedImage`s with the same `transparentIndex`; anything else throws `RasterError('MISMATCH')`.
 * "Non-empty" is alpha != 0 (RGBA) or `index != transparentIndex` (indexed). Clipped to `dst`.
 */
export function blit<T extends SparseImage>(
  dst: T,
  src: T,
  x: number,
  y: number,
  options: BlitOptions = {},
): void {
  checkInts('blit offset', x, y);
  const ds = dst.store;
  const ss = src.store;
  if (dst === src)
    throw new RasterError('SAME_IMAGE', 'cannot blit an image onto itself; clone it first');
  if (ds.channels !== ss.channels || ds.fill !== ss.fill) {
    throw new RasterError(
      'MISMATCH',
      'blit needs two images of the same kind and transparent index',
    );
  }
  const empty = new Uint8Array(ds.channels).fill(ds.fill);
  try {
    if (options.replace === true) {
      const x0 = Math.max(0, x);
      const y0 = Math.max(0, y);
      const x1 = Math.min(dst.width, x + src.width);
      const y1 = Math.min(dst.height, y + src.height);
      for (let dy = y0; dy < y1; dy++) {
        for (let dx = x0; dx < x1; dx++) {
          const sx = dx - x;
          const sy = dy - y;
          const buf = ss.peek(ss.keyOf(sx, sy));
          if (buf === undefined) ds.setRaw(dx, dy, empty, 0);
          else ds.setRaw(dx, dy, buf, ss.offsetOf(sx, sy));
        }
      }
    } else {
      ss.forEachStored((sx, sy, buf, off) => {
        const dx = x + sx;
        const dy = y + sy;
        if (!ds.inBounds(dx, dy) || !ss.isVisible(buf, off)) return;
        ds.setRaw(dx, dy, buf, off);
      });
    }
  } finally {
    ds.commit();
  }
}
