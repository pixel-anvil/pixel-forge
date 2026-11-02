/**
 * Nearest palette colour in OKLab (FR-CONV-05) with a small deterministic cache.
 * @packageDocumentation
 */
import type { Palette, RGBA8 } from '@pixel-forge/schema';
import { type Oklab, oklabDistanceSq, srgb8ToOklab } from './convert.js';

/** Options for {@link nearestIndex}. */
export interface NearestOptions {
  /** Reuse a cache made by {@link createNearestCache}; it resets itself if the palette or weight differs. */
  readonly cache?: NearestCache;
  /**
   * Weight of the squared alpha difference (alpha scaled to 0..1) added to the OKLab distance for
   * visible inputs. Default `0`: alpha is ignored when picking among non-transparent entries.
   */
  readonly alphaWeight?: number;
}

/** Packs RGBA into an unsigned uint32 cache key (`r<<24 | g<<16 | b<<8 | a`). */
export function packRgba(c: RGBA8): number {
  return ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
}

/**
 * Bounded cache of nearest-index results keyed by RGBA uint32. Eviction is FIFO by insertion
 * (oldest entry first), so behaviour depends only on the call sequence. It also holds the
 * palette's precomputed OKLab table. Palettes are treated as immutable: the cache is tied to the
 * identity of `palette.colors` (and the alpha weight); mutate the array in place and it is stale.
 */
export class NearestCache {
  /** Maximum entries kept. */
  readonly capacity: number;
  private readonly map = new Map<number, number>();
  private source: readonly RGBA8[] | undefined;
  private weight = 0;
  private labs: Oklab[] = [];

  /** @param capacity maximum cached results (default 4096, minimum 1). */
  constructor(capacity = 4096) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Number of cached results. */
  get size(): number {
    return this.map.size;
  }

  /** @internal Binds to a palette's colours and weight, resetting on change. Returns the OKLab table. */
  bind(colors: readonly RGBA8[], weight: number): readonly Oklab[] {
    if (this.source !== colors || this.weight !== weight) {
      this.source = colors;
      this.weight = weight;
      this.map.clear();
      this.labs = colors.map((c) => srgb8ToOklab(c[0], c[1], c[2]));
    }
    return this.labs;
  }

  /** @internal */
  get(key: number): number | undefined {
    return this.map.get(key);
  }

  /** @internal */
  set(key: number, value: number): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done !== true) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }
}

/** Creates a {@link NearestCache}. */
export function createNearestCache(capacity?: number): NearestCache {
  return new NearestCache(capacity);
}

/**
 * Index of the palette colour nearest to `rgba` in OKLab. Ties go to the lower index.
 *
 * Alpha handling:
 * - Input alpha `0` (fully transparent): returns the first palette entry whose alpha is 0; if the
 *   palette has none, falls back to the nearest by colour (alpha ignored) like a visible input.
 * - Input alpha `> 0`: palette entries with alpha 0 are never candidates unless every entry is
 *   transparent. Distance is OKLab squared distance on RGB, plus `alphaWeight * (Δa/255)²`
 *   (default weight 0, so alpha is otherwise ignored).
 *
 * @throws RangeError if the palette is empty.
 */
export function nearestIndex(
  palette: Pick<Palette, 'colors'>,
  rgba: RGBA8,
  opts?: NearestOptions,
): number {
  const colors = palette.colors;
  if (colors.length === 0) throw new RangeError('nearestIndex: palette is empty');
  const cache = opts?.cache ?? new NearestCache(1);
  const weight = opts?.alphaWeight ?? 0;
  const labs = cache.bind(colors, weight);
  const key = packRgba(rgba);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let result = -1;
  if (rgba[3] === 0) result = colors.findIndex((c) => c[3] === 0);
  if (result < 0) {
    const target = srgb8ToOklab(rgba[0], rgba[1], rgba[2]);
    const visible = rgba[3] !== 0;
    const skipTransparent = visible && colors.some((c) => c[3] !== 0);
    let best = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const lab = labs[i];
      if (c === undefined || lab === undefined) continue;
      if (skipTransparent && c[3] === 0) continue;
      let d = oklabDistanceSq(target, lab);
      if (visible && weight !== 0) {
        const da = (rgba[3] - c[3]) / 255;
        d += weight * da * da;
      }
      if (d < best) {
        best = d;
        result = i;
      }
    }
  }
  cache.set(key, result);
  return result;
}
