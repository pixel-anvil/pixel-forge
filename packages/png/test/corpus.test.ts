import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodePng, decodePngRaw, encodePng } from '../src/index.js';

// Regenerate with test/corpus/make-corpus.sh.
const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();

/**
 * pngjs rejects bytes after IEND ("unrecognised content at end of stream"), and some real-world
 * files (four of the CC0 hero sheets) carry a stray trailing byte. The oracle is therefore fed the
 * file cut at the end of its IEND chunk; our decoder is given the original bytes.
 */
function cutAtIend(bytes: Uint8Array): Uint8Array {
  const at = Buffer.from(bytes).lastIndexOf('IEND');
  return bytes.subarray(0, at + 8);
}

/**
 * For tRNS colour keys (greyscale / truecolour) pngjs zeroes the RGB of the keyed pixel as well as
 * its alpha; libpng and this decoder keep the colour and only set alpha 0. Both are valid RGBA
 * for the same image, so for those files the comparison ignores RGB under alpha 0.
 */
const COLOUR_KEYED = new Set(['handmade-gray4-trns.png', 'handmade-rgb-trns.png']);
function clearTransparent(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) out.fill(0, i, i + 3);
  }
  return out;
}
function sameRgba(file: string, ours: Uint8Array, oracle: Uint8Array): boolean {
  const norm = COLOUR_KEYED.has(file) ? clearTransparent : (b: Uint8Array) => b;
  return Buffer.from(norm(ours)).equals(norm(oracle));
}

describe('corpus', () => {
  it('has at least 10 files, including each external producer', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const prefix of ['hero-', 'pngjs-', 'handmade-', 'sips-', 'aseprite-']) {
      expect(files.some((f) => f.startsWith(prefix))).toBe(true);
    }
  });

  for (const file of files) {
    describe(file, () => {
      const bytes = new Uint8Array(readFileSync(dir + file));
      const oracle = PNG.sync.read(Buffer.from(cutAtIend(bytes)));

      it('decodes to the same RGBA as pngjs', () => {
        const ours = decodePng(bytes);
        expect([ours.width, ours.height]).toEqual([oracle.width, oracle.height]);
        expect(sameRgba(file, ours.data, oracle.data)).toBe(true);
      });

      it('survives our own encode, decoding to the same RGBA', () => {
        const ours = decodePng(bytes);
        const again = decodePng(encodePng(ours));
        expect(sameRgba(file, again.data, oracle.data)).toBe(true);
      });
    });
  }

  it('ignores bytes after IEND', () => {
    const bytes = new Uint8Array(readFileSync(dir + 'pngjs-rgba.png'));
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    expect(Array.from(decodePng(padded).data)).toEqual(Array.from(decodePng(bytes).data));
  });

  it('keeps the colour under a tRNS colour key and sets only alpha 0', () => {
    const img = decodePng(new Uint8Array(readFileSync(dir + 'handmade-rgb-trns.png')));
    expect(Array.from(img.data.subarray(0, 8))).toEqual([10, 20, 30, 0, 19, 0, 200, 255]);
  });

  it('keeps 8-bit greyscale as gray8 in decodePngRaw', () => {
    const raw = decodePngRaw(new Uint8Array(readFileSync(dir + 'pngjs-gray.png')));
    expect(raw.kind).toBe('gray8');
    expect(raw.data.length).toBe(raw.width * raw.height);
  });

  it('expands palette images (PLTE + tRNS) to rgba in decodePngRaw', () => {
    const raw = decodePngRaw(new Uint8Array(readFileSync(dir + 'handmade-palette8.png')));
    expect(raw.kind).toBe('rgba');
    // Entry 0 has tRNS alpha 0, entry 1 has 64.
    expect(raw.data[3]).toBe(0);
    expect(raw.data[7]).toBe(64);
  });
});
