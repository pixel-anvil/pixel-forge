import { brushMask } from './brush.js';
import type { Brush } from './brush.js';
import { plotter } from './plot.js';
import type { DrawableImage, PixelOf } from './plot.js';

/** Options of {@link line}. */
export interface LineOptions {
  /** Stamp brush (default: single pixels). */
  readonly brush?: Brush;
}

/**
 * Calls `plot(x, y)` for each pixel of the Bresenham line (error-term form after Zingl; equivalent output to
 * common pixel editors for left-to-right lines), integers only.
 *
 * Symmetry: the line from A to B has the same pixel set as from B to A. Bresenham alone is not symmetric when
 * the ideal line passes exactly through a pixel-edge midpoint (ties), so the endpoints are first ordered
 * lexicographically (smaller x first, then smaller y) and the walk always starts at that endpoint. Ties are then
 * resolved by the error tests `2*err >= dy` / `2*err <= dx`: when both hold the walk steps diagonally.
 */
export function linePoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  if (x0 > x1 || (x0 === x1 && y0 > y1)) {
    [x0, y0, x1, y1] = [x1, y1, x0, y0];
  }
  const dx = x1 - x0; // >= 0 after ordering
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    const e2 = 2 * err;
    if (e2 >= dy) {
      if (x0 === x1) break;
      err += dy;
      x0++;
    }
    if (e2 <= dx) {
      if (y0 === y1) break;
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Draws a line between two points (both inclusive), optionally with a {@link Brush}. Pixels outside the image
 * are skipped. Symmetric: `line(A, B)` and `line(B, A)` set the same pixels (see {@link linePoints}).
 * `colour` is `Rgba` for a `TiledImage`, a palette index for an `IndexedImage`.
 */
export function line<I extends DrawableImage>(
  img: I,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: PixelOf<I>,
  options: LineOptions = {},
): void {
  const put = plotter(img, colour);
  if (options.brush === undefined) {
    linePoints(x0, y0, x1, y1, put);
    return;
  }
  const { size, offset, cells } = brushMask(options.brush);
  linePoints(x0, y0, x1, y1, (x, y) => {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        if (cells[j * size + i]) put(x + offset + i, y + offset + j);
      }
    }
  });
}
