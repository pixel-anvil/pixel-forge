import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '@pixel-forge/png';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asciiToImage, compareGolden, expectGolden, hashRGBA } from '../src/index.js';

const legend = { R: [255, 0, 0, 255], B: [0, 0, 255, 255] } as const;
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pf-golden-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const img = (a: string) => asciiToImage(a, legend);

describe('hashRGBA', () => {
  it('is stable, size-sensitive and data-sensitive', () => {
    const a = img('RB');
    expect(hashRGBA(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRGBA(a)).toBe(hashRGBA(img('RB')));
    expect(hashRGBA(a)).not.toBe(hashRGBA(img('BR')));
    // same bytes, different shape
    expect(hashRGBA(img('RB'))).not.toBe(hashRGBA(img('R\nB')));
  });

  it('hashes u32be width, u32be height, then data', async () => {
    const { createHash } = await import('node:crypto');
    const a = img('R');
    const h = createHash('sha256')
      .update(Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 255, 0, 0, 255]))
      .digest('hex');
    expect(hashRGBA(a)).toBe(h);
  });

  it('rejects malformed images', () => {
    expect(() => hashRGBA({ width: 2, height: 1, data: new Uint8Array(4) })).toThrow(/length/);
    expect(() => hashRGBA({ width: 0, height: 1, data: new Uint8Array(0) })).toThrow(/size/);
  });
});

describe('expectGolden', () => {
  const opts = () => ({ goldenDir: join(tmp, 'g'), diffDir: join(tmp, 'd') });

  it('fails clearly when the golden is missing', () => {
    expect(() => {
      expectGolden('a', img('RB'), opts());
    }).toThrow(/not found.*UPDATE_GOLDEN=1/s);
  });

  it('UPDATE_GOLDEN writes the golden, prints a notice, then it matches', () => {
    vi.stubEnv('UPDATE_GOLDEN', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expectGolden('a', img('RB'), opts());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created golden'));
    expectGolden('a', img('RB'), opts()); // up to date: no rewrite
    expectGolden('a', img('BR'), opts()); // overwrite
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('updated golden'));
    warn.mockRestore();
    vi.unstubAllEnvs();
    expect(hashRGBA(decodePng(readFileSync(join(tmp, 'g', 'a.png'))))).toBe(hashRGBA(img('BR')));
    expect(() => {
      expectGolden('a', img('BR'), opts());
    }).not.toThrow();
  });

  it('on mismatch writes actual/expected/diff and reports hashes and pixel count', () => {
    vi.stubEnv('UPDATE_GOLDEN', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expectGolden('m', img('RRR\nBBB'), opts());
    vi.unstubAllEnvs();
    const actual = img('RRB\nBBR');
    let msg = '';
    try {
      expectGolden('m', actual, opts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(hashRGBA(img('RRR\nBBB')));
    expect(msg).toContain(hashRGBA(actual));
    expect(msg).toContain('2 differing pixel(s)');
    for (const k of ['actual', 'expected', 'diff']) {
      expect(existsSync(join(tmp, 'd', `m.${k}.png`))).toBe(true);
    }
    const diff = decodePng(readFileSync(join(tmp, 'd', 'm.diff.png')));
    const px = (x: number, y: number) => [
      ...diff.data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4),
    ];
    expect(px(2, 0)).toEqual([255, 0, 255, 255]);
    expect(px(2, 1)).toEqual([255, 0, 255, 255]);
    expect(px(0, 0)[0]).toBe(px(0, 0)[1]); // equal pixel is grey
  });

  it('uses PF_GOLDEN_DIFF_DIR and the test directory by default', () => {
    vi.stubEnv('PF_GOLDEN_DIFF_DIR', join(tmp, 'envdiff'));
    const r = compareGolden('x', img('R'), join(tmp, 'g'), { update: true });
    expect(r.status).toBe('created');
    const r2 = compareGolden('x', img('B'), join(tmp, 'g'), { update: false });
    expect(r2.diffFiles?.diff).toBe(join(tmp, 'envdiff', 'x.diff.png'));
  });

  it('colours alpha-only differences cyan and counts size changes', () => {
    compareGolden('al', asciiToImage('R', legend), join(tmp, 'g'), { update: true });
    const half = { width: 1, height: 1, data: Uint8Array.from([255, 0, 0, 128]) };
    const r = compareGolden('al', half, join(tmp, 'g'), { diffDir: join(tmp, 'd') });
    const d = decodePng(readFileSync(r.diffFiles!.diff));
    expect([...d.data]).toEqual([0, 255, 255, 255]);
    const big = compareGolden('al', img('RB\nBR'), join(tmp, 'g'), { diffDir: join(tmp, 'd') });
    expect(big.diffPixels).toBe(3);
    expect(big.message).toContain('expected 1x1, actual 2x2');
  });

  it('resolves __golden__ next to the test via testFile', () => {
    vi.stubEnv('UPDATE_GOLDEN', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const testFile = join(tmp, 'sub', 'x.test.ts');
    expectGolden('t', img('R'), { testFile });
    expect(existsSync(join(tmp, 'sub', '__golden__', 't.png'))).toBe(true);
  });
});
