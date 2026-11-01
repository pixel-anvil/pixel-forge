/**
 * Text pixel grids (FR-AI-13): the symbol alphabet, hex colours, the per-call legend and the
 * coordinate rulers shared by `pixels.readGrid` and `pixels.writeGrid`.
 *
 * A grid row is a string with one character per pixel. `.` is transparent in reads and writes, `_`
 * means "keep the pixel as it is" (writes only), and `0-9A-Za-z` are legend symbols for opaque or
 * translucent colours.
 * @packageDocumentation
 */
import type { Rgba } from '@pixel-forge/raster';
import { z } from 'zod';
import { OpError } from './errors.js';

/** Widest or tallest region one `pixels.readGrid` call returns. */
export const MAX_READ_GRID = 64;
/** Widest or tallest region one `pixels.writeGrid` call accepts. */
export const MAX_WRITE_GRID = 32;
/** Symbols a per-call legend can hold: `0-9A-Za-z`. */
export const GRID_SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** The grid character for a transparent pixel. */
export const TRANSPARENT_SYMBOL = '.';
/** The grid character that leaves a pixel unchanged in a write. */
export const KEEP_SYMBOL = '_';

/** A legend colour: `#rrggbb` (opaque) or `#rrggbbaa`. */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'use "#rrggbb" or "#rrggbbaa"');

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/** `#rrggbb` for an opaque colour, `#rrggbbaa` otherwise (lower case). */
export function toHex(c: Rgba): string {
  const base = `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
  return c[3] === 255 ? base : `${base}${hex2(c[3])}`;
}

/** Parses a {@link HexColor}; a 6-digit colour is opaque. */
export function parseHex(text: string): Rgba {
  const v = (i: number): number => Number.parseInt(text.slice(i, i + 2), 16);
  return [v(1), v(3), v(5), text.length === 9 ? v(7) : 255];
}

/** A grid read: rows of symbols plus the legend that explains them. */
export interface GridText {
  /** Symbol to `#rrggbb[aa]`; `.` (transparent) is implicit and never listed. */
  readonly legend: Record<string, string>;
  /** One string per pixel row. */
  readonly rows: string[];
}

/**
 * Renders a `width` x `height` region starting at `(x, y)` as text. Symbols go to colours in the order
 * their colours first appear (row-major), from `0-9A-Za-z`; every pixel with alpha 0 is `.`.
 * @throws OpError `REFUSED` (`reason: 'too-many-colors'`) when the region has more than 62 colours.
 */
export function gridToText(
  pixel: (x: number, y: number) => Rgba,
  x: number,
  y: number,
  width: number,
  height: number,
): GridText {
  const symbolOf = new Map<string, string>();
  const rows: string[] = [];
  for (let yy = y; yy < y + height; yy++) {
    let row = '';
    for (let xx = x; xx < x + width; xx++) {
      const c = pixel(xx, yy);
      if (c[3] === 0) {
        row += TRANSPARENT_SYMBOL;
        continue;
      }
      const key = toHex(c);
      let s = symbolOf.get(key);
      if (s === undefined) {
        s = GRID_SYMBOLS[symbolOf.size];
        if (s === undefined) {
          throw new OpError(
            'REFUSED',
            `the region has more than ${String(GRID_SYMBOLS.length)} colours, which a grid legend cannot hold; read a smaller region, or use render_frame to look at it`,
            { reason: 'too-many-colors', max: GRID_SYMBOLS.length },
          );
        }
        symbolOf.set(key, s);
      }
      row += s;
    }
    rows.push(row);
  }
  const legend: Record<string, string> = {};
  for (const [colour, symbol] of symbolOf) legend[symbol] = colour;
  return { legend, rows };
}

/**
 * `rows` with coordinate rulers: two header lines (tens and ones digit of the column `x`, the tens
 * digit only where `x` is a multiple of 10) and the row number `y` left of every row. The rulers are
 * for reading; a write takes the plain rows.
 */
export function withRulers(rows: readonly string[], x: number, y: number): string[] {
  const gutter = String(y + rows.length - 1).length + 1;
  const width = rows[0]?.length ?? 0;
  let tens = '';
  let ones = '';
  for (let i = 0; i < width; i++) {
    const col = x + i;
    tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : ' ';
    ones += String(col % 10);
  }
  const pad = ' '.repeat(gutter);
  return [
    `${pad}${tens}`,
    `${pad}${ones}`,
    ...rows.map((r, i) => `${String(y + i).padStart(gutter - 1)} ${r}`),
  ];
}
