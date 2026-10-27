import { FONT_H, FONT_W, glyph } from './font.js';
import { assertImage, createImage } from './image.js';
import type { TestImage } from './image.js';

/** One labelled image on a {@link goldenSheet}. */
export interface SheetEntry {
  label: string;
  img: TestImage;
}

/** Options for {@link goldenSheet}. */
export interface SheetOptions {
  /** Integer upscale factor per source pixel. Default 8. */
  scale?: number;
  /** Draw a 1-px frame between cells and (when `scale >= 4`) between source pixels. Default true. */
  grid?: boolean;
  /** Cells per row. Default `min(images, 8)`. */
  columns?: number;
}

/** Pixel size of the label text (each font pixel is drawn as 2x2). */
const LABEL_SCALE = 2;
/** Height of the label band above each cell: text plus 2 px padding above and below. */
export const LABEL_BAND = FONT_H * LABEL_SCALE + 4;

const BG = [40, 40, 48] as const;
const FRAME = [96, 96, 128] as const;
const TEXT = [240, 240, 240] as const;
const CHECK_A = 204;
const CHECK_B = 153;

function put(out: TestImage, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
  out.data.set([r, g, b, 255], (y * out.width + x) * 4);
}

function drawText(out: TestImage, text: string, x0: number, y0: number, maxX: number): void {
  let x = x0;
  for (const ch of text) {
    if (x + FONT_W * LABEL_SCALE > maxX) return;
    glyph(ch).forEach((row, gy) => {
      for (let gx = 0; gx < FONT_W; gx++) {
        if (row[gx] !== '#') continue;
        for (let dy = 0; dy < LABEL_SCALE; dy++) {
          for (let dx = 0; dx < LABEL_SCALE; dx++) {
            put(out, x + gx * LABEL_SCALE + dx, y0 + gy * LABEL_SCALE + dy, ...TEXT);
          }
        }
      }
    });
    x += (FONT_W + 1) * LABEL_SCALE;
  }
}

/** Expected size of a sheet, so callers and tests can predict {@link goldenSheet}'s output. */
export function sheetSize(
  images: readonly SheetEntry[],
  opts: SheetOptions = {},
): { width: number; height: number; columns: number; rows: number } {
  const scale = opts.scale ?? 8;
  const g = (opts.grid ?? true) ? 1 : 0;
  const columns = Math.max(1, opts.columns ?? Math.min(images.length, 8));
  const rows = Math.ceil(images.length / columns);
  const cellW = Math.max(...images.map((e) => e.img.width)) * scale;
  const cellH = Math.max(...images.map((e) => e.img.height)) * scale;
  return {
    width: columns * cellW + (columns + 1) * g,
    height: rows * (LABEL_BAND + cellH) + (rows + 1) * g,
    columns,
    rows,
  };
}

/**
 * Lay labelled images out in a grid for human review. Each image is upscaled by `scale` (nearest
 * neighbour) over a grey checkerboard (one square per source pixel) so transparency is visible;
 * labels use a built-in 3x5 bitmap font. Cell size is the largest image times `scale`; the sheet is
 * `columns * cellW + (columns + 1) * g` wide and `rows * (LABEL_BAND + cellH) + (rows + 1) * g` tall,
 * where `g` is 1 with `grid` and 0 without (see {@link sheetSize}).
 */
export function goldenSheet(images: readonly SheetEntry[], opts: SheetOptions = {}): TestImage {
  if (images.length === 0) throw new Error('goldenSheet: no images');
  const scale = opts.scale ?? 8;
  if (!Number.isInteger(scale) || scale < 1)
    throw new Error('goldenSheet: scale must be a positive integer');
  images.forEach((e) => {
    assertImage(e.img);
  });
  const grid = opts.grid ?? true;
  const g = grid ? 1 : 0;
  const { width, height, columns } = sheetSize(images, opts);
  const cellW = Math.max(...images.map((e) => e.img.width)) * scale;
  const cellH = Math.max(...images.map((e) => e.img.height)) * scale;
  const out = createImage(width, height);
  for (let i = 0; i < width * height; i++) out.data.set([...BG, 255], i * 4);

  if (grid) {
    for (let x = 0; x < width; x++)
      for (let y = 0; y < height; y++) {
        const colLine = x % (cellW + 1) === 0;
        const rowLine = y % (LABEL_BAND + cellH + 1) === 0;
        if (colLine || rowLine) put(out, x, y, ...FRAME);
      }
  }

  images.forEach((entry, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x0 = g + col * (cellW + g);
    const y0 = g + row * (LABEL_BAND + cellH + g);
    drawText(out, entry.label, x0 + 2, y0 + 2, x0 + cellW);
    const iy0 = y0 + LABEL_BAND;
    const { img } = entry;
    for (let py = 0; py < img.height * scale; py++) {
      for (let px = 0; px < img.width * scale; px++) {
        const sx = Math.floor(px / scale);
        const sy = Math.floor(py / scale);
        const o = (sy * img.width + sx) * 4;
        const a = img.data[o + 3]! / 255;
        const bgv = (sx + sy) % 2 === 0 ? CHECK_A : CHECK_B;
        let r = img.data[o]! * a + bgv * (1 - a);
        let gg = img.data[o + 1]! * a + bgv * (1 - a);
        let b = img.data[o + 2]! * a + bgv * (1 - a);
        if (grid && scale >= 4 && (px % scale === 0 || py % scale === 0)) {
          r *= 0.65;
          gg *= 0.65;
          b *= 0.65;
        }
        put(out, x0 + px, iy0 + py, Math.round(r), Math.round(gg), Math.round(b));
      }
    }
  });
  return out;
}
