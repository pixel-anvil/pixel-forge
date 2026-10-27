import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PngError, decodePng, encodePng } from '../src/index.js';
import type { PngErrorCode } from '../src/index.js';
import { makePixels, mutate, readChunks, writeChunks } from './helpers.js';

function codeOf(fn: () => unknown): PngErrorCode | 'no error' {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PngError);
    return (e as PngError).code;
  }
  return 'no error';
}

const good = encodePng({ width: 6, height: 4, data: makePixels(6, 4, 4), kind: 'rgba' });

function ihdrWith(patch: (d: Uint8Array) => void): Uint8Array {
  return mutate(good, 'IHDR', (d) => {
    const c = d.slice();
    patch(c);
    return c;
  });
}

describe('encodePng errors', () => {
  const ok = Uint8Array.of(1, 2, 3, 4);
  it('rejects bad dimensions', () => {
    for (const [w, h] of [
      [0, 1],
      [1, 0],
      [-1, 1],
      [1.5, 1],
      [Number.NaN, 1],
      [2 ** 31, 1],
    ] as const) {
      expect(codeOf(() => encodePng({ width: w, height: h, data: ok, kind: 'rgba' }))).toBe(
        'INVALID_DIMENSIONS',
      );
    }
  });
  it('rejects wrong data length', () => {
    expect(codeOf(() => encodePng({ width: 2, height: 1, data: ok, kind: 'rgba' }))).toBe(
      'INVALID_DATA_LENGTH',
    );
    expect(codeOf(() => encodePng({ width: 2, height: 1, data: ok, kind: 'gray8' }))).toBe(
      'INVALID_DATA_LENGTH',
    );
  });
  it('rejects an unknown kind', () => {
    const kind = 'rgb' as unknown as 'rgba';
    expect(codeOf(() => encodePng({ width: 1, height: 1, data: ok, kind }))).toBe('INVALID_KIND');
  });
});

describe('decodePng errors', () => {
  it('accepts the unmodified file', () => {
    expect(codeOf(() => decodePng(good))).toBe('no error');
  });

  it('BAD_SIGNATURE', () => {
    const bad = good.slice();
    bad[1] = 0x51;
    expect(codeOf(() => decodePng(bad))).toBe('BAD_SIGNATURE');
    expect(codeOf(() => decodePng(new Uint8Array(0)))).toBe('BAD_SIGNATURE');
    expect(codeOf(() => decodePng(new TextEncoder().encode('GIF89a......')))).toBe('BAD_SIGNATURE');
  });

  it('TRUNCATED at several cut points', () => {
    for (const n of [
      8,
      12,
      20,
      33,
      Math.floor(good.length / 2),
      good.length - 13,
      good.length - 1,
    ]) {
      expect(codeOf(() => decodePng(good.subarray(0, n)))).toBe('TRUNCATED');
    }
  });

  it('BAD_CRC when a payload byte flips', () => {
    const idatAt = 8 + 12 + 13 + 8; // signature + IHDR chunk + IDAT header
    const bad = good.slice();
    bad[idatAt + 2] = (bad[idatAt + 2] ?? 0) ^ 0xff;
    expect(codeOf(() => decodePng(bad))).toBe('BAD_CRC');
    const badCrc = good.slice();
    badCrc[badCrc.length - 1] = (badCrc[badCrc.length - 1] ?? 0) ^ 1; // IEND CRC
    expect(codeOf(() => decodePng(badCrc))).toBe('BAD_CRC');
  });

  it('UNSUPPORTED_INTERLACE (with a valid CRC)', () => {
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[12] = 1))))).toBe('UNSUPPORTED_INTERLACE');
  });

  it('BAD_IHDR variants', () => {
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[12] = 2))))).toBe('BAD_IHDR');
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[9] = 5))))).toBe('BAD_IHDR');
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[8] = 3))))).toBe('BAD_IHDR');
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[10] = 1))))).toBe('BAD_IHDR');
    expect(codeOf(() => decodePng(ihdrWith((d) => d.fill(0, 0, 4))))).toBe('BAD_IHDR'); // width 0
    const chunks = readChunks(good);
    expect(codeOf(() => decodePng(writeChunks(chunks.slice(1))))).toBe('BAD_IHDR'); // no IHDR first
    expect(codeOf(() => decodePng(mutate(good, 'IHDR', (d) => d.subarray(0, 12))))).toBe(
      'BAD_IHDR',
    );
  });

  it('UNSUPPORTED_FORMAT for 16-bit samples', () => {
    expect(codeOf(() => decodePng(ihdrWith((d) => (d[8] = 16))))).toBe('UNSUPPORTED_FORMAT');
  });

  it('IMAGE_TOO_LARGE', () => {
    const huge = ihdrWith((d) => {
      d[1] = 1; // width 65536
      d[5] = 1; // height 65536
    });
    expect(codeOf(() => decodePng(huge))).toBe('IMAGE_TOO_LARGE');
  });

  it('MISSING_IDAT', () => {
    expect(
      codeOf(() => decodePng(writeChunks(readChunks(good).filter((c) => c.type !== 'IDAT')))),
    ).toBe('MISSING_IDAT');
  });

  it('DECOMPRESS_FAILED and BAD_DATA_SIZE', () => {
    expect(codeOf(() => decodePng(mutate(good, 'IDAT', (d) => d.subarray(0, 4))))).toBe(
      'DECOMPRESS_FAILED',
    );
    expect(codeOf(() => decodePng(mutate(good, 'IDAT', () => zlibSync(new Uint8Array(10)))))).toBe(
      'BAD_DATA_SIZE',
    );
  });

  it('BAD_FILTER', () => {
    const raw = new Uint8Array((6 * 4 + 1) * 4);
    raw[0] = 9;
    expect(codeOf(() => decodePng(mutate(good, 'IDAT', () => zlibSync(raw))))).toBe('BAD_FILTER');
  });

  it('BAD_PALETTE and BAD_TRNS', () => {
    const palette = ihdrWith((d) => (d[9] = 3));
    expect(codeOf(() => decodePng(palette))).toBe('BAD_PALETTE'); // no PLTE
    const withBadPlte = writeChunks([
      ...readChunks(palette).flatMap((c) =>
        c.type === 'IHDR' ? [c, { type: 'PLTE', data: new Uint8Array(4) }] : [c],
      ),
    ]);
    expect(codeOf(() => decodePng(withBadPlte))).toBe('BAD_PALETTE'); // length not multiple of 3
    const trns = writeChunks(
      readChunks(ihdrWith((d) => (d[9] = 2))).flatMap((c) =>
        c.type === 'IHDR' ? [c, { type: 'tRNS', data: new Uint8Array(3) }] : [c],
      ),
    );
    expect(codeOf(() => decodePng(trns))).toBe('BAD_TRNS');
  });

  it('ignores unknown ancillary chunks', () => {
    const chunks = readChunks(good);
    const extra = writeChunks([
      ...chunks.slice(0, 1),
      { type: 'tEXt', data: new TextEncoder().encode('k\0v') },
      ...chunks.slice(1),
    ]);
    expect(codeOf(() => decodePng(extra))).toBe('no error');
  });

  it('PngError carries name and code', () => {
    const e = new PngError('BAD_CRC', 'x');
    expect(e.name).toBe('PngError');
    expect(e.code).toBe('BAD_CRC');
    expect(e.message).toContain('x');
  });
});
