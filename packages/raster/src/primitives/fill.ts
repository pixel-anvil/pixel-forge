import { pixelDistance, pixelKey } from './plot.js';
import type { DrawableImage, PixelOf } from './plot.js';

/** Options of {@link floodFill}. */
export interface FloodFillOptions {
  /** Neighbourhood for `contiguous` mode (default 4). */
  readonly connectivity?: 4 | 8;
  /** `contiguous` (default): the connected region of the seed colour; `global`: every matching pixel. */
  readonly mode?: 'contiguous' | 'global';
  /**
   * Largest per-channel difference from the seed colour that still matches (default 0 = exact). For indexed
   * images it is the difference of the indices.
   */
  readonly tolerance?: number;
}

/**
 * Flood fill from `(x, y)`. Returns the number of pixels changed (0 when the seed is outside the image or
 * already equals `colour`). Iterative with an explicit stack and a visited bitmap, so it is bounded by
 * `width * height` and cannot overflow the call stack. The match is always against the colour the seed pixel
 * had before the fill.
 */
export function floodFill<I extends DrawableImage>(
  img: I,
  x: number,
  y: number,
  colour: PixelOf<I>,
  options: FloodFillOptions = {},
): number {
  const { width: w, height: h } = img;
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  const connectivity = options.connectivity ?? 4;
  const tol = options.tolerance ?? 0;
  const get = img.get.bind(img) as (x: number, y: number) => number | readonly number[];
  const set = img.set.bind(img) as (x: number, y: number, c: unknown) => boolean;
  const seed = get(x, y) as PixelOf<I>;
  if (pixelKey(seed) === pixelKey(colour)) return 0;
  const seedKey = pixelKey(seed);
  const matches = (px: number, py: number): boolean => {
    const p = get(px, py) as PixelOf<I>;
    return tol === 0 ? pixelKey(p) === seedKey : pixelDistance(p, seed) <= tol;
  };

  let changed = 0;
  if (options.mode === 'global') {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (matches(i, j)) {
          set(i, j, colour);
          changed++;
        }
      }
    }
    return changed;
  }

  const visited = new Uint8Array(w * h);
  const stack: number[] = [y * w + x];
  visited[y * w + x] = 1;
  while (stack.length > 0) {
    const idx = stack.pop() ?? 0;
    const px = idx % w;
    const py = (idx - px) / w;
    set(px, py, colour);
    changed++;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || (connectivity === 4 && dx !== 0 && dy !== 0)) continue;
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (visited[ni] === 1) continue;
        visited[ni] = 1;
        // An unvisited pixel has not been painted yet, so it still holds its original colour.
        if (matches(nx, ny)) stack.push(ni);
      }
    }
  }
  return changed;
}
