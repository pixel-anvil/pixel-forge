/**
 * Palette generation from an image (FR-PAL-04): k-means++ in OKLab or median cut, `n` colours
 * (2 to 256). Pure (no I/O) and deterministic: same pixels + same seed = same palette on every
 * platform.
 *
 * Determinism: counting, sorting, binning and the random numbers are integer maths (the generator is
 * a 32-bit xorshift, Marsaglia, "Xorshift RNGs", J. Stat. Software 8(14), 2003, 13-17-5). The
 * clustering uses OKLab (`srgb8ToOklab`, which uses only `+ - * /` and `Math.sqrt`) and sums in a
 * fixed order, so it is bit-identical anywhere. No `Math.pow`, `sin`, `cos`, `exp` or `log`.
 *
 * Algorithms: k-means++ seeding (Arthur and Vassilvitskii, "k-means++: the advantages of careful
 * seeding", SODA 2007) followed by Lloyd iterations (Lloyd 1982), both on the weighted list of
 * distinct colours; median cut (Heckbert, "Color image quantization for frame buffer display",
 * SIGGRAPH 1982) with the box of largest weighted squared error split at the weighted median of its
 * longest OKLab axis. Both are implemented here from those descriptions.
 *
 * What goes in:
 * - Pixels with alpha below `minAlpha` (default 1, so alpha 0) are ignored.
 * - Every other pixel counts once with its straight RGB, however translucent; the result is opaque
 *   (alpha 255).
 * - The image is never sampled. The distinct colours are counted exactly; when there are more than
 *   {@link MAX_WORK_COLORS} they are merged first (see {@link GeneratedPalette.binned}).
 *
 * What comes out: every colour is a colour that occurs in the (binned) image, all colours are
 * distinct, and the list is sorted by OKLab lightness, darkest first, ties by packed RGB.
 * @packageDocumentation
 */
import type { RGBA8 } from '@pixel-forge/schema';
import { srgb8ToOklab } from './convert.js';

/** How {@link generatePalette} picks colours. */
export type PaletteMethod = 'kmeans' | 'mediancut';

/** Seed used when none is given. */
export const DEFAULT_PALETTE_SEED = 1;
/** Fewest colours {@link generatePalette} makes. */
export const MIN_GENERATED_COLORS = 2;
/** Most colours {@link generatePalette} makes. */
export const MAX_GENERATED_COLORS = 256;
/** Most pixels one call accepts (4096 x 4096). A larger image is refused. */
export const MAX_GENERATE_PIXELS = 1 << 24;
/** More distinct colours than this are merged by {@link generatePalette} before clustering. */
export const MAX_WORK_COLORS = 8192;
/** Lloyd iteration limit of the k-means method. */
export const MAX_KMEANS_ITERATIONS = 32;

/** Options of {@link generatePalette}. */
export interface GeneratePaletteOptions {
  /** Number of colours, an integer 2 to 256. */
  readonly n: number;
  /** `'kmeans'` (default) or `'mediancut'`. */
  readonly method?: PaletteMethod;
  /** Seed of the k-means++ random numbers, an integer 0 to 4294967295 (default {@link DEFAULT_PALETTE_SEED}). Median cut has no random part and ignores it. */
  readonly seed?: number;
  /** Pixels with alpha below this are ignored, an integer 1 to 255 (default 1: only alpha 0). */
  readonly minAlpha?: number;
}

/** Result of {@link generatePalette}. */
export interface GeneratedPalette {
  /** The colours, opaque, distinct, darkest first (OKLab lightness, ties by packed RGB). */
  readonly colors: RGBA8[];
  /** Method used. */
  readonly method: PaletteMethod;
  /** Colours asked for. */
  readonly requested: number;
  /** Pixels that counted (alpha at least `minAlpha`). */
  readonly pixels: number;
  /** Pixels ignored (alpha below `minAlpha`). */
  readonly ignored: number;
  /** Distinct RGB colours among the counted pixels, before any merging. */
  readonly unique: number;
  /**
   * True when `unique` was above {@link MAX_WORK_COLORS}: the colours were merged into cells of
   * `2^k` values per channel (the finest `k` that leaves at most that many cells) and each cell was
   * replaced by its most frequent colour (ties: lowest packed RGB) with the cell's total weight.
   */
  readonly binned: boolean;
  /**
   * True when the image has `n` colours or fewer: `colors` then holds every distinct colour and may
   * be shorter than `n` (or empty when no pixel counted).
   */
  readonly exact: boolean;
}

/** A 32-bit xorshift generator (Marsaglia 2003, 13-17-5). */
class Xorshift32 {
  private s: number;
  constructor(seed: number) {
    // Scramble the seed so small seeds do not start in a weak region; the state must not be 0.
    this.s = Math.imul((seed >>> 0) + 0x9e3779b9, 0x85ebca6b) >>> 0 || 0x2545f491;
    for (let i = 0; i < 4; i++) this.next();
  }
  next(): number {
    let x = this.s;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.s = x;
    return x;
  }
  /** A number in `[0, 1)` (exact: a 32-bit integer over 2^32). */
  unit(): number {
    return this.next() / 4294967296;
  }
}

/** The distinct colours with their pixel counts, in ascending packed-RGB order. */
interface Weighted {
  /** Packed `r << 16 | g << 8 | b`. */
  readonly keys: Int32Array;
  /** Pixel count of each colour (integer). */
  readonly weights: Float64Array;
}

/** Points in OKLab, `3 * count` numbers (L, a, b), with their weights and packed colours. */
interface Points extends Weighted {
  readonly count: number;
  readonly lab: Float64Array;
}

function countColors(data: ArrayLike<number>, minAlpha: number): { w: Weighted; ignored: number } {
  const map = new Map<number, number>();
  let ignored = 0;
  for (let o = 0; o + 3 < data.length; o += 4) {
    if ((data[o + 3] ?? 0) < minAlpha) {
      ignored++;
      continue;
    }
    const key = ((data[o] ?? 0) << 16) | ((data[o + 1] ?? 0) << 8) | (data[o + 2] ?? 0);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  const keys = Int32Array.from(map.keys()).sort();
  const weights = new Float64Array(keys.length);
  keys.forEach((k, i) => {
    weights[i] = map.get(k) ?? 0;
  });
  return { w: { keys, weights }, ignored };
}

/** Merges colours into cells of `2^shift` values per channel, finest first, until few enough remain. */
function binColors(w: Weighted): Weighted {
  for (let shift = 1; shift <= 7; shift++) {
    const cells = new Map<number, { best: number; bestW: number; total: number }>();
    for (let i = 0; i < w.keys.length; i++) {
      const key = w.keys[i] ?? 0;
      const weight = w.weights[i] ?? 0;
      const cell =
        (((key >> 16) & 255) >> shift) * 65536 +
        (((key >> 8) & 255) >> shift) * 256 +
        ((key & 255) >> shift);
      const c = cells.get(cell);
      if (c === undefined) cells.set(cell, { best: key, bestW: weight, total: weight });
      else {
        c.total += weight;
        if (weight > c.bestW) {
          c.best = key;
          c.bestW = weight;
        }
      }
    }
    if (cells.size <= MAX_WORK_COLORS || shift === 7) {
      const merged = [...cells.values()].sort((a, b) => a.best - b.best);
      return {
        keys: Int32Array.from(merged, (c) => c.best),
        weights: Float64Array.from(merged, (c) => c.total),
      };
    }
  }
  return w; // unreachable: shift 7 always returns
}

function toPoints(w: Weighted): Points {
  const count = w.keys.length;
  const lab = new Float64Array(3 * count);
  for (let i = 0; i < count; i++) {
    const key = w.keys[i] ?? 0;
    const c = srgb8ToOklab((key >> 16) & 255, (key >> 8) & 255, key & 255);
    lab[3 * i] = c.L;
    lab[3 * i + 1] = c.a;
    lab[3 * i + 2] = c.b;
  }
  return { ...w, count, lab };
}

/** Squared OKLab distance between point `i` and the position `(L, a, b)`. */
function dist2(p: Points, i: number, L: number, a: number, b: number): number {
  const dL = (p.lab[3 * i] ?? 0) - L;
  const da = (p.lab[3 * i + 1] ?? 0) - a;
  const db = (p.lab[3 * i + 2] ?? 0) - b;
  return dL * dL + da * da + db * db;
}

/** k-means++ seeding then Lloyd iterations. Returns `3 * n` centre numbers. */
function kmeansCentres(p: Points, n: number, seed: number): Float64Array {
  const rng = new Xorshift32(seed);
  const centres = new Float64Array(3 * n);
  const setCentre = (c: number, i: number): void => {
    centres[3 * c] = p.lab[3 * i] ?? 0;
    centres[3 * c + 1] = p.lab[3 * i + 1] ?? 0;
    centres[3 * c + 2] = p.lab[3 * i + 2] ?? 0;
  };

  // Seeding: first centre by pixel weight, the others by weight times squared distance to the
  // nearest centre so far.
  let totalW = 0;
  for (let i = 0; i < p.count; i++) totalW += p.weights[i] ?? 0;
  const near = new Float64Array(p.count);
  const pick = (score: (i: number) => number, total: number): number => {
    const target = rng.unit() * total;
    let acc = 0;
    let last = 0;
    for (let i = 0; i < p.count; i++) {
      const s = score(i);
      if (s <= 0) continue;
      last = i;
      acc += s;
      if (acc > target) return i;
    }
    return last; // rounding at the very end of the sum
  };
  setCentre(
    0,
    pick((i) => p.weights[i] ?? 0, totalW),
  );
  for (let i = 0; i < p.count; i++) {
    near[i] = dist2(p, i, centres[0] ?? 0, centres[1] ?? 0, centres[2] ?? 0);
  }
  for (let c = 1; c < n; c++) {
    let sum = 0;
    for (let i = 0; i < p.count; i++) sum += (p.weights[i] ?? 0) * (near[i] ?? 0);
    const chosen = pick((i) => (p.weights[i] ?? 0) * (near[i] ?? 0), sum);
    setCentre(c, chosen);
    const L = centres[3 * c] ?? 0;
    const a = centres[3 * c + 1] ?? 0;
    const b = centres[3 * c + 2] ?? 0;
    for (let i = 0; i < p.count; i++) {
      const d = dist2(p, i, L, a, b);
      if (d < (near[i] ?? 0)) near[i] = d;
    }
  }

  // Lloyd iterations on the weighted points.
  const assign = new Int32Array(p.count).fill(-1);
  const sums = new Float64Array(3 * n);
  const mass = new Float64Array(n);
  for (let iter = 0; iter < MAX_KMEANS_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < p.count; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < n; c++) {
        const d = dist2(
          p,
          i,
          centres[3 * c] ?? 0,
          centres[3 * c + 1] ?? 0,
          centres[3 * c + 2] ?? 0,
        );
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      near[i] = bestD;
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    sums.fill(0);
    mass.fill(0);
    for (let i = 0; i < p.count; i++) {
      const c = assign[i] ?? 0;
      const w = p.weights[i] ?? 0;
      mass[c] = (mass[c] ?? 0) + w;
      sums[3 * c] = (sums[3 * c] ?? 0) + w * (p.lab[3 * i] ?? 0);
      sums[3 * c + 1] = (sums[3 * c + 1] ?? 0) + w * (p.lab[3 * i + 1] ?? 0);
      sums[3 * c + 2] = (sums[3 * c + 2] ?? 0) + w * (p.lab[3 * i + 2] ?? 0);
    }
    for (let c = 0; c < n; c++) {
      const m = mass[c] ?? 0;
      if (m > 0) {
        centres[3 * c] = (sums[3 * c] ?? 0) / m;
        centres[3 * c + 1] = (sums[3 * c + 1] ?? 0) / m;
        centres[3 * c + 2] = (sums[3 * c + 2] ?? 0) / m;
      } else {
        // An empty cluster restarts on the point that fits its centre worst (weight x distance).
        let worst = -1;
        let worstS = 0;
        for (let i = 0; i < p.count; i++) {
          const s = (p.weights[i] ?? 0) * (near[i] ?? 0);
          if (s > worstS) {
            worstS = s;
            worst = i;
          }
        }
        if (worst >= 0) {
          setCentre(c, worst);
          near[worst] = 0;
        }
      }
    }
  }
  return centres;
}

/** Median cut: `3 * n` box means. Needs more than `n` points. */
function medianCutCentres(p: Points, n: number): Float64Array {
  const boxes: number[][] = [Array.from({ length: p.count }, (_, i) => i)];
  const mean = (box: readonly number[]): [number, number, number, number] => {
    let m = 0;
    let L = 0;
    let a = 0;
    let b = 0;
    for (const i of box) {
      const w = p.weights[i] ?? 0;
      m += w;
      L += w * (p.lab[3 * i] ?? 0);
      a += w * (p.lab[3 * i + 1] ?? 0);
      b += w * (p.lab[3 * i + 2] ?? 0);
    }
    return [L / m, a / m, b / m, m];
  };
  const error = (box: readonly number[]): number => {
    const [L, a, b] = mean(box);
    let e = 0;
    for (const i of box) e += (p.weights[i] ?? 0) * dist2(p, i, L, a, b);
    return e;
  };
  while (boxes.length < n) {
    let target = -1;
    let targetE = -1;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      const e = error(box);
      if (e > targetE) {
        targetE = e;
        target = k;
      }
    });
    const box = boxes[target];
    if (box === undefined) break; // cannot happen: more than n distinct points
    // Longest axis (ties: L, then a, then b).
    let axis = 0;
    let axisRange = -1;
    for (let ax = 0; ax < 3; ax++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const i of box) {
        const v = p.lab[3 * i + ax] ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > axisRange) {
        axisRange = hi - lo;
        axis = ax;
      }
    }
    const sorted = [...box].sort(
      (i, j) =>
        (p.lab[3 * i + axis] ?? 0) - (p.lab[3 * j + axis] ?? 0) ||
        (p.keys[i] ?? 0) - (p.keys[j] ?? 0),
    );
    const half = mean(box)[3] / 2;
    let acc = 0;
    let cut = 1;
    for (let k = 0; k < sorted.length - 1; k++) {
      acc += p.weights[sorted[k] ?? 0] ?? 0;
      cut = k + 1;
      if (acc >= half) break;
    }
    boxes[target] = sorted.slice(0, cut);
    boxes.push(sorted.slice(cut));
  }
  const centres = new Float64Array(3 * n);
  boxes.forEach((box, c) => {
    const [L, a, b] = mean(box);
    centres[3 * c] = L;
    centres[3 * c + 1] = a;
    centres[3 * c + 2] = b;
  });
  return centres;
}

/** For each centre in order, the nearest point not taken yet (ties: lowest index). */
function snapToPoints(p: Points, centres: Float64Array, n: number): number[] {
  const used = new Uint8Array(p.count);
  const out: number[] = [];
  for (let c = 0; c < n; c++) {
    const L = centres[3 * c] ?? 0;
    const a = centres[3 * c + 1] ?? 0;
    const b = centres[3 * c + 2] ?? 0;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < p.count; i++) {
      if (used[i] === 1) continue;
      const d = dist2(p, i, L, a, b);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    used[best] = 1;
    out.push(best);
  }
  return out;
}

const colorOfKey = (key: number): RGBA8 => [(key >> 16) & 255, (key >> 8) & 255, key & 255, 255];

/** Orders packed colours darkest first by OKLab lightness, ties by packed RGB. */
function sortKeys(keys: readonly number[]): number[] {
  const lightness = new Map<number, number>();
  for (const k of keys) lightness.set(k, srgb8ToOklab((k >> 16) & 255, (k >> 8) & 255, k & 255).L);
  return [...keys].sort((a, b) => (lightness.get(a) ?? 0) - (lightness.get(b) ?? 0) || a - b);
}

/**
 * Generates a palette of `options.n` colours from RGBA pixels (FR-PAL-04).
 *
 * `data` is straight RGBA, 4 bytes per pixel. See the file comment for which pixels count and what
 * the output is. When the image has `n` colours or fewer, those colours are returned as they are
 * (`exact: true`, possibly fewer than `n`); otherwise the method picks exactly `n` distinct colours.
 *
 * `'kmeans'`: k-means++ seeding from `seed`, then up to {@link MAX_KMEANS_ITERATIONS} Lloyd
 * iterations in OKLab on the colours weighted by pixel count; each final centre is replaced by the
 * nearest image colour not taken yet. `'mediancut'`: repeatedly splits the box with the largest
 * weighted squared OKLab error at the weighted median of its longest axis; each box mean is replaced
 * the same way. Median cut ignores the seed.
 *
 * @throws RangeError for a bad `n`, `seed` or `minAlpha`, data that is not a whole number of
 *   pixels, or more than {@link MAX_GENERATE_PIXELS} pixels.
 */
export function generatePalette(
  data: ArrayLike<number>,
  options: GeneratePaletteOptions,
): GeneratedPalette {
  const { n } = options;
  const method = options.method ?? 'kmeans';
  const seed = options.seed ?? DEFAULT_PALETTE_SEED;
  const minAlpha = options.minAlpha ?? 1;
  if (!Number.isInteger(n) || n < MIN_GENERATED_COLORS || n > MAX_GENERATED_COLORS) {
    throw new RangeError(
      `generatePalette: n must be an integer ${String(MIN_GENERATED_COLORS)}..${String(MAX_GENERATED_COLORS)}`,
    );
  }
  if ((method as string) !== 'kmeans' && (method as string) !== 'mediancut') {
    throw new RangeError('generatePalette: method must be "kmeans" or "mediancut"');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('generatePalette: seed must be an integer 0..4294967295');
  }
  if (!Number.isInteger(minAlpha) || minAlpha < 1 || minAlpha > 255) {
    throw new RangeError('generatePalette: minAlpha must be an integer 1..255');
  }
  if (data.length % 4 !== 0) {
    throw new RangeError('generatePalette: data is not a whole number of RGBA pixels');
  }
  if (data.length / 4 > MAX_GENERATE_PIXELS) {
    throw new RangeError(
      `generatePalette: more than ${String(MAX_GENERATE_PIXELS)} pixels; scale the image down first`,
    );
  }

  const { w: counted, ignored } = countColors(data, minAlpha);
  const unique = counted.keys.length;
  let pixels = 0;
  for (const c of counted.weights) pixels += c;
  const base = { method, requested: n, pixels, ignored, unique };

  if (unique <= n) {
    return {
      ...base,
      colors: sortKeys(Array.from(counted.keys)).map(colorOfKey),
      binned: false,
      exact: true,
    };
  }
  const binned = unique > MAX_WORK_COLORS;
  const points = toPoints(binned ? binColors(counted) : counted);
  const centres =
    method === 'kmeans' ? kmeansCentres(points, n, seed) : medianCutCentres(points, n);
  const chosen = snapToPoints(points, centres, n).map((i) => points.keys[i] ?? 0);
  return { ...base, colors: sortKeys(chosen).map(colorOfKey), binned, exact: false };
}
