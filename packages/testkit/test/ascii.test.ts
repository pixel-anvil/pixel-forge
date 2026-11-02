import { describe, expect, it } from 'vitest';
import { AsciiError, asciiToImage, expectAscii, imageToAscii } from '../src/index.js';
import type { Legend } from '../src/index.js';

const legend: Legend = { R: [255, 0, 0, 255], B: [0, 0, 255, 255] };

describe('ascii helpers', () => {
  it('strips blank lines and common indentation; . is transparent', () => {
    const img = asciiToImage(
      `
        .R.
        B.R
      `,
      legend,
    );
    expect([img.width, img.height]).toEqual([3, 2]);
    expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...img.data.subarray(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it('round-trips', () => {
    const src = '.RB\nBR.\nRRR';
    expect(imageToAscii(asciiToImage(src, legend), legend)).toBe(src);
  });

  it('throws typed errors', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as AsciiError).code;
      }
      return undefined;
    };
    expect(code(() => asciiToImage('RR\nR', legend))).toBe('RAGGED');
    expect(code(() => asciiToImage('R\n\nR', legend))).toBe('RAGGED');
    expect(code(() => asciiToImage('\n\n', legend))).toBe('EMPTY');
    expect(code(() => asciiToImage('RX', legend))).toBe('UNKNOWN_CHAR');
    expect(code(() => asciiToImage('R', { RR: [0, 0, 0, 0] }))).toBe('BAD_LEGEND');
    expect(code(() => asciiToImage('R', { R: [0, 0, 300, 0] }))).toBe('BAD_LEGEND');
    expect(() => asciiToImage('RR\nR', legend)).toThrow(AsciiError);
  });

  it('lists unknown colours or prints ?', () => {
    const img = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 255, 255, 0, 0, 255]) };
    expect(() => imageToAscii(img, legend)).toThrow(/rgba\(1,2,3,255\) first at x=0, y=0/);
    expect(imageToAscii(img, legend, { unknown: '?' })).toBe('?R');
  });

  it('treats any alpha-0 pixel as transparent', () => {
    const img = { width: 1, height: 1, data: Uint8Array.from([9, 9, 9, 0]) };
    expect(imageToAscii(img, legend)).toBe('.');
    expectAscii(img, '.', legend);
  });

  it('expectAscii passes on equal and shows a side-by-side diff on mismatch', () => {
    const img = asciiToImage('RB\nBR', legend);
    expectAscii(img, ' RB\n BR', legend);
    let msg = '';
    try {
      expectAscii(img, 'RB\nBB', legend);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('1 differing pixel(s)');
    expect(msg).toContain('expected | actual');
    expect(msg).toContain('BB       | BR');
    expect(msg).toContain('(1,1) expected rgba(0,0,255,255) actual rgba(255,0,0,255)');
  });

  it('expectAscii reports size differences', () => {
    const img = asciiToImage('RR', legend);
    expect(() => {
      expectAscii(img, 'RR\nRR', legend);
    }).toThrow(/2 differing.*outside/s);
  });
});
