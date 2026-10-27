import { plotter } from './plot.js';
import type { DrawableImage, PixelOf } from './plot.js';

/** Options of {@link rect} and {@link ellipse}. */
export interface ShapeOptions {
  /** Fill the interior (default: outline only, 1 pixel wide). */
  readonly fill?: boolean;
}

/**
 * Rectangle with top-left `(x, y)` and size `w x h` pixels. `w <= 0` or `h <= 0` draws nothing. Clipped to the
 * image.
 */
export function rect<I extends DrawableImage>(
  img: I,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: PixelOf<I>,
  options: ShapeOptions = {},
): void {
  if (w <= 0 || h <= 0) return;
  const put = plotter(img, colour);
  const xe = x + w - 1;
  const ye = y + h - 1;
  // Clip the loops to the image so a huge off-canvas rectangle stays cheap.
  const cx0 = Math.max(x, 0);
  const cx1 = Math.min(xe, img.width - 1);
  const cy0 = Math.max(y, 0);
  const cy1 = Math.min(ye, img.height - 1);
  if (options.fill === true) {
    for (let j = cy0; j <= cy1; j++) for (let i = cx0; i <= cx1; i++) put(i, j);
    return;
  }
  for (let i = cx0; i <= cx1; i++) {
    put(i, y);
    put(i, ye);
  }
  for (let j = cy0; j <= cy1; j++) {
    put(x, j);
    put(xe, j);
  }
}

/**
 * Ellipse inscribed in the inclusive bounding box `(x0,y0)-(x1,y1)` (corners in any order), using Alois Zingl's
 * `plotEllipseRect` from "A Rasterizing Algorithm for Drawing Curves" (2012; the author states the programs
 * are free of copyright). All quantities are integers. Even and odd box sizes both work (including 1xN and
 * Nx1). Each step plots the four quadrants together, so the result is mirror symmetric about the box centre in
 * both axes. Calls `plot` per outline pixel, or, when `hline` is given (fill), `hline(xa, xb, y)` once per row
 * with the full span between the symmetric outline points of that row.
 *
 * Output is compared with Aseprite as an external oracle (see the raster package tests); it matches for most
 * sizes but intentionally differs for some.
 */
export function ellipsePixels(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
  hline?: (xa: number, xb: number, y: number) => void,
): void {
  const a = Math.abs(x1 - x0);
  const b = Math.abs(y1 - y0);
  const b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  if (x0 > x1) {
    x0 = x1;
    x1 += a;
  }
  if (y0 > y1) y0 = y1;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  const stepA = 8 * a * a;
  const stepB = 8 * b * b;
  // Rows are revisited while x moves; the first visit of a row is its widest span, so emit spans once per row.
  let lastTop = Number.NaN;
  let lastBottom = Number.NaN;
  do {
    if (hline !== undefined) {
      if (y0 !== lastTop) {
        hline(x0, x1, y0);
        lastTop = y0;
      }
      if (y1 !== lastBottom && y1 !== y0) {
        hline(x0, x1, y1);
        lastBottom = y1;
      }
    } else {
      plot(x1, y0);
      plot(x0, y0);
      plot(x0, y1);
      plot(x1, y1);
    }
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      dy += stepA;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      dx += stepB;
      err += dx;
    }
  } while (x0 <= x1);
  // Flat ellipses (width 1 or 2) stop too early: finish the vertical extent.
  while (y0 - y1 < b) {
    if (hline !== undefined) {
      hline(x0 - 1, x1 + 1, y0);
      hline(x0 - 1, x1 + 1, y1);
    } else {
      plot(x0 - 1, y0);
      plot(x1 + 1, y0);
      plot(x0 - 1, y1);
      plot(x1 + 1, y1);
    }
    y0++;
    y1--;
  }
}

/** Ellipse (outline, or `fill`) inscribed in the inclusive bounding box `(x0,y0)-(x1,y1)`. See {@link ellipsePixels}. */
export function ellipse<I extends DrawableImage>(
  img: I,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: PixelOf<I>,
  options: ShapeOptions = {},
): void {
  const put = plotter(img, colour);
  if (options.fill === true) {
    ellipsePixels(x0, y0, x1, y1, put, (xa, xb, y) => {
      if (y < 0 || y >= img.height) return;
      const end = Math.min(xb, img.width - 1);
      for (let x = Math.max(xa, 0); x <= end; x++) put(x, y);
    });
    return;
  }
  ellipsePixels(x0, y0, x1, y1, put);
}
