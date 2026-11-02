import { createHash } from 'node:crypto';
import { hashRGBA as testkitHash } from '@pixel-forge/testkit';
import { describe, expect, it } from 'vitest';
import { hashRGBA, RasterError, sha256Hex, TiledImage } from '../src/index.js';
import { randomImage, rng } from './util.js';

const enc = new TextEncoder();

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across padding boundaries', () => {
    const r = rng(7);
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000, 4097]) {
      const data = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('hashRGBA', () => {
  it('uses the testkit layout (u32be w, u32be h, RGBA)', () => {
    const img = randomImage(37, 21, 3).toRGBA();
    expect(hashRGBA(img)).toBe(testkitHash(img));
    expect(randomImage(37, 21, 3).hashRGBA()).toBe(testkitHash(img));
  });

  it('depends on the dimensions, not only the bytes', () => {
    const a = hashRGBA({ width: 2, height: 1, data: new Uint8Array(8) });
    const b = hashRGBA({ width: 1, height: 2, data: new Uint8Array(8) });
    expect(a).not.toBe(b);
  });

  it('rejects bad images', () => {
    expect(() => hashRGBA({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(RasterError);
    expect(() => hashRGBA({ width: 0, height: 2, data: new Uint8Array(0) })).toThrow(RasterError);
    expect(new TiledImage(2, 2).hashRGBA()).toBe(
      testkitHash({ width: 2, height: 2, data: new Uint8Array(16) }),
    );
  });
});
