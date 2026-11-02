import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/crc32.js';
import { decodePng, decodePngRaw, encodePng } from '../src/index.js';
import { makePixels, readChunks, sha256 } from './helpers.js';

const SIZES: readonly (readonly [number, number])[] = [
  [1, 1],
  [3, 5],
  [64, 64],
  [1, 300],
  [300, 1],
  [17, 9],
];

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('round trip', () => {
  for (const [w, h] of SIZES) {
    it(`rgba ${String(w)}x${String(h)}`, () => {
      const data = makePixels(w, h, 4, w * 31 + h);
      const back = decodePng(encodePng({ width: w, height: h, data, kind: 'rgba' }));
      expect(back.kind).toBe('rgba');
      expect([back.width, back.height]).toEqual([w, h]);
      expect(Array.from(back.data)).toEqual(Array.from(data));
    });

    it(`gray8 ${String(w)}x${String(h)}`, () => {
      const data = makePixels(w, h, 1, w * 17 + h);
      const bytes = encodePng({ width: w, height: h, data, kind: 'gray8' });
      const raw = decodePngRaw(bytes);
      expect(raw.kind).toBe('gray8');
      expect(Array.from(raw.data)).toEqual(Array.from(data));
      // decodePng expands to opaque grey RGBA.
      const rgba = decodePng(bytes);
      expect(rgba.kind).toBe('rgba');
      for (let i = 0; i < data.length; i++) {
        expect(Array.from(rgba.data.subarray(i * 4, i * 4 + 4))).toEqual([
          data[i],
          data[i],
          data[i],
          255,
        ]);
      }
    });
  }

  it('accepts all 256 gray values and extreme rgba values', () => {
    const gray = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(
      Array.from(
        decodePngRaw(encodePng({ width: 16, height: 16, data: gray, kind: 'gray8' })).data,
      ),
    ).toEqual(Array.from(gray));
    const rgba = Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 128, 1, 7, 255, 0, 254);
    expect(
      Array.from(decodePng(encodePng({ width: 4, height: 1, data: rgba, kind: 'rgba' })).data),
    ).toEqual(Array.from(rgba));
  });
});

describe('byte stability', () => {
  it('encodes the same input to identical bytes', () => {
    const data = makePixels(64, 64, 4, 7);
    const a = encodePng({ width: 64, height: 64, data, kind: 'rgba' });
    const b = encodePng({ width: 64, height: 64, data: data.slice(), kind: 'rgba' });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('pins the SHA-256 of reference encodings (update only on a deliberate encoder change)', () => {
    const rgba = encodePng({ width: 64, height: 64, data: makePixels(64, 64, 4, 7), kind: 'rgba' });
    const gray = encodePng({
      width: 31,
      height: 20,
      data: makePixels(31, 20, 1, 9),
      kind: 'gray8',
    });
    expect(sha256(rgba)).toBe('63505ccdd50b1d23f6d7babd952f2946b7375b6a88f0ee5210e0d731e134e66c');
    expect(sha256(gray)).toBe('63377e1d6f5cb5413a48c552cc224bc19b122e3cf09a490b31e247bb8c5f725d');
  });

  it('writes only IHDR, one IDAT and IEND, with the documented header', () => {
    const bytes = encodePng({ width: 5, height: 3, data: makePixels(5, 3, 4), kind: 'rgba' });
    const chunks = readChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = Array.from(chunks[0]?.data ?? []);
    expect(ihdr.slice(8)).toEqual([8, 6, 0, 0, 0]);
    const g = readChunks(
      encodePng({ width: 5, height: 3, data: makePixels(5, 3, 1), kind: 'gray8' }),
    );
    expect(Array.from(g[0]?.data ?? []).slice(8)).toEqual([8, 0, 0, 0, 0]);
  });
});

describe('pngjs as independent decoder of our output', () => {
  for (const [w, h] of SIZES) {
    it(`rgba ${String(w)}x${String(h)}`, () => {
      const data = makePixels(w, h, 4, 3);
      const png = PNG.sync.read(
        Buffer.from(encodePng({ width: w, height: h, data, kind: 'rgba' })),
      );
      expect([png.width, png.height]).toEqual([w, h]);
      expect(Array.from(png.data)).toEqual(Array.from(data));
    });

    it(`gray8 ${String(w)}x${String(h)}`, () => {
      const data = makePixels(w, h, 1, 5);
      const bytes = encodePng({ width: w, height: h, data, kind: 'gray8' });
      const png = PNG.sync.read(Buffer.from(bytes));
      expect(Array.from(png.data)).toEqual(Array.from(decodePng(bytes).data));
    });
  }
});

describe('pngjs as independent encoder of our input', () => {
  it('decodes a pngjs-written rgba image exactly', () => {
    const data = makePixels(23, 11, 4, 2);
    const src = new PNG({ width: 23, height: 11 });
    src.data = Buffer.from(data);
    const back = decodePng(PNG.sync.write(src));
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });
});
