/**
 * Downscale (FR-CONV-03 target, FR-CONV-04 methods). The source is cut into rectangular cells, one
 * per output pixel, and each cell gives one colour.
 *
 * Cells:
 * - **Size target** (`width` and/or `height`): output column `i` of `W` covers source columns
 *   `floor(i*w/W) .. floor((i+1)*w/W) - 1` (the same for rows). With only one of `width` or
 *   `height`, the other keeps the aspect: `round(h * W / w)`, at least 1. A target larger than the
 *   source is refused (use `scaleInt` in `@pixel-forge/raster` to upscale).
 * - **Grid target** (`grid`, for example a `GridFound` from `detectGrid`): cells of the grid's size
 *   starting at its offset. A partial cell at an edge (left of the offset, or cut off at the right or
 *   bottom) is kept by default (`edges: 'keep'`), so no source pixel is lost; `edges: 'drop'` leaves
 *   them out.
 *
 * Alpha (the same for every method): a pixel is *visible* when its alpha is at least
 * `alphaThreshold` (default 128). A cell where fewer than half of the pixels are visible becomes
 * `0,0,0,0`; a tie keeps the cell, so thin features survive. Otherwise the colour comes from the
 * visible pixels only, so the RGB of hidden pixels never leaks in.
 *
 * Methods:
 * - `box`: average of the visible pixels in 8-bit sRGB, RGB weighted by alpha (premultiplied
 *   average), alpha is the plain mean of the visible alphas; integers rounded half up.
 * - `nearest`: the visible pixel nearest to the cell centre (squared distance in half pixels; ties
 *   go to the first in row-major order, so an even-sized cell takes the top-left of its middle 2x2).
 * - `mode`: the most common RGBA among the visible pixels; ties go to the colour seen first in
 *   row-major order.
 * - `kcentroid`: k-means in OKLab over the cell's visible colours, then the centroid of the
 *   heaviest cluster (see {@link KCENTROID_MAX_ITERATIONS}). This is the "K-Centroid" downscale idea
 *   as publicly described by Astropulse (2023): per output tile, cluster the tile's colours with a
 *   small k and keep the dominant cluster. Written here from that description only, on top of
 *   Lloyd's algorithm (Lloyd, "Least squares quantization in PCM", IEEE Trans. IT 28(2), 1982) with
 *   deterministic farthest-point seeding (Gonzalez, "Clustering to minimize the maximum
 *   intercluster distance", Theor. Comput. Sci. 38, 1985).
 *
 * Determinism: cells, `box`, `nearest` and `mode` are integer maths. `kcentroid` uses the
 * deterministic OKLab of `@pixel-forge/color` with sums in a fixed order, so it is bit-identical on
 * every platform. A cluster made of one distinct colour returns that colour exactly.
 * @packageDocumentation
 */
import { oklabDistanceSq, oklabToSrgb8, srgb8ToOklab } from '@pixel-forge/color';
import type { Oklab } from '@pixel-forge/color';
import type { RgbaImage } from '@pixel-forge/raster';
import { assertImage } from './crop.js';
import { ConvertError } from './errors.js';
import type { GridSpec } from './grid.js';
import { DEFAULT_ALPHA_THRESHOLD } from './quantize.js';

/** How one cell becomes one pixel. */
export type DownscaleMethod = 'box' | 'kcentroid' | 'nearest' | 'mode';

/** Every method, in a fixed order (for recipes and option lists). */
export const DOWNSCALE_METHODS: readonly DownscaleMethod[] = [
  'box',
  'kcentroid',
  'nearest',
  'mode',
];

/**
 * Options of the `downscale` step. Give a size target (`width`, `height` or both) **or** a `grid`,
 * not both. Becomes the `downscale` recipe field later (E4.4).
 */
export interface DownscaleOptions {
  /** How each cell becomes one pixel. */
  readonly method: DownscaleMethod;
  /** Output width, integer 1..source width. Alone, the height keeps the aspect. */
  readonly width?: number;
  /** Output height, integer 1..source height. Alone, the width keeps the aspect. */
  readonly height?: number;
  /** Sample per cell of this grid instead of a size target. */
  readonly grid?: GridSpec;
  /** Grid target only: `'keep'` (default) keeps partial cells at the image edges, `'drop'` leaves them out. */
  readonly edges?: 'keep' | 'drop';
  /** Pixels with alpha at least this (integer 1..255) are visible. Default {@link DEFAULT_ALPHA_THRESHOLD}. */
  readonly alphaThreshold?: number;
  /** `kcentroid` only: number of clusters, integer 1..{@link MAX_KCENTROID_K}. Default {@link DEFAULT_KCENTROID_K}. */
  readonly k?: number;
}

/** Default `k` of `kcentroid`. */
export const DEFAULT_KCENTROID_K = 2;
/** Largest `k` of `kcentroid`. */
export const MAX_KCENTROID_K = 8;
/** Lloyd iteration limit of `kcentroid` per cell (it stops earlier when no assignment changes). */
export const KCENTROID_MAX_ITERATIONS = 16;

function isInt(v: number, lo: number, hi: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/** `[0, floor(w/W), floor(2w/W), ..., w]` in integer maths. */
function evenCuts(src: number, out: number): number[] {
  const cuts: number[] = [];
  for (let i = 0; i <= out; i++) {
    const num = i * src;
    cuts.push((num - (num % out)) / out);
  }
  return cuts;
}

/** Cell edges along one axis of a grid target. */
function gridCuts(n: number, cell: number, offset: number, keep: boolean): number[] {
  const cuts: number[] = [];
  if (offset > 0 && keep) cuts.push(0);
  for (let s = offset; s < n; s += cell) {
    if (s + cell > n && !keep) break;
    cuts.push(s);
  }
  const last = cuts.at(-1);
  if (last !== undefined) cuts.push(keep ? n : Math.min(n, last + cell));
  return cuts;
}

function checkGrid(g: GridSpec): void {
  if (
    !isInt(g.cellWidth, 1, Number.MAX_SAFE_INTEGER) ||
    !isInt(g.cellHeight, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw new ConvertError('BAD_OPTION', 'grid cellWidth and cellHeight must be integers >= 1');
  }
  if (!isInt(g.offsetX, 0, g.cellWidth - 1) || !isInt(g.offsetY, 0, g.cellHeight - 1)) {
    throw new ConvertError('BAD_OPTION', 'grid offsets must be integers 0..cell size - 1');
  }
}

/** Integer `round(a / b)` (half up) for `a >= 0`, `b > 0`. */
function divRound(a: number, b: number): number {
  const q = 2 * a + b;
  const d = 2 * b;
  return (q - (q % d)) / d;
}

/** The cut lists of both axes. */
function cellCuts(img: RgbaImage, opts: DownscaleOptions): { xs: number[]; ys: number[] } {
  const { width: w, height: h } = img;
  const { grid } = opts;
  if (grid !== undefined) {
    if (opts.width !== undefined || opts.height !== undefined) {
      throw new ConvertError('BAD_OPTION', 'give either a size target or a grid, not both');
    }
    checkGrid(grid);
    const edges: string = opts.edges ?? 'keep';
    if (edges !== 'keep' && edges !== 'drop') {
      throw new ConvertError('BAD_OPTION', 'edges must be "keep" or "drop"');
    }
    const keep = edges === 'keep';
    const xs = gridCuts(w, grid.cellWidth, grid.offsetX, keep);
    const ys = gridCuts(h, grid.cellHeight, grid.offsetY, keep);
    if (xs.length < 2 || ys.length < 2) {
      throw new ConvertError('BAD_OPTION', 'the grid has no full cell inside the image');
    }
    return { xs, ys };
  }
  if (opts.edges !== undefined) {
    throw new ConvertError('BAD_OPTION', 'edges applies to a grid target only');
  }
  let W = opts.width;
  let H = opts.height;
  if (W === undefined && H === undefined) {
    throw new ConvertError('BAD_OPTION', 'give a target width, height or grid');
  }
  for (const [name, v, max] of [
    ['width', W, w],
    ['height', H, h],
  ] as const) {
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 1) {
      throw new ConvertError('BAD_OPTION', `target ${name} must be an integer >= 1`);
    }
    if (v > max) {
      throw new ConvertError(
        'BAD_OPTION',
        `target ${name} ${String(v)} is larger than the source ${String(max)}: downscale never upscales (use scaleInt)`,
      );
    }
  }
  W ??= Math.max(1, Math.min(w, divRound(w * (H ?? h), h)));
  H ??= Math.max(1, Math.min(h, divRound(h * W, w)));
  return { xs: evenCuts(w, W), ys: evenCuts(h, H) };
}

/** Packs RGBA into one unsigned 32-bit number (exact in a double). */
function pack(d: Uint8Array, o: number): number {
  return (
    (d[o] ?? 0) * 0x1000000 + (d[o + 1] ?? 0) * 0x10000 + (d[o + 2] ?? 0) * 0x100 + (d[o + 3] ?? 0)
  );
}

function writePacked(out: Uint8Array, o: number, v: number): void {
  out[o] = Math.floor(v / 0x1000000) % 256;
  out[o + 1] = Math.floor(v / 0x10000) % 256;
  out[o + 2] = Math.floor(v / 0x100) % 256;
  out[o + 3] = v % 256;
}

/** The current cell (reused): its bounds and its visible pixels' byte offsets in row-major order. */
interface Cell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Byte offsets of visible pixels; only the first `count` entries are valid. */
  readonly vis: number[];
  count: number;
}

function boxColor(d: Uint8Array, cell: Cell, out: Uint8Array, o: number): void {
  let sa = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let j = 0; j < cell.count; j++) {
    const p = cell.vis[j] ?? 0;
    const a = d[p + 3] ?? 0;
    sa += a;
    sr += (d[p] ?? 0) * a;
    sg += (d[p + 1] ?? 0) * a;
    sb += (d[p + 2] ?? 0) * a;
  }
  out[o] = divRound(sr, sa);
  out[o + 1] = divRound(sg, sa);
  out[o + 2] = divRound(sb, sa);
  out[o + 3] = divRound(sa, cell.count);
}

function nearestColor(d: Uint8Array, w: number, cell: Cell, out: Uint8Array, o: number): void {
  const cx2 = cell.x0 + cell.x1 - 1;
  const cy2 = cell.y0 + cell.y1 - 1;
  let best = -1;
  let bestD = Infinity;
  for (let j = 0; j < cell.count; j++) {
    const p = cell.vis[j] ?? 0;
    const pi = p / 4;
    const x = pi % w;
    const y = (pi - x) / w;
    const dx = 2 * x - cx2;
    const dy = 2 * y - cy2;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = p;
    }
  }
  out.set(d.subarray(best, best + 4), o);
}

/** Distinct visible colours of a cell with their counts, in order of first appearance. */
function distinct(d: Uint8Array, cell: Cell): Map<number, number> {
  const m = new Map<number, number>();
  for (let j = 0; j < cell.count; j++) {
    const key = pack(d, cell.vis[j] ?? 0);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function modeColor(d: Uint8Array, cell: Cell, out: Uint8Array, o: number): void {
  let best = 0;
  let bestN = 0;
  for (const [key, n] of distinct(d, cell)) {
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  writePacked(out, o, best);
}

interface Item {
  readonly key: number;
  readonly weight: number;
  readonly lab: Oklab;
  readonly alpha: number;
}

function labOf(cache: Map<number, Oklab>, key: number): Oklab {
  const rgb = Math.floor(key / 0x100);
  let lab = cache.get(rgb);
  if (lab === undefined) {
    lab = srgb8ToOklab(Math.floor(rgb / 0x10000), Math.floor(rgb / 0x100) % 256, rgb % 256);
    cache.set(rgb, lab);
  }
  return lab;
}

/** Index of the centre nearest to `lab` (lowest index on ties). */
function nearestCentre(centres: readonly Oklab[], lab: Oklab): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centres.length; c++) {
    const dist = oklabDistanceSq(centres[c] ?? lab, lab);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return best;
}

function kcentroidColor(
  d: Uint8Array,
  cell: Cell,
  k: number,
  cache: Map<number, Oklab>,
  out: Uint8Array,
  o: number,
): void {
  const items: Item[] = [];
  for (const [key, weight] of distinct(d, cell)) {
    items.push({ key, weight, lab: labOf(cache, key), alpha: key % 256 });
  }
  // Seeding: the most common colour, then repeatedly the colour farthest from every chosen centre.
  let first = 0;
  for (let i = 1; i < items.length; i++) {
    if ((items[i]?.weight ?? 0) > (items[first]?.weight ?? 0)) first = i;
  }
  const firstItem = items[first];
  if (firstItem === undefined) return;
  const centres: Oklab[] = [firstItem.lab];
  while (centres.length < k) {
    let far = -1;
    let farD = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === undefined) continue;
      const dist = oklabDistanceSq(centres[nearestCentre(centres, it.lab)] ?? it.lab, it.lab);
      if (dist > farD) {
        farD = dist;
        far = i;
      }
    }
    const farItem = items[far];
    if (farItem === undefined) break; // every colour sits on a centre already
    centres.push(farItem.lab);
  }
  // Lloyd iterations.
  const assign = new Array<number>(items.length).fill(-1);
  for (let iter = 0; iter < KCENTROID_MAX_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === undefined) continue;
      const c = nearestCentre(centres, it.lab);
      if (c !== assign[i]) {
        assign[i] = c;
        changed = true;
      }
    }
    if (!changed) break;
    for (let c = 0; c < centres.length; c++) {
      let sw = 0;
      let sL = 0;
      let sa = 0;
      let sb = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it === undefined || assign[i] !== c) continue;
        sw += it.weight;
        sL += it.lab.L * it.weight;
        sa += it.lab.a * it.weight;
        sb += it.lab.b * it.weight;
      }
      if (sw > 0) centres[c] = { L: sL / sw, a: sa / sw, b: sb / sw };
    }
  }
  // The heaviest cluster (lowest index on ties).
  const weights = new Array<number>(centres.length).fill(0);
  for (let i = 0; i < items.length; i++) {
    const c = assign[i] ?? 0;
    weights[c] = (weights[c] ?? 0) + (items[i]?.weight ?? 0);
  }
  let top = 0;
  for (let c = 1; c < weights.length; c++) if ((weights[c] ?? 0) > (weights[top] ?? 0)) top = c;
  let members = 0;
  let only = 0;
  let sw = 0;
  let salpha = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined || assign[i] !== top) continue;
    members++;
    only = it.key;
    sw += it.weight;
    salpha += it.alpha * it.weight;
  }
  if (members === 1) {
    writePacked(out, o, only);
    return;
  }
  const [r, g, b] = oklabToSrgb8(centres[top] ?? firstItem.lab);
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  out[o + 3] = divRound(salpha, sw);
}

/**
 * Downscales `img`: one output pixel per cell, by a size target or a pixel grid (see the module
 * comment for cells, alpha and the methods with their sources). Pure and deterministic; the input
 * is not changed.
 *
 * Round trip: an image made by integer nearest-neighbour upscaling (any cell size and phase)
 * downscaled with its grid gives the source back exactly with `nearest`, `mode` and `kcentroid`, and
 * with `box` too when the cells are uniform.
 * @returns a new image, never larger than the source
 * @throws ConvertError `BAD_OPTION` for an unknown method, a target larger than the source, a
 *   missing or doubled target, a bad grid, `alphaThreshold` or `k`; `BAD_IMAGE`
 */
export function downscale(img: RgbaImage, opts: DownscaleOptions): RgbaImage {
  assertImage(img);
  const { method } = opts;
  if (!DOWNSCALE_METHODS.includes(method)) {
    throw new ConvertError('BAD_OPTION', `unknown downscale method ${method}`);
  }
  const threshold = opts.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  if (!isInt(threshold, 1, 255)) {
    throw new ConvertError('BAD_OPTION', 'alphaThreshold must be an integer 1..255');
  }
  const k = opts.k ?? DEFAULT_KCENTROID_K;
  if (!isInt(k, 1, MAX_KCENTROID_K)) {
    throw new ConvertError('BAD_OPTION', `k must be an integer 1..${String(MAX_KCENTROID_K)}`);
  }
  const { xs, ys } = cellCuts(img, opts);
  const W = xs.length - 1;
  const H = ys.length - 1;
  const { width: w, data: d } = img;
  const out = new Uint8Array(W * H * 4);
  const cache = new Map<number, Oklab>();
  const c: Cell = { x0: 0, x1: 0, y0: 0, y1: 0, vis: [], count: 0 };
  for (let oy = 0; oy < H; oy++) {
    const y0 = ys[oy] ?? 0;
    const y1 = ys[oy + 1] ?? 0;
    for (let ox = 0; ox < W; ox++) {
      const x0 = xs[ox] ?? 0;
      const x1 = xs[ox + 1] ?? 0;
      c.x0 = x0;
      c.x1 = x1;
      c.y0 = y0;
      c.y1 = y1;
      c.count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 4;
          if ((d[p + 3] ?? 0) >= threshold) c.vis[c.count++] = p;
        }
      }
      const total = (x1 - x0) * (y1 - y0);
      if (c.count * 2 < total) continue; // transparent majority: stays 0,0,0,0
      const o = (oy * W + ox) * 4;
      switch (method) {
        case 'box':
          boxColor(d, c, out, o);
          break;
        case 'nearest':
          nearestColor(d, w, c, out, o);
          break;
        case 'mode':
          modeColor(d, c, out, o);
          break;
        case 'kcentroid':
          kcentroidColor(d, c, k, cache, out, o);
          break;
      }
    }
  }
  return { width: W, height: H, data: out };
}
