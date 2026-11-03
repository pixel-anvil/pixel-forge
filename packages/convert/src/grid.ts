/**
 * Pixel grid detection (FR-CONV-03) for upscaled or AI "fake pixel art".
 *
 * Method (clean-room, written from the public descriptions named here, no code consulted):
 *
 * 1. **Edge histogram.** For every pair of neighbouring pixels along an axis, the difference is the
 *    sum of the absolute RGBA channel differences (0..1020; a pixel with alpha 0 counts as
 *    `0,0,0,0`). Along each row (for x) or column (for y) only local maxima are kept: non-maximum
 *    suppression in one dimension, as in Canny, "A Computational Approach to Edge Detection", IEEE
 *    PAMI 8(6), 1986. A blurred or ringing boundary then counts once, at its strongest step. Each
 *    kept difference above `noiseFloor` adds `difference - noiseFloor` to the histogram bin of its
 *    boundary. Bin `i` (1..n-1) is the boundary between pixels `i - 1` and `i`.
 * 2. **Period and phase.** For each trial cell size `p` the histogram is folded modulo `p` and the
 *    phase with the most energy wins: "epoch folding", the period search of pulsar astronomy (Leahy
 *    et al., "On searches for pulsed emission with application to four globular cluster X-ray
 *    sources", ApJ 266, 160, 1983). The score is the folded fraction above chance:
 *    `c = (F - m/(n-1)) / (1 - m/(n-1))`, where `F` is the share of edge energy on the comb and
 *    `m` the number of comb positions. A perfect grid scores 1, an image with no period about 0.
 * 3. **Choice.** Every divisor of the true cell size also scores high, and multiples score about
 *    `1/k`. So the answer is the **largest** cell size whose score is at least `minConfidence` and at
 *    least {@link GRID_RELATIVE_SCORE} of the best score: the coarsest grid that still explains the
 *    edges. A cell size also needs edges on at least {@link MIN_GRID_LINES} distinct grid lines.
 *
 * Determinism: the histogram and the folds are integer sums in a fixed order; the scores are one
 * IEEE division each, which is correctly rounded. Reported confidences are rounded to 3 decimals.
 *
 * Limits: cells must be a whole number of pixels with a constant size. Fractional or drifting cells
 * (common in AI images) are not modelled.
 * @packageDocumentation
 */
import type { RgbaImage } from '@pixel-forge/raster';
import { assertImage } from './crop.js';
import { ConvertError } from './errors.js';

/** A pixel grid: cell size and the phase (where a cell starts), in source pixels. */
export interface GridSpec {
  /** Cell width, integer >= 1. */
  readonly cellWidth: number;
  /** Cell height, integer >= 1. */
  readonly cellHeight: number;
  /** x of a cell's left edge, `0..cellWidth-1`. Cells are `[offsetX + k*cellWidth, offsetX + (k+1)*cellWidth)`; a non-zero offset leaves a partial cell at the left. */
  readonly offsetX: number;
  /** y of a cell's top edge, `0..cellHeight-1`. */
  readonly offsetY: number;
}

/** A grid was found. Pass it as `grid` to `downscale`. */
export interface GridFound extends GridSpec {
  readonly found: true;
  /** The smaller of the two axis scores (or the combined score with `square`), 0..1, 3 decimals. */
  readonly confidence: number;
  /** Score of the x axis at the chosen cell width, 0..1 (0 when the axis has no edges). */
  readonly confidenceX: number;
  /** Score of the y axis at the chosen cell height, 0..1 (0 when the axis has no edges). */
  readonly confidenceY: number;
}

/**
 * Why no grid was found.
 * - `too-small`: the image is too small to see {@link MIN_GRID_LINES} grid lines of cell size 2.
 * - `flat`: an axis (both with `square`) has no edge above the noise floor.
 * - `no-period`: there are edges but no cell size >= 2 explains them well enough (ordinary images,
 *   photos, art already at 1 pixel per cell).
 */
export type GridNoneReason = 'too-small' | 'flat' | 'no-period';

/** No grid. This is a definite answer, not a guess: do not downscale by a grid. */
export interface GridNone {
  readonly found: false;
  readonly reason: GridNoneReason;
  /** Best score seen (the weaker axis without `square`), 0..1, 3 decimals; 0 for `too-small` and `flat`. */
  readonly confidence: number;
}

/** Result of {@link detectGrid}. Branch on `found`. */
export type GridDetection = GridFound | GridNone;

/** Options of {@link detectGrid}. Every field is optional. */
export interface DetectGridOptions {
  /** Largest cell size tried, integer 2..{@link MAX_GRID_CELL}. Default {@link DEFAULT_MAX_CELL}. */
  readonly maxCell?: number;
  /** Lowest score accepted as a grid, 0 < x <= 1. Default {@link DEFAULT_GRID_CONFIDENCE}. */
  readonly minConfidence?: number;
  /** Pixel differences up to this (sum of 4 channel differences, integer 0..1020) are noise. Default {@link DEFAULT_NOISE_FLOOR}. */
  readonly noiseFloor?: number;
  /** Force square cells: both axes vote for one size (each keeps its own phase). Default false: each axis is detected alone and both must succeed. */
  readonly square?: boolean;
}

/** Largest `maxCell` accepted. */
export const MAX_GRID_CELL = 256;
/** Default largest cell size tried. */
export const DEFAULT_MAX_CELL = 64;
/** Default lowest accepted score. */
export const DEFAULT_GRID_CONFIDENCE = 0.5;
/** Default noise floor (sum of 4 channel differences). Covers JPEG-like noise of about +-8 per channel. */
export const DEFAULT_NOISE_FLOOR = 24;
/** A cell size needs edges on at least this many distinct grid lines of an axis (of both axes together with `square`) to be considered. */
export const MIN_GRID_LINES = 3;
/** A larger cell size is preferred while its score is at least this share of the best score. */
export const GRID_RELATIVE_SCORE = 0.75;

const MAX_DIFF = 1020;

/** Difference of two pixels: sum of absolute RGBA differences, alpha-0 pixels read as 0,0,0,0. */
function pixelDiff(d: Uint8Array, p: number, q: number): number {
  const ap = d[p + 3] ?? 0;
  const aq = d[q + 3] ?? 0;
  let s = Math.abs(ap - aq);
  for (let c = 0; c < 3; c++) {
    const vp = ap === 0 ? 0 : (d[p + c] ?? 0);
    const vq = aq === 0 ? 0 : (d[q + c] ?? 0);
    s += Math.abs(vp - vq);
  }
  return s;
}

/**
 * Edge histogram of one axis. Bin `i` (1..n-1) sums, over every line across the axis, the
 * non-maximum-suppressed difference between pixels `i - 1` and `i`, less the noise floor.
 */
function edgeHistogram(img: RgbaImage, axis: 'x' | 'y', noiseFloor: number): number[] {
  const { width: w, height: h, data } = img;
  const n = axis === 'x' ? w : h;
  const lines = axis === 'x' ? h : w;
  const step = axis === 'x' ? 4 : w * 4;
  const hist = new Array<number>(n).fill(0);
  const diffs = new Array<number>(n + 1).fill(0);
  for (let line = 0; line < lines; line++) {
    const base = axis === 'x' ? line * w * 4 : line * 4;
    for (let i = 1; i < n; i++) diffs[i] = pixelDiff(data, base + (i - 1) * step, base + i * step);
    for (let i = 1; i < n; i++) {
      const v = diffs[i] ?? 0;
      if (v > noiseFloor && v > (diffs[i - 1] ?? 0) && v >= (diffs[i + 1] ?? 0)) {
        hist[i] = (hist[i] ?? 0) + v - noiseFloor;
      }
    }
  }
  return hist;
}

/** The best fold of one histogram at period `p`. */
interface Fold {
  /** Phase with the most energy (smallest on ties). */
  readonly phase: number;
  /** Energy on the comb at that phase. */
  readonly energy: number;
  /** Comb positions (boundaries 1..n-1) at that phase. */
  readonly positions: number;
  /** Comb positions with energy at that phase. */
  readonly lines: number;
}

function fold(hist: readonly number[], p: number): Fold {
  const n = hist.length;
  const sums = new Array<number>(p).fill(0);
  for (let i = 1; i < n; i++) sums[i % p] = (sums[i % p] ?? 0) + (hist[i] ?? 0);
  let phase = 0;
  for (let f = 1; f < p; f++) if ((sums[f] ?? 0) > (sums[phase] ?? 0)) phase = f;
  let positions = 0;
  let lines = 0;
  for (let i = phase === 0 ? p : phase; i < n; i += p) {
    positions++;
    if ((hist[i] ?? 0) > 0) lines++;
  }
  return { phase, energy: sums[phase] ?? 0, positions, lines };
}

/** Share of `energy` in `total` above the `chance` share (comb positions / boundaries). */
function score(energy: number, total: number, chance: number): number {
  return (energy / total - chance) / (1 - chance);
}

interface AxisData {
  readonly hist: number[];
  readonly total: number;
  /** Number of boundaries, `n - 1`. */
  readonly bins: number;
}

function axisData(img: RgbaImage, axis: 'x' | 'y', noiseFloor: number): AxisData {
  const hist = edgeHistogram(img, axis, noiseFloor);
  let total = 0;
  for (const v of hist) total += v;
  return { hist, total, bins: hist.length - 1 };
}

interface Candidate {
  readonly p: number;
  readonly c: number;
}

/** Largest candidate scoring at least `minConfidence` and the relative share of the best score. */
function choose(cands: readonly Candidate[], minConfidence: number): Candidate | undefined {
  let best = -Infinity;
  for (const k of cands) if (k.c > best) best = k.c;
  const bar = Math.max(minConfidence, best * GRID_RELATIVE_SCORE);
  let pick: Candidate | undefined;
  for (const k of cands) if (k.c >= bar && (pick === undefined || k.p > pick.p)) pick = k;
  return pick;
}

function round3(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
}

function axisScoreAt(a: AxisData, p: number): { phase: number; c: number } {
  if (a.total === 0 || a.bins < 1) return { phase: 0, c: 0 };
  const f = fold(a.hist, p);
  if (f.positions >= a.bins) return { phase: f.phase, c: 0 };
  return { phase: f.phase, c: score(f.energy, a.total, f.positions / a.bins) };
}

function checkOptions(opts: DetectGridOptions): {
  maxCell: number;
  minConfidence: number;
  noiseFloor: number;
} {
  const maxCell = opts.maxCell ?? DEFAULT_MAX_CELL;
  if (!Number.isInteger(maxCell) || maxCell < 2 || maxCell > MAX_GRID_CELL) {
    throw new ConvertError('BAD_OPTION', `maxCell must be an integer 2..${String(MAX_GRID_CELL)}`);
  }
  const minConfidence = opts.minConfidence ?? DEFAULT_GRID_CONFIDENCE;
  if (!Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 1) {
    throw new ConvertError('BAD_OPTION', 'minConfidence must be > 0 and <= 1');
  }
  const noiseFloor = opts.noiseFloor ?? DEFAULT_NOISE_FLOOR;
  if (!Number.isInteger(noiseFloor) || noiseFloor < 0 || noiseFloor > MAX_DIFF) {
    throw new ConvertError('BAD_OPTION', `noiseFloor must be an integer 0..${String(MAX_DIFF)}`);
  }
  return { maxCell, minConfidence, noiseFloor };
}

/** Smallest axis length on which cell size 2 can show {@link MIN_GRID_LINES} grid lines. */
const MIN_AXIS = 2 * MIN_GRID_LINES;

/** Eligible cell sizes of one axis with their scores. */
function axisCandidates(a: AxisData, maxCell: number): Candidate[] {
  const out: Candidate[] = [];
  if (a.total === 0) return out;
  const top = Math.min(maxCell, a.bins);
  for (let p = 2; p <= top; p++) {
    const f = fold(a.hist, p);
    if (f.lines < MIN_GRID_LINES || f.positions >= a.bins) continue;
    out.push({ p, c: score(f.energy, a.total, f.positions / a.bins) });
  }
  return out;
}

/**
 * Finds the dominant pixel grid (cell size and phase) of an upscaled or "fake" pixel-art image from
 * its edge histogram. See the module comment for the method and its sources. Pure and
 * deterministic; the input is not changed.
 *
 * The result is the coarsest grid that explains the edges: if a sprite was upscaled by 4 from art
 * that was itself drawn in 2x2 blocks, the answer may be 8. Downscaling by such a grid loses no
 * detail. Ordinary images, native pixel art (1 pixel per cell) and images with too few edges give
 * `found: false` with a reason instead of a guess.
 *
 * Without `square` each axis is detected on its own (cells may be non-square) and both must find a
 * grid. With `square: true` both histograms vote for one cell size; an axis without edges then gets
 * phase 0.
 * @throws ConvertError `BAD_OPTION` for an option out of range; `BAD_IMAGE`
 */
export function detectGrid(img: RgbaImage, opts: DetectGridOptions = {}): GridDetection {
  assertImage(img);
  const { maxCell, minConfidence, noiseFloor } = checkOptions(opts);
  const square = opts.square ?? false;
  const small = square
    ? Math.max(img.width, img.height) < MIN_AXIS
    : Math.min(img.width, img.height) < MIN_AXIS;
  if (small) return { found: false, reason: 'too-small', confidence: 0 };
  const ax = axisData(img, 'x', noiseFloor);
  const ay = axisData(img, 'y', noiseFloor);
  const flat = square ? ax.total === 0 && ay.total === 0 : ax.total === 0 || ay.total === 0;
  if (flat) return { found: false, reason: 'flat', confidence: 0 };

  if (!square) {
    const cx = axisCandidates(ax, maxCell);
    const cy = axisCandidates(ay, maxCell);
    const kx = choose(cx, minConfidence);
    const ky = choose(cy, minConfidence);
    if (kx === undefined || ky === undefined) {
      const bestOf = (cs: readonly Candidate[]): number =>
        cs.reduce((m, k) => (k.c > m ? k.c : m), 0);
      return {
        found: false,
        reason: 'no-period',
        confidence: round3(Math.min(bestOf(cx), bestOf(cy))),
      };
    }
    const sx = axisScoreAt(ax, kx.p);
    const sy = axisScoreAt(ay, ky.p);
    return {
      found: true,
      cellWidth: kx.p,
      cellHeight: ky.p,
      offsetX: sx.phase,
      offsetY: sy.phase,
      confidence: round3(Math.min(kx.c, ky.c)),
      confidenceX: round3(kx.c),
      confidenceY: round3(ky.c),
    };
  }

  // Square cells: one fold per axis, energies and chances pooled.
  // An axis whose every boundary is on the comb (too short for `p`) carries no information and is
  // left out of that cell size's pool.
  const cands: Candidate[] = [];
  const top = Math.min(maxCell, Math.max(ax.bins, ay.bins));
  for (let p = 2; p <= top; p++) {
    let energy = 0;
    let total = 0;
    let chanceMass = 0;
    let lines = 0;
    for (const a of [ax, ay]) {
      if (a.total === 0) continue;
      const f = fold(a.hist, p);
      if (f.positions >= a.bins) continue;
      energy += f.energy;
      total += a.total;
      chanceMass += (f.positions / a.bins) * a.total;
      lines += f.lines;
    }
    if (total === 0 || lines < MIN_GRID_LINES) continue;
    cands.push({ p, c: score(energy, total, chanceMass / total) });
  }
  const k = choose(cands, minConfidence);
  if (k === undefined) {
    const best = cands.reduce((m, c) => (c.c > m ? c.c : m), 0);
    return { found: false, reason: 'no-period', confidence: round3(best) };
  }
  const sx = axisScoreAt(ax, k.p);
  const sy = axisScoreAt(ay, k.p);
  return {
    found: true,
    cellWidth: k.p,
    cellHeight: k.p,
    offsetX: sx.phase,
    offsetY: sy.phase,
    confidence: round3(k.c),
    confidenceX: round3(sx.c),
    confidenceY: round3(sy.c),
  };
}
