/**
 * Palette files (FR-PAL-02): `.hex` (Lospec), `.gpl` (GIMP), `.pal` (JASC-PAL) and PNG strips.
 *
 * Every parser returns a {@link PaletteFile}: an optional name and 1..256 opaque RGBA8 colours in file
 * order. Every writer is deterministic (same input, same bytes), uses LF line endings and ends with a
 * newline. Errors are {@link IoError}: `BAD_PALETTE_FILE` for malformed input, `PALETTE_TOO_LARGE` for
 * more than `MAX_PALETTE_COLORS` colours, `BAD_INPUT` for a palette a format cannot store.
 *
 * Formats were written from their published descriptions only (see the TSDoc of each function and the
 * fixtures in `test/fixtures/palette/`). No code was ported.
 * @packageDocumentation
 */
import { decodePng, encodePng } from '@pixel-forge/png';
import { MAX_PALETTE_COLORS } from '@pixel-forge/schema';
import type { RGBA8 } from '@pixel-forge/schema';
import { IoError } from './errors.js';

/** A palette as stored in a file: an optional name and its colours in file order. */
export interface PaletteFile {
  /** Name, or `null` when the format has none (`.hex`, `.pal`, PNG) or the file gives none. */
  readonly name: string | null;
  /** 1..256 colours, RGBA8. Parsers return alpha 255, except PNG strips (alpha 1..255). */
  readonly colors: readonly RGBA8[];
}

function badFile(message: string, cause?: unknown): IoError {
  return new IoError('BAD_PALETTE_FILE', message, cause === undefined ? undefined : { cause });
}

/** UTF-8 text without a leading byte order mark. Invalid UTF-8 is a `BAD_PALETTE_FILE`. */
function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw badFile('palette file is not valid UTF-8 text', cause);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits on LF or CRLF. */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Checks the colour count of a parsed file: at least one colour, at most 256. */
function finish(name: string | null, colors: RGBA8[]): PaletteFile {
  if (colors.length === 0) throw badFile('palette file has no colours');
  if (colors.length > MAX_PALETTE_COLORS) {
    throw new IoError(
      'PALETTE_TOO_LARGE',
      `palette has ${String(colors.length)} colours, the limit is ${String(MAX_PALETTE_COLORS)}`,
    );
  }
  return { name, colors };
}

/** Parses a channel value written in decimal, `0..255`. */
function channel(text: string, line: number): number {
  if (!/^\d+$/.test(text)) throw badFile(`line ${String(line)}: "${text}" is not a decimal value`);
  const v = Number(text);
  if (v > 255) throw badFile(`line ${String(line)}: value ${text} is outside 0..255`);
  return v;
}

function hexByte(v: number): string {
  return v.toString(16).padStart(2, '0');
}

function hexColour(c: RGBA8): string {
  return `#${hexByte(c[0])}${hexByte(c[1])}${hexByte(c[2])}`;
}

/**
 * Checks colours before a writer runs: 1..256 colours, integer channels `0..255`, and an alpha the
 * format can store (`rgbOnly`: alpha 255; PNG: alpha 1..255, because a PNG strip skips alpha 0).
 */
function checkWritable(colors: readonly RGBA8[], rgbOnly: boolean): void {
  if (colors.length === 0) throw new IoError('BAD_INPUT', 'palette has no colours');
  if (colors.length > MAX_PALETTE_COLORS) {
    throw new IoError(
      'PALETTE_TOO_LARGE',
      `palette has ${String(colors.length)} colours, the limit is ${String(MAX_PALETTE_COLORS)}`,
    );
  }
  colors.forEach((c, i) => {
    for (const v of c) {
      if (!Number.isInteger(v) || v < 0 || v > 255) {
        throw new IoError(
          'BAD_INPUT',
          `colour ${String(i)} has channel ${String(v)} outside 0..255`,
        );
      }
    }
    if (rgbOnly && c[3] !== 255) {
      throw new IoError(
        'BAD_INPUT',
        `colour ${String(i)} has alpha ${String(c[3])}: this format stores RGB only (alpha must be 255)`,
      );
    }
    if (!rgbOnly && c[3] === 0) {
      throw new IoError(
        'BAD_INPUT',
        `colour ${String(i)} has alpha 0: a PNG strip skips transparent pixels, so it cannot be stored`,
      );
    }
  });
}

/**
 * Parses a Lospec `.hex` file: one `RRGGBB` per line. A leading `#` is optional, blank lines are
 * ignored, and CRLF is accepted. The file has no name.
 *
 * Format: Lospec palette-list export convention (one hex colour per line, no header).
 * @param bytes - file contents (UTF-8)
 * @returns the palette, alpha 255
 * @throws IoError `BAD_PALETTE_FILE` for a line that is not six hex digits or for no colours;
 *   `PALETTE_TOO_LARGE` for more than 256 colours
 */
export function parseHexPalette(bytes: Uint8Array): PaletteFile {
  const colors: RGBA8[] = [];
  linesOf(decodeText(bytes)).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    const digits = line.startsWith('#') ? line.slice(1) : line;
    if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
      throw badFile(`line ${String(i + 1)}: expected RRGGBB, got "${line}"`);
    }
    colors.push([
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
      255,
    ]);
  });
  return finish(null, colors);
}

/**
 * Writes a `.hex` file: one lower-case `RRGGBB` per line, LF endings, trailing newline. The name is
 * not stored.
 * @throws IoError `BAD_INPUT` for an empty palette or a colour that is not opaque;
 *   `PALETTE_TOO_LARGE` for more than 256 colours
 */
export function writeHexPalette(file: PaletteFile): Uint8Array {
  checkWritable(file.colors, true);
  const body = file.colors.map((c) => `${hexByte(c[0])}${hexByte(c[1])}${hexByte(c[2])}\n`);
  return new TextEncoder().encode(body.join(''));
}

/**
 * Parses a GIMP `.gpl` palette. Format (GIMP palette file): first line `GIMP Palette`; header lines
 * `Name: <text>` (optional) and `Columns: <n>` (optional, ignored); `#` comment lines and blank lines
 * are skipped; a colour line is `R G B`, optionally followed by whitespace and a name (ignored).
 * Any other `Key:` header is an error.
 * @param bytes - file contents (UTF-8)
 * @returns the palette; `name` is the `Name:` value, or `null` if absent or empty
 * @throws IoError `BAD_PALETTE_FILE` for a missing header, a bad header, a bad colour line, a value
 *   outside `0..255` or no colours; `PALETTE_TOO_LARGE` for more than 256 colours
 */
export function parseGplPalette(bytes: Uint8Array): PaletteFile {
  const lines = linesOf(decodeText(bytes));
  if (lines[0]?.trim() !== 'GIMP Palette') {
    throw badFile('line 1: missing "GIMP Palette" header');
  }
  let name: string | null = null;
  const colors: RGBA8[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const n = i + 1;
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('Name:')) {
      const value = line.slice('Name:'.length).trim();
      name = value === '' ? null : value;
      continue;
    }
    if (line.startsWith('Columns:')) {
      const value = line.slice('Columns:'.length).trim();
      if (!/^\d+$/.test(value)) throw badFile(`line ${String(n)}: Columns must be a whole number`);
      continue;
    }
    const colour = /^(\S+)\s+(\S+)\s+(\S+)(?:\s.*)?$/.exec(line);
    if (colour === null || !/^\d/.test(line)) {
      throw badFile(`line ${String(n)}: expected "R G B [name]" or a known header, got "${line}"`);
    }
    colors.push([
      channel(colour[1] ?? '', n),
      channel(colour[2] ?? '', n),
      channel(colour[3] ?? '', n),
      255,
    ]);
    if (colors.length > MAX_PALETTE_COLORS) {
      throw new IoError(
        'PALETTE_TOO_LARGE',
        `palette has more than ${String(MAX_PALETTE_COLORS)} colours`,
      );
    }
  }
  return finish(name, colors);
}

/**
 * Writes a GIMP `.gpl` palette: `GIMP Palette`, a `Name:` line (omitted when the name is `null`),
 * `Columns: 0`, a `#` line, then `R G B<TAB>#RRGGBB` per colour (channels right-aligned in three
 * columns). LF endings, trailing newline.
 * @throws IoError `BAD_INPUT` for an empty palette, a name with a line break, or a colour that is not
 *   opaque; `PALETTE_TOO_LARGE` for more than 256 colours
 */
export function writeGplPalette(file: PaletteFile): Uint8Array {
  checkWritable(file.colors, true);
  if (file.name !== null && /[\r\n]/.test(file.name)) {
    throw new IoError('BAD_INPUT', 'palette name must not contain a line break');
  }
  let out = 'GIMP Palette\n';
  if (file.name !== null) out += `Name: ${file.name.trim()}\n`;
  out += 'Columns: 0\n#\n';
  for (const c of file.colors) {
    const cols = [c[0], c[1], c[2]].map((v) => String(v).padStart(3, ' '));
    out += `${cols.join(' ')}\t${hexColour(c)}\n`;
  }
  return new TextEncoder().encode(out);
}

/**
 * Parses a JASC-PAL `.pal` file. Format (JASC palette file): line 1 `JASC-PAL`, line 2 `0100`,
 * line 3 the colour count `N`, then exactly `N` lines `R G B` (decimal, `0..255`). Nothing but blank
 * lines may follow. CRLF is accepted. The file has no name.
 * @param bytes - file contents (UTF-8)
 * @returns the palette, alpha 255
 * @throws IoError `BAD_PALETTE_FILE` for a bad signature or version, a count that is not a whole
 *   number, fewer or more colour lines than the count, a bad colour line or no colours;
 *   `PALETTE_TOO_LARGE` for a count above 256
 */
export function parseJascPalette(bytes: Uint8Array): PaletteFile {
  const lines = linesOf(decodeText(bytes));
  if (lines[0]?.trim() !== 'JASC-PAL') throw badFile('line 1: missing "JASC-PAL" signature');
  if (lines[1]?.trim() !== '0100') throw badFile('line 2: expected version "0100"');
  const countText = (lines[2] ?? '').trim();
  if (!/^\d+$/.test(countText))
    throw badFile(`line 3: colour count "${countText}" is not a number`);
  const count = Number(countText);
  if (count > MAX_PALETTE_COLORS) {
    throw new IoError(
      'PALETTE_TOO_LARGE',
      `palette declares ${String(count)} colours, the limit is ${String(MAX_PALETTE_COLORS)}`,
    );
  }
  if (count === 0) throw badFile('palette file has no colours');
  const colors: RGBA8[] = [];
  for (let k = 0; k < count; k++) {
    const n = 4 + k;
    const raw = lines[3 + k];
    if (raw === undefined || raw.trim() === '') {
      throw badFile(`count is ${String(count)} but the file has only ${String(k)} colour lines`);
    }
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length !== 3)
      throw badFile(`line ${String(n)}: expected "R G B", got "${raw.trim()}"`);
    colors.push([
      channel(tokens[0] ?? '', n),
      channel(tokens[1] ?? '', n),
      channel(tokens[2] ?? '', n),
      255,
    ]);
  }
  for (let j = 3 + count; j < lines.length; j++) {
    if ((lines[j] ?? '').trim() !== '') {
      throw badFile(
        `line ${String(j + 1)}: data after the ${String(count)} declared colours (count mismatch)`,
      );
    }
  }
  return finish(null, colors);
}

/**
 * Writes a JASC-PAL `.pal` file: `JASC-PAL`, `0100`, the colour count, then `R G B` per colour.
 * LF endings, trailing newline. The name is not stored.
 * @throws IoError `BAD_INPUT` for an empty palette or a colour that is not opaque;
 *   `PALETTE_TOO_LARGE` for more than 256 colours
 */
export function writeJascPalette(file: PaletteFile): Uint8Array {
  checkWritable(file.colors, true);
  let out = `JASC-PAL\n0100\n${String(file.colors.length)}\n`;
  for (const c of file.colors) out += `${String(c[0])} ${String(c[1])} ${String(c[2])}\n`;
  return new TextEncoder().encode(out);
}

/**
 * Reads a PNG strip. The palette is every distinct colour of the image, in first-seen order in
 * reading order (row by row, left to right). The image may have any height, so a 1-row or N-row
 * image works. Colours are RGBA8 (decoded with `@pixel-forge/png`, so palette, grey and 16-bit PNGs
 * are accepted in the forms that decoder supports).
 *
 * **Alpha 0 pixels are skipped** (they are transparent, so they are not a colour). Pixels with alpha
 * 1..255 are kept as their own colour, alpha included, so two colours that differ only in alpha are
 * two entries. The file has no name.
 * @param bytes - PNG file bytes
 * @returns the palette
 * @throws IoError `BAD_PALETTE_FILE` if the PNG cannot be decoded or has no pixel with alpha above 0;
 *   `PALETTE_TOO_LARGE` if more than 256 distinct colours appear
 */
export function parsePngStripPalette(bytes: Uint8Array): PaletteFile {
  let img;
  try {
    img = decodePng(bytes);
  } catch (cause) {
    throw badFile('palette PNG cannot be decoded', cause);
  }
  const seen = new Set<number>();
  const colors: RGBA8[] = [];
  const d = img.data;
  for (let p = 0; p < img.width * img.height; p++) {
    const o = p * 4;
    const r = d[o] ?? 0;
    const g = d[o + 1] ?? 0;
    const b = d[o + 2] ?? 0;
    const a = d[o + 3] ?? 0;
    if (a === 0) continue;
    const key = ((r * 256 + g) * 256 + b) * 256 + a;
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push([r, g, b, a]);
    if (colors.length > MAX_PALETTE_COLORS) {
      throw new IoError(
        'PALETTE_TOO_LARGE',
        `PNG strip has more than ${String(MAX_PALETTE_COLORS)} distinct colours`,
      );
    }
  }
  return finish(null, colors);
}

/**
 * Writes a PNG strip: an `N x 1` RGBA8 PNG with one pixel per colour, in palette order. Encoded by
 * `@pixel-forge/png` (deterministic). The name is not stored.
 * @throws IoError `BAD_INPUT` for an empty palette, a channel outside `0..255`, or alpha 0 (which a
 *   strip cannot hold, because the reader skips transparent pixels); `PALETTE_TOO_LARGE` for more
 *   than 256 colours
 */
export function writePngStripPalette(file: PaletteFile): Uint8Array {
  checkWritable(file.colors, false);
  const n = file.colors.length;
  const data = new Uint8Array(n * 4);
  file.colors.forEach((c, i) => {
    data.set(c, i * 4);
  });
  return encodePng({ width: n, height: 1, kind: 'rgba', data });
}
