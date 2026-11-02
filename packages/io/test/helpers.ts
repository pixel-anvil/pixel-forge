import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFrame } from '@pixel-forge/core';
import type { DocumentStore } from '@pixel-forge/core';
import { decodePng, encodePng } from '@pixel-forge/png';
import type { PngImage } from '@pixel-forge/png';
import {
  IoError,
  cc0SheetInputs,
  createDocumentFromSpritesheet,
  importSpritesheetTx,
} from '../src/index.js';
import type { IoErrorCode } from '../src/index.js';

const heroDir = fileURLToPath(new URL('../../../fixtures/cc0/hero_swordsman/', import.meta.url));

/** Bytes of a file in `fixtures/cc0/hero_swordsman`. */
export function heroFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(heroDir + name));
}

/** The parsed `sheet.json` of the CC0 hero. */
export function heroSheetJson(): {
  cell: [number, number];
  animations: Record<string, { file: string; frames: [number, number][] }>;
} {
  return JSON.parse(readFileSync(heroDir + 'sheet.json', 'utf8')) as ReturnType<
    typeof heroSheetJson
  >;
}

/** Bytes of a file next to the tests. */
export function testFile(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
}

/** Builds a document from every animation file of the CC0 hero (all into layer `body`). */
export function heroDocument(): DocumentStore {
  const inputs = cc0SheetInputs(heroSheetJson(), heroFile, { durationMs: 100 });
  const [first, ...rest] = inputs;
  if (!first) throw new Error('no inputs');
  const { store } = createDocumentFromSpritesheet(first, { name: 'hero' });
  store.transact('Import more', (tx) => {
    for (const input of rest) importSpritesheetTx(tx, input);
  });
  return store;
}

/** Independent oracle: crop a cell straight from decoded PNG bytes. */
export function cropCell(
  png: PngImage,
  row: number,
  col: number,
  cw: number,
  ch: number,
): Uint8Array {
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((row * ch + y) * png.width + col * cw) * 4;
    out.set(png.data.subarray(from, from + cw * 4), y * cw * 4);
  }
  return out;
}

/** The RGBA bytes of a rendered frame. */
export function renderBytes(store: DocumentStore, group: string, index: number): Uint8Array {
  return renderFrame(store, { group }, index).toRGBA().data;
}

/** A small RGBA PNG from rows of colour letters (`.` transparent). */
export function pngFromRows(
  rows: string[],
  legend: Record<string, readonly [number, number, number, number]>,
): Uint8Array {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const data = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      data.set(legend[row.charAt(x)] ?? [0, 0, 0, 0], (y * w + x) * 4);
    }
  });
  return encodePng({ width: w, height: h, data, kind: 'rgba' });
}

/** The IoError code thrown by `f`, `'other'` for any other error, or undefined. */
export function ioCode(f: () => unknown): IoErrorCode | 'other' | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof IoError ? e.code : 'other';
  }
  return undefined;
}

export { decodePng };

/** Byte-wise equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Returns `v`, or throws when it is undefined. */
export function need<T>(v: T | undefined, what = 'value'): T {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** Parsed JSON file next to the tests. */
export function testJson(rel: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
}
