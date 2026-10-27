import { RasterError } from '../errors.js';
import { IndexedImage, TiledImage } from '../image.js';
import type { Rgba } from '../image.js';
import { N4, N8, opaqueFn } from './shared.js';

/** Options of {@link outline}. */
export interface OutlineOptions {
  /** `true` (default): outline only the outer silhouette. `false`: also outline the inside of holes. */
  outsideOnly?: boolean;
  /**
   * `'square'`: a transparent pixel is outlined when any of its 8 neighbours is opaque, so
   * convex corners get their diagonal pixel. `'round'` (default): only the 4 edge neighbours count, so the
   * diagonal corner pixel is omitted (the rounded pixel-art look). (The schema's boolean `corners`
   * maps `true` to `'square'`, `false` or absent to `'round'`, so the defaults agree.)
   */
  corners?: 'square' | 'round';
}

/** Result of {@link outline}: the grown image and where the input's (0, 0) sits inside it. */
export interface OutlineResult<T> {
  /** `(width + 2) x (height + 2)` image of the input's kind. */
  img: T;
  /** Always `{ x: 1, y: 1 }`: input pixel `(x, y)` is output pixel `(x + 1, y + 1)`. */
  offset: { readonly x: number; readonly y: number };
}

/**
 * Adds a 1-px outline around the opaque regions (opaque = alpha not 0 / index not `transparentIndex`).
 * Only transparent pixels are ever painted: existing opaque pixels are copied unchanged.
 *
 * Canvas: the result is always GROWN by 1 px on every side, so an outline touching the border is never
 * clipped; the rig renderer shifts the part's placement by `-offset` (the pivot moves with the pixels).
 * Callers who want the old canvas can `crop` it. The input is not modified.
 *
 * "Outside" means reachable from the outer rim of the grown canvas through transparent pixels using
 * 4-connectivity (the dual of the 8-connected shape, so a diagonal-only gap in a ring counts as closed).
 * With `outsideOnly: true`, transparent pixels not reachable that way (holes) are never outlined.
 *
 * RGBA images take an `Rgba` colour (alpha must be non-zero); indexed images take a palette index
 * (must differ from `transparentIndex`).
 */
export function outline(
  img: TiledImage,
  colour: Rgba,
  opts?: OutlineOptions,
): OutlineResult<TiledImage>;
export function outline(
  img: IndexedImage,
  colour: number,
  opts?: OutlineOptions,
): OutlineResult<IndexedImage>;
export function outline(
  img: TiledImage | IndexedImage,
  colour: Rgba | number,
  opts: OutlineOptions = {},
): OutlineResult<TiledImage | IndexedImage> {
  const outsideOnly = opts.outsideOnly ?? true;
  const corners: string = opts.corners ?? 'round';
  if (corners !== 'square' && corners !== 'round') {
    throw new RasterError('BAD_VALUE', `corners must be 'square' or 'round'`);
  }
  const W = img.width + 2;
  const H = img.height + 2;
  let out: TiledImage | IndexedImage;
  let paint: (x: number, y: number) => void;
  if (img instanceof TiledImage) {
    if (typeof colour === 'number' || colour[3] === 0) {
      throw new RasterError('BAD_VALUE', 'RGBA outline needs an Rgba colour with alpha > 0');
    }
    const t = new TiledImage(W, H);
    out = t;
    paint = (x, y) => void t.set(x, y, colour);
  } else {
    if (typeof colour !== 'number' || colour === img.transparentIndex) {
      throw new RasterError(
        'BAD_VALUE',
        'indexed outline needs a palette index != transparentIndex',
      );
    }
    const t = new IndexedImage(W, H, img.transparentIndex);
    out = t;
    paint = (x, y) => void t.set(x, y, colour);
  }
  // Opaque mask of the grown canvas (1 = opaque), copying the source pixels as we go.
  const opaque = opaqueFn(img);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!opaque(x, y)) continue;
      mask[(y + 1) * W + x + 1] = 1;
      if (img instanceof TiledImage && out instanceof TiledImage) {
        out.set(x + 1, y + 1, img.get(x, y));
      } else if (img instanceof IndexedImage && out instanceof IndexedImage) {
        out.set(x + 1, y + 1, img.get(x, y));
      }
    }
  }
  // Exterior = transparent pixels 4-connected to the rim.
  const outside = new Uint8Array(W * H);
  if (outsideOnly) {
    const stack: number[] = [0]; // the rim is always transparent (grown by 1)
    outside[0] = 1;
    while (stack.length > 0) {
      const i = stack.pop();
      if (i === undefined) break;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (mask[j] === 0 && outside[j] === 0) {
          outside[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  const offs = corners === 'square' ? N8 : N4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 1 || (outsideOnly && outside[i] === 0)) continue;
      for (const [dx, dy] of offs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && mask[ny * W + nx] === 1) {
          paint(x, y);
          break;
        }
      }
    }
  }
  return { img: out, offset: { x: 1, y: 1 } };
}
