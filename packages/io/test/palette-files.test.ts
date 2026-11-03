import { describe, expect, it } from 'vitest';
import {
  IoError,
  parseGplPalette,
  parseHexPalette,
  parseJascPalette,
  parsePngStripPalette,
  writeGplPalette,
  writeHexPalette,
  writeJascPalette,
  writePngStripPalette,
} from '../src/index.js';
import type { PaletteFile } from '../src/index.js';
import { testFile } from './helpers.js';

/**
 * Oracles: the fixtures in `fixtures/palette/` are written by hand from the format descriptions
 * (`sample.hex`, `sample.gpl`, `sample.pal`) or built byte by byte from the PNG specification
 * (`strip-3x2.png`, generator kept outside the repo). The expected values below are written out by
 * hand, so the parsers are checked against the files and never against themselves.
 */
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The error code thrown by `fn`, or `null` when it does not throw. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof IoError) return e.code;
    throw e;
  }
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

describe('.hex (Lospec)', () => {
  it('parses the sample: optional #, case-insensitive, blank lines skipped', () => {
    expect(parseHexPalette(testFile('./fixtures/palette/sample.hex'))).toEqual({
      name: null,
      colors: [RED, GREEN, BLUE],
    });
  });

  it('accepts CRLF and a byte order mark', () => {
    const bytes = text('﻿ff0000\r\n0000ff\r\n');
    expect(parseHexPalette(bytes).colors).toEqual([RED, BLUE]);
  });

  it('rejects a line that is not six hex digits, with its line number', () => {
    expect(codeOf(() => parseHexPalette(text('ff0000\nff00\n')))).toBe('BAD_PALETTE_FILE');
    expect(() => parseHexPalette(text('ff0000\nzz0000\n'))).toThrow(/line 2/);
  });

  it('rejects a file with no colours', () => {
    expect(codeOf(() => parseHexPalette(text('\n\n')))).toBe('BAD_PALETTE_FILE');
  });

  it('rejects more than 256 colours', () => {
    const lines = Array.from({ length: 257 }, (_, i) => i.toString(16).padStart(6, '0'));
    expect(codeOf(() => parseHexPalette(text(lines.join('\n'))))).toBe('PALETTE_TOO_LARGE');
  });

  it('writes RRGGBB lines with LF and a trailing newline, deterministically', () => {
    const out = writeHexPalette({ name: 'ignored', colors: [RED, [1, 171, 255, 255]] });
    expect(new TextDecoder().decode(out)).toBe('ff0000\n01abff\n');
    expect(writeHexPalette({ name: null, colors: [RED, [1, 171, 255, 255]] })).toEqual(out);
  });

  it('round-trips', () => {
    const file: PaletteFile = { name: null, colors: [RED, GREEN, BLUE] };
    expect(parseHexPalette(writeHexPalette(file))).toEqual(file);
  });
});

describe('.gpl (GIMP)', () => {
  it('parses name, comments, colour names and the Columns header', () => {
    expect(parseGplPalette(testFile('./fixtures/palette/sample.gpl'))).toEqual({
      name: 'Sample Three',
      colors: [
        [0, 0, 0, 255],
        [255, 0, 0, 255],
        [10, 200, 30, 255],
      ],
    });
  });

  it('requires the GIMP Palette header on line 1', () => {
    expect(codeOf(() => parseGplPalette(text('0 0 0\n')))).toBe('BAD_PALETTE_FILE');
  });

  it('rejects a channel above 255 and an unknown header', () => {
    expect(() => parseGplPalette(text('GIMP Palette\n256 0 0\n'))).toThrow(/outside 0\.\.255/);
    expect(() => parseGplPalette(text('GIMP Palette\nFoo: bar\n0 0 0\n'))).toThrow(/line 2/);
  });

  it('rejects a line with fewer than three values', () => {
    expect(codeOf(() => parseGplPalette(text('GIMP Palette\n1 2\n')))).toBe('BAD_PALETTE_FILE');
  });

  it('rejects a palette with no colours and more than 256', () => {
    expect(codeOf(() => parseGplPalette(text('GIMP Palette\nName: x\n')))).toBe('BAD_PALETTE_FILE');
    const rows = Array.from({ length: 257 }, (_, i) => `${String(i % 256)} 0 0`).join('\n');
    expect(codeOf(() => parseGplPalette(text(`GIMP Palette\n${rows}\n`)))).toBe(
      'PALETTE_TOO_LARGE',
    );
  });

  it('writes the exact GIMP layout with LF and a trailing newline', () => {
    const out = writeGplPalette({ name: 'Two', colors: [RED, [10, 200, 30, 255]] });
    expect(new TextDecoder().decode(out)).toBe(
      'GIMP Palette\nName: Two\nColumns: 0\n#\n' +
        '255   0   0\t#ff0000\n' +
        ' 10 200  30\t#0ac81e\n',
    );
  });

  it('omits the Name line when the name is null, and round-trips', () => {
    const file: PaletteFile = { name: null, colors: [RED, GREEN] };
    const out = writeGplPalette(file);
    expect(new TextDecoder().decode(out)).not.toContain('Name:');
    expect(parseGplPalette(out)).toEqual(file);
    expect(parseGplPalette(writeGplPalette({ name: 'Two', colors: [RED] })).name).toBe('Two');
  });
});

describe('.pal (JASC-PAL)', () => {
  it('parses the sample', () => {
    expect(parseJascPalette(testFile('./fixtures/palette/sample.pal'))).toEqual({
      name: null,
      colors: [
        [0, 0, 0, 255],
        [255, 128, 1, 255],
        [12, 34, 56, 255],
      ],
    });
  });

  it('accepts CRLF and trailing blank lines', () => {
    const bytes = text('JASC-PAL\r\n0100\r\n1\r\n9 8 7\r\n\r\n');
    expect(parseJascPalette(bytes).colors).toEqual([[9, 8, 7, 255]]);
  });

  it('rejects a count that is larger than the colour lines', () => {
    const bytes = text('JASC-PAL\n0100\n4\n0 0 0\n1 1 1\n2 2 2\n');
    expect(codeOf(() => parseJascPalette(bytes))).toBe('BAD_PALETTE_FILE');
    expect(() => parseJascPalette(bytes)).toThrow(/count is 4/);
  });

  it('rejects a count that is smaller than the colour lines', () => {
    const bytes = text('JASC-PAL\n0100\n2\n0 0 0\n1 1 1\n2 2 2\n');
    expect(() => parseJascPalette(bytes)).toThrow(/count mismatch/);
  });

  it('rejects a value of 256, a bad signature or version, and a count above 256', () => {
    expect(() => parseJascPalette(text('JASC-PAL\n0100\n1\n256 0 0\n'))).toThrow(
      /outside 0\.\.255/,
    );
    expect(codeOf(() => parseJascPalette(text('JASC-PAL\n0200\n1\n0 0 0\n')))).toBe(
      'BAD_PALETTE_FILE',
    );
    expect(codeOf(() => parseJascPalette(text('PAL\n0100\n1\n0 0 0\n')))).toBe('BAD_PALETTE_FILE');
    expect(codeOf(() => parseJascPalette(text('JASC-PAL\n0100\n257\n')))).toBe('PALETTE_TOO_LARGE');
  });

  it('writes JASC-PAL with LF and a trailing newline, and round-trips', () => {
    const file: PaletteFile = { name: null, colors: [RED, [12, 34, 56, 255]] };
    expect(new TextDecoder().decode(writeJascPalette(file))).toBe(
      'JASC-PAL\n0100\n2\n255 0 0\n12 34 56\n',
    );
    expect(parseJascPalette(writeJascPalette(file))).toEqual(file);
  });
});

describe('PNG strip', () => {
  it('reads distinct colours in first-seen reading order and skips alpha 0', () => {
    // strip-3x2.png: row 0 red, green, red; row 1 transparent (9,9,9,0), blue, green.
    expect(parsePngStripPalette(testFile('./fixtures/palette/strip-3x2.png'))).toEqual({
      name: null,
      colors: [RED, GREEN, BLUE],
    });
  });

  it('keeps partial alpha as its own colour', () => {
    const file = parsePngStripPalette(
      writePngStripPalette({
        name: null,
        colors: [
          [1, 2, 3, 128],
          [1, 2, 3, 255],
        ],
      }),
    );
    expect(file.colors).toEqual([
      [1, 2, 3, 128],
      [1, 2, 3, 255],
    ]);
  });

  it('writes an Nx1 RGBA PNG, one pixel per colour, and round-trips', () => {
    const file: PaletteFile = { name: null, colors: [RED, GREEN, BLUE, [0, 0, 0, 255]] };
    const bytes = writePngStripPalette(file);
    expect(Array.from(bytes.subarray(16, 24))).toEqual([0, 0, 0, 4, 0, 0, 0, 1]);
    expect(writePngStripPalette(file)).toEqual(bytes);
    expect(parsePngStripPalette(bytes)).toEqual(file);
  });

  it('rejects bytes that are not a PNG', () => {
    expect(codeOf(() => parsePngStripPalette(text('not a png')))).toBe('BAD_PALETTE_FILE');
  });

  it('rejects writing alpha 0, which the reader would drop', () => {
    expect(codeOf(() => writePngStripPalette({ name: null, colors: [[1, 2, 3, 0]] }))).toBe(
      'BAD_INPUT',
    );
  });
});

describe('writer checks', () => {
  it('rejects an empty palette, a partially transparent colour for RGB formats, and >256 colours', () => {
    expect(codeOf(() => writeHexPalette({ name: null, colors: [] }))).toBe('BAD_INPUT');
    expect(codeOf(() => writeJascPalette({ name: null, colors: [[1, 2, 3, 128]] }))).toBe(
      'BAD_INPUT',
    );
    expect(codeOf(() => writeGplPalette({ name: null, colors: [[1, 2, 3, 0]] }))).toBe('BAD_INPUT');
    const many = Array.from({ length: 257 }, () => RED);
    expect(codeOf(() => writeHexPalette({ name: null, colors: many }))).toBe('PALETTE_TOO_LARGE');
    expect(codeOf(() => writePngStripPalette({ name: null, colors: many }))).toBe(
      'PALETTE_TOO_LARGE',
    );
  });

  it('accepts exactly 256 colours', () => {
    const full = Array.from({ length: 256 }, (_, i): [number, number, number, number] => [
      i,
      0,
      0,
      255,
    ]);
    expect(parseHexPalette(writeHexPalette({ name: null, colors: full })).colors).toHaveLength(256);
  });

  it('rejects a GPL name with a line break', () => {
    expect(codeOf(() => writeGplPalette({ name: 'a\nb', colors: [RED] }))).toBe('BAD_INPUT');
  });
});
