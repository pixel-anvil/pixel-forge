import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from '@pixel-forge/png';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FONT_CHARS,
  FONT_H,
  FONT_W,
  LABEL_BAND,
  asciiToImage,
  buildSheet,
  glyph,
  goldenSheet,
  sheetSize,
  textWidth,
} from '../src/index.js';

const legend = { R: [255, 0, 0, 255] } as const;
const a = asciiToImage('R.\n.R', legend);
const b = asciiToImage('RRR\n...', legend);

describe('goldenSheet', () => {
  it('has the documented size (grid)', () => {
    const s = goldenSheet(
      [
        { label: 'a', img: a },
        { label: 'b', img: b },
      ],
      { scale: 4 },
    );
    // cell = 3*4 x 2*4, 2 columns, 1 row, 1-px grid
    expect(s.width).toBe(2 * 12 + 3);
    expect(s.height).toBe(LABEL_BAND + 8 + 2);
    expect(s.data.length).toBe(s.width * s.height * 4);
  });

  it('has the documented size without grid and with wrapping', () => {
    const entries = [1, 2, 3].map((n) => ({ label: String(n), img: a }));
    const s = goldenSheet(entries, { scale: 2, grid: false, columns: 2 });
    expect(s).toMatchObject({ width: 8, height: 2 * (LABEL_BAND + 4) });
    expect(sheetSize(entries, { scale: 2, grid: false, columns: 2 })).toMatchObject({ rows: 2 });
  });

  it('draws a checkerboard behind transparent pixels and opaque pixels as-is', () => {
    const s = goldenSheet([{ label: '', img: a }], { scale: 1, grid: false });
    const at = (x: number, y: number) => [
      ...s.data.subarray((LABEL_BAND + y) * 2 * 4 + x * 4, (LABEL_BAND + y) * 2 * 4 + x * 4 + 4),
    ];
    expect(at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(1, 0)).toEqual([153, 153, 153, 255]);
    expect(at(0, 1)).toEqual([153, 153, 153, 255]);
  });

  it('renders label text pixels', () => {
    const s = goldenSheet([{ label: 'I', img: a }], { scale: 8, grid: false });
    // "I" top row is ###: font pixel (0,0) drawn 2x2 at (2,2)
    const o = (2 * s.width + 2) * 4;
    expect([...s.data.subarray(o, o + 3)]).toEqual([240, 240, 240]);
  });

  it('validates input', () => {
    expect(() => goldenSheet([])).toThrow(/no images/);
    expect(() => goldenSheet([{ label: 'x', img: a }], { scale: 0 })).toThrow(/scale/);
  });
});

describe('font', () => {
  it('has well-formed glyphs for every character', () => {
    for (const ch of FONT_CHARS) {
      const g = glyph(ch);
      expect(g).toHaveLength(FONT_H);
      g.forEach((row) => {
        expect(row).toHaveLength(FONT_W);
      });
    }
    expect(glyph('a')).toEqual(glyph('A'));
    expect(glyph('~')).toHaveLength(FONT_H);
    expect(textWidth('')).toBe(0);
    expect(textWidth('AB')).toBe(7);
  });
});

describe('buildSheet (golden:sheet)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pf-sheet-'));
    mkdirSync(join(root, '.golden-diff'));
    mkdirSync(join(root, 'packages', 'x', 'test', '__golden__'), { recursive: true });
    const png = (p: string) => {
      writeFileSync(join(root, p), encodePng({ ...a, kind: 'rgba' }));
    };
    png('packages/x/test/__golden__/foo.png');
    png('.golden-diff/foo.actual.png');
    png('.golden-diff/foo.expected.png');
    png('.golden-diff/foo.diff.png');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a sheet by name', () => {
    const { out, inputs } = buildSheet(root, 'foo', 4);
    expect(inputs).toHaveLength(4);
    expect(out).toBe(join(root, '.golden-diff', 'sheet-foo.png'));
    const s = decodePng(readFileSync(out));
    expect(s.width).toBe(4 * 8 + 5);
  });

  it('builds a sheet from a glob', () => {
    const { out, inputs } = buildSheet(root, '.golden-diff/foo.*.png');
    expect(inputs).toHaveLength(3);
    expect(existsSync(out)).toBe(true);
  });

  it('fails when nothing matches', () => {
    expect(() => buildSheet(root, 'nope')).toThrow(/no PNG files/);
  });
});
