import { assertImage } from './image.js';
import type { Rgba, TestImage } from './image.js';

/** Maps one character to a colour. `.` is transparent `[0,0,0,0]` unless the legend overrides it. */
export type Legend = Record<string, Rgba>;

/** Error codes of {@link AsciiError}. */
export type AsciiErrorCode = 'EMPTY' | 'RAGGED' | 'UNKNOWN_CHAR' | 'UNKNOWN_COLOUR' | 'BAD_LEGEND';

/** Typed error thrown by the ASCII helpers. */
export class AsciiError extends Error {
  readonly code: AsciiErrorCode;
  constructor(code: AsciiErrorCode, message: string) {
    super(message);
    this.name = 'AsciiError';
    this.code = code;
  }
}

const TRANSPARENT: Rgba = [0, 0, 0, 0];

function fullLegend(legend: Legend): Legend {
  for (const [ch, c] of Object.entries(legend)) {
    if (ch.length !== 1 || /\s/.test(ch)) {
      throw new AsciiError(
        'BAD_LEGEND',
        `legend key ${JSON.stringify(ch)} must be one non-whitespace character`,
      );
    }
    if (c.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
      throw new AsciiError(
        'BAD_LEGEND',
        `legend colour for ${JSON.stringify(ch)} must be [r,g,b,a] bytes`,
      );
    }
  }
  return '.' in legend ? legend : { '.': TRANSPARENT, ...legend };
}

/** Split into rows: drop leading/trailing blank lines, strip common indentation and trailing spaces. */
export function asciiRows(ascii: string): string[] {
  const lines = ascii.split(/\r?\n/).map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const indent = Math.min(
    ...lines.filter((l) => l !== '').map((l) => l.length - l.trimStart().length),
  );
  const cut = Number.isFinite(indent) ? indent : 0;
  return lines.map((l) => l.slice(cut));
}

/**
 * Build an image from hand-written ASCII art. One character per pixel; rows separated by newlines;
 * leading/trailing blank lines and common indentation are stripped (so space cannot be a legend
 * character). Throws {@link AsciiError}: `EMPTY` (no rows), `RAGGED` (unequal row lengths, interior
 * blank lines included), `UNKNOWN_CHAR` (not in legend), `BAD_LEGEND`.
 */
export function asciiToImage(ascii: string, legend: Legend = {}): TestImage {
  const full = fullLegend(legend);
  const rows = asciiRows(ascii);
  if (rows.length === 0) throw new AsciiError('EMPTY', 'ASCII image has no rows');
  const width = rows[0]!.length;
  rows.forEach((r, y) => {
    if (r.length !== width) {
      throw new AsciiError(
        'RAGGED',
        `ASCII row ${String(y)} has length ${String(r.length)}, expected ${String(width)} (row 0)`,
      );
    }
  });
  const data = new Uint8Array(width * rows.length * 4);
  rows.forEach((r, y) => {
    for (let x = 0; x < width; x++) {
      const ch = r[x]!;
      const c = full[ch];
      if (!c) {
        throw new AsciiError(
          'UNKNOWN_CHAR',
          `ASCII char ${JSON.stringify(ch)} at x=${String(x)}, y=${String(y)} is not in the legend`,
        );
      }
      data.set(c, (y * width + x) * 4);
    }
  });
  return { width, height: rows.length, data };
}

/** Options for {@link imageToAscii}. */
export interface ImageToAsciiOptions {
  /** `'error'` (default) throws `UNKNOWN_COLOUR` listing all unknown colours; `'?'` prints `?`. */
  unknown?: 'error' | '?';
}

const key = (r: number, g: number, b: number, a: number): string =>
  `${String(r)},${String(g)},${String(b)},${String(a)}`;

/**
 * Render an image as ASCII using the legend (reverse of {@link asciiToImage}). If several legend
 * characters share a colour the first wins. A pixel with alpha 0 and no exact match renders as the
 * transparent legend character (`.` by default).
 */
export function imageToAscii(
  img: TestImage,
  legend: Legend = {},
  opts: ImageToAsciiOptions = {},
): string {
  assertImage(img);
  const full = fullLegend(legend);
  const rev = new Map<string, string>();
  for (const [ch, c] of Object.entries(full)) {
    const k = key(...c);
    if (!rev.has(k)) rev.set(k, ch);
  }
  const clearChar = Object.entries(full).find(([, c]) => c[3] === 0)?.[0];
  const unknown = new Map<string, [number, number]>();
  const lines: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let line = '';
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const d = img.data;
      const k = key(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);
      let ch = rev.get(k);
      if (ch === undefined && d[o + 3] === 0) ch = clearChar;
      if (ch === undefined) {
        if (!unknown.has(k)) unknown.set(k, [x, y]);
        ch = '?';
      }
      line += ch;
    }
    lines.push(line);
  }
  if (unknown.size > 0 && (opts.unknown ?? 'error') === 'error') {
    const list = [...unknown].map(
      ([k, [x, y]]) => `rgba(${k}) first at x=${String(x)}, y=${String(y)}`,
    );
    throw new AsciiError('UNKNOWN_COLOUR', `colours not in legend: ${list.join('; ')}`);
  }
  return lines.join('\n');
}

function sameColour(a: Uint8Array, ao: number, b: Uint8Array, bo: number): boolean {
  if (a[ao + 3] === 0 && b[bo + 3] === 0) return true;
  return (
    a[ao] === b[bo] && a[ao + 1] === b[bo + 1] && a[ao + 2] === b[bo + 2] && a[ao + 3] === b[bo + 3]
  );
}

function describePixel(i: TestImage, x: number, y: number): string {
  if (x >= i.width || y >= i.height) return 'outside';
  const o = (y * i.width + x) * 4;
  return `rgba(${[...i.data.subarray(o, o + 4)].join(',')})`;
}

/**
 * Assert `img` equals the hand-written ASCII expectation. Pixels with alpha 0 compare equal regardless
 * of RGB. On mismatch throws an Error with a side-by-side expected | actual ASCII drawing (unknown
 * actual colours shown as `?`) and the coordinates and colours of the first differing pixels.
 */
export function expectAscii(img: TestImage, ascii: string, legend: Legend = {}): void {
  const expected = asciiToImage(ascii, legend);
  const actualRows = imageToAscii(img, legend, { unknown: '?' }).split('\n');
  const expectedRows = imageToAscii(expected, legend, { unknown: '?' }).split('\n');
  const diffs: string[] = [];
  let count = 0;
  const w = Math.max(img.width, expected.width);
  const h = Math.max(img.height, expected.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBoth = x < img.width && y < img.height && x < expected.width && y < expected.height;
      if (
        inBoth &&
        sameColour(expected.data, (y * expected.width + x) * 4, img.data, (y * img.width + x) * 4)
      ) {
        continue;
      }
      count++;
      if (diffs.length < 10) {
        diffs.push(
          `  (${String(x)},${String(y)}) expected ${describePixel(expected, x, y)} actual ${describePixel(img, x, y)}`,
        );
      }
    }
  }
  if (count === 0) return;
  const colW = Math.max(expected.width, 8);
  const rows = Math.max(expectedRows.length, actualRows.length);
  const side = [`${'expected'.padEnd(colW)} | actual`];
  for (let i = 0; i < rows; i++) {
    side.push(`${(expectedRows[i] ?? '').padEnd(colW)} | ${actualRows[i] ?? ''}`);
  }
  throw new Error(
    `ASCII mismatch: ${String(count)} differing pixel(s), expected ${String(expected.width)}x${String(expected.height)}, ` +
      `actual ${String(img.width)}x${String(img.height)}\n${side.join('\n')}\nfirst differences:\n${diffs.join('\n')}`,
  );
}
