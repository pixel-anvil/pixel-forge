/**
 * Clean-up (FR-CONV-07): alpha threshold, orphan removal, optional outline.
 *
 * Methods (all standard, nothing ported):
 * - Alpha threshold: one cut, `alpha >= alphaThreshold` is visible (alpha 255), the rest is `0,0,0,0`.
 * - Orphans: connected-component labelling of the visible pixels by an iterative flood fill, with the
 *   4- and 8-connectivity of A. Rosenfeld, "Connectivity in digital pictures", J. ACM 17(1), 1970.
 *   Components smaller than `orphanMinSize` are removed.
 * - Outline: `outline` of `@pixel-forge/raster` (outer outline, only transparent pixels are painted,
 *   canvas grown by 1 px); this module adds the colour rule.
 * @packageDocumentation
 */
import { TiledImage, outline as rasterOutline } from '@pixel-forge/raster';
import type { RgbaImage } from '@pixel-forge/raster';
import type { RgbTriple } from './background.js';
import { assertImage, cropImage } from './crop.js';
import { ConvertError } from './errors.js';
import { DEFAULT_ALPHA_THRESHOLD } from './quantize.js';

/** Default `orphanMinSize`: components of one pixel (isolated pixels) are removed. */
export const DEFAULT_ORPHAN_MIN_SIZE = 2;
/** Default `shade` of a darkened outline, in percent of the neighbour colour. */
export const DEFAULT_OUTLINE_SHADE = 35;

/** The optional 1 px outline of {@link cleanup}. */
export interface CleanupOutline {
  /**
   * Outline colour: an RGB triple (alpha 255), or `'darken'` (default): each outline pixel takes the mean
   * colour of the visible pixels it touches, scaled to `shade` percent (a "selective outline").
   */
  readonly color?: RgbTriple | 'darken';
  /** `'darken'` only: percent of the neighbour mean that is kept, integer 0..100. Default {@link DEFAULT_OUTLINE_SHADE}. */
  readonly shade?: number;
  /** `'round'` (default): a pixel is outlined when one of its 4 edge neighbours is visible, so convex corners stay open. `'square'`: 8 neighbours, corners are filled. */
  readonly corners?: 'round' | 'square';
  /**
   * `'grow'` (default): the canvas grows by 1 px on every side, so no outline is clipped; input pixel
   * `(x, y)` is output pixel `(x + 1, y + 1)`. `'keep'`: the result is cropped back to the input size
   * and an outline that lies outside it is lost.
   */
  readonly canvas?: 'grow' | 'keep';
}

/** Options of {@link cleanup}. */
export interface CleanupOptions {
  /** Pixels with alpha at least this (integer 1..255) become opaque, the rest transparent. Default {@link DEFAULT_ALPHA_THRESHOLD}. */
  readonly alphaThreshold?: number;
  /**
   * Visible components with fewer pixels than this are removed; integer >= 1. Default
   * {@link DEFAULT_ORPHAN_MIN_SIZE} (2: isolated pixels go). 1 removes nothing.
   */
  readonly orphanMinSize?: number;
  /**
   * Which neighbours join a component: `8` (default; edge and diagonal) or `4` (edge only). With 8, a
   * diagonal line stays whole; with 4 every pixel of a 1 px diagonal line is its own component and
   * would be removed with `orphanMinSize >= 2`.
   */
  readonly connectivity?: 4 | 8;
  /** Add an outline. Absent: none. */
  readonly outline?: CleanupOutline;
}

/** Result of {@link cleanup}. */
export interface CleanupResult {
  /** The cleaned image. Opaque pixels have alpha 255, the others are `0,0,0,0`. */
  readonly image: RgbaImage;
  /** Number of pixels removed as orphans. */
  readonly removedPixels: number;
  /** Number of outline pixels added (0 without an outline). */
  readonly outlinePixels: number;
  /** Where input pixel `(0, 0)` sits in `image`: `{x: 1, y: 1}` after a growing outline, else `{x: 0, y: 0}`. */
  readonly offset: { readonly x: number; readonly y: number };
}

const N4: readonly (readonly [number, number])[] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];
const N8: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function checkInt(name: string, v: number, lo: number, hi: number): void {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new ConvertError('BAD_OPTION', `${name} must be an integer ${String(lo)}..${String(hi)}`);
  }
}

/** Removes visible components smaller than `minSize`; returns the number of pixels removed. */
function removeSmallComponents(
  img: RgbaImage,
  minSize: number,
  offs: readonly (readonly [number, number])[],
): number {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const members: number[] = [];
  let removed = 0;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] === 1 || (data[start * 4 + 3] ?? 0) === 0) continue;
    seen[start] = 1;
    stack.push(start);
    members.length = 0;
    for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
      members.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (const [dx, dy] of offs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (seen[q] === 0 && (data[q * 4 + 3] ?? 0) !== 0) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (members.length < minSize) {
      for (const p of members) data.fill(0, p * 4, p * 4 + 4);
      removed += members.length;
    }
  }
  return removed;
}

/** Adds the outline to a binarised image; returns the grown or cropped image and the number of pixels painted. */
function addOutline(
  img: RgbaImage,
  spec: CleanupOutline,
): { image: RgbaImage; painted: number; offset: number } {
  const colorSpec = spec.color ?? 'darken';
  const shade = spec.shade ?? DEFAULT_OUTLINE_SHADE;
  const corners = spec.corners ?? 'round';
  const canvas = spec.canvas ?? 'grow';
  if (!(['round', 'square'] as readonly string[]).includes(corners)) {
    throw new ConvertError('BAD_OPTION', `outline corners must be 'round' or 'square'`);
  }
  if (!(['grow', 'keep'] as readonly string[]).includes(canvas)) {
    throw new ConvertError('BAD_OPTION', `outline canvas must be 'grow' or 'keep'`);
  }
  checkInt('outline shade', shade, 0, 100);
  if (
    colorSpec !== 'darken' &&
    (!Array.isArray(colorSpec) ||
      (colorSpec as readonly number[]).length !== 3 ||
      !colorSpec.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
  ) {
    throw new ConvertError(
      'BAD_OPTION',
      `outline colour must be three integers 0..255 or 'darken'`,
    );
  }
  const fixed: readonly [number, number, number] =
    colorSpec === 'darken' ? [0, 0, 0] : [colorSpec[0], colorSpec[1], colorSpec[2]];
  const grown = rasterOutline(TiledImage.fromRGBA(img), [fixed[0], fixed[1], fixed[2], 255], {
    outsideOnly: true,
    corners,
  }).img.toRGBA();
  const gw = grown.width;
  const gh = grown.height;
  const out = grown.data;
  const offs = corners === 'square' ? N8 : N4;
  let painted = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const inside = x >= 1 && y >= 1 && x <= img.width && y <= img.height;
      const wasVisible = inside && (img.data[((y - 1) * img.width + x - 1) * 4 + 3] ?? 0) !== 0;
      if (wasVisible || (out[(y * gw + x) * 4 + 3] ?? 0) === 0) continue;
      painted++;
      if (colorSpec !== 'darken') continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (const [dx, dy] of offs) {
        const sx = x + dx - 1;
        const sy = y + dy - 1;
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        const s = (sy * img.width + sx) * 4;
        if ((img.data[s + 3] ?? 0) === 0) continue;
        r += img.data[s] ?? 0;
        g += img.data[s + 1] ?? 0;
        b += img.data[s + 2] ?? 0;
        n++;
      }
      const o = (y * gw + x) * 4;
      // mean rounded half up, then scaled to shade percent (rounded half up); integer maths only
      const f = (sum: number): number =>
        Math.floor((Math.floor((sum * 2 + n) / (2 * n)) * shade * 2 + 100) / 200);
      out[o] = f(r);
      out[o + 1] = f(g);
      out[o + 2] = f(b);
    }
  }
  if (canvas === 'keep') {
    return {
      image: cropImage(grown, { x: 1, y: 1, w: img.width, h: img.height }),
      painted: countOutlineKept(grown, img),
      offset: 0,
    };
  }
  return { image: grown, painted, offset: 1 };
}

/** Outline pixels that survive a crop back to the input size. */
function countOutlineKept(grown: RgbaImage, img: RgbaImage): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const was = (img.data[(y * img.width + x) * 4 + 3] ?? 0) !== 0;
      const now = (grown.data[((y + 1) * grown.width + x + 1) * 4 + 3] ?? 0) !== 0;
      if (now && !was) n++;
    }
  }
  return n;
}

/**
 * Cleans up a converted sprite (FR-CONV-07). Pure and deterministic; the input is not changed. Steps,
 * in this order:
 *
 * 1. **Alpha threshold.** One cut: alpha `>= alphaThreshold` becomes 255 (RGB kept), the rest becomes
 *    `0,0,0,0`. The default is {@link DEFAULT_ALPHA_THRESHOLD}, the value `downscale` and `quantize`
 *    use too; the recipe runner passes one value to all three.
 * 2. **Orphans.** Components of visible pixels (8-connected by default) smaller than `orphanMinSize` are
 *    removed. The size counts pixels of the component, whatever their colour.
 * 3. **Outline** (optional). An outer outline of 1 px: a transparent pixel next to a visible one (4
 *    neighbours, or 8 with `corners: 'square'`) that is connected to the outside of the sprite through
 *    transparent pixels. Holes are not outlined. Visible pixels are never overwritten. The colour is
 *    fixed, or `'darken'`: the mean of the touching visible pixels scaled to `shade` percent. The
 *    outline is opaque (alpha 255). The canvas grows by 1 px on each side unless `canvas: 'keep'`.
 *
 * @returns the image plus counts and the position of the input origin
 * @throws ConvertError `BAD_OPTION` for a bad threshold, size, connectivity or outline field; `BAD_IMAGE`
 */
export function cleanup(img: RgbaImage, opts: CleanupOptions = {}): CleanupResult {
  assertImage(img);
  const threshold = opts.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  checkInt('alphaThreshold', threshold, 1, 255);
  const minSize = opts.orphanMinSize ?? DEFAULT_ORPHAN_MIN_SIZE;
  checkInt('orphanMinSize', minSize, 1, Number.MAX_SAFE_INTEGER);
  const conn: number = opts.connectivity ?? 8;
  if (conn !== 4 && conn !== 8) {
    throw new ConvertError('BAD_OPTION', 'connectivity must be 4 or 8');
  }
  const data = img.data.slice();
  for (let p = 0; p < img.width * img.height; p++) {
    if ((data[p * 4 + 3] ?? 0) >= threshold) data[p * 4 + 3] = 255;
    else data.fill(0, p * 4, p * 4 + 4);
  }
  const bin: RgbaImage = { width: img.width, height: img.height, data };
  const removedPixels = minSize > 1 ? removeSmallComponents(bin, minSize, conn === 4 ? N4 : N8) : 0;
  if (opts.outline === undefined) {
    return { image: bin, removedPixels, outlinePixels: 0, offset: { x: 0, y: 0 } };
  }
  const o = addOutline(bin, opts.outline);
  return {
    image: o.image,
    removedPixels,
    outlinePixels: o.painted,
    offset: { x: o.offset, y: o.offset },
  };
}
