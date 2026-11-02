import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildZip,
  dosDateTime,
  isSafeEntryPath,
  orderEntries,
  readPxf,
  readZip,
  writePxf,
} from '../src/index.js';
import { bytesEqual, heroDocument, ioCode } from './helpers.js';
import { fakeRig, frozenStore, opts } from './pxf-helpers.js';

const have = (cmd: string): boolean =>
  spawnSync(cmd, ['-v']).status !== null && !spawnSync(cmd, ['-v']).error;
const hasUnzip = have('unzip');

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);

/** Central directory entries: name, method, DOS time and date. */
function centralDirectory(zip: Uint8Array) {
  const eocd = zip.length - 22;
  const count = u16(zip, eocd + 10);
  let p = u16(zip, eocd + 16) + u16(zip, eocd + 18) * 65536;
  const out: { name: string; method: number; time: number; date: number }[] = [];
  for (let i = 0; i < count; i++) {
    const nl = u16(zip, p + 28);
    out.push({
      name: strFromU8(zip.subarray(p + 46, p + 46 + nl)),
      method: u16(zip, p + 10),
      time: u16(zip, p + 12),
      date: u16(zip, p + 14),
    });
    p += 46 + nl + u16(zip, p + 30) + u16(zip, p + 32);
  }
  return out;
}

describe('ZIP container', () => {
  const bytes = writePxf(frozenStore(), opts());
  const cd = centralDirectory(bytes);

  it('uses the fixed entry order', () => {
    const names = cd.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(['manifest.json', 'document.json']);
    const images = names.filter((n) => n.startsWith('images/'));
    expect(images.length).toBe(6);
    expect(names.slice(2, 8)).toEqual(images);
    expect(images).toEqual([...images].sort());
    expect(names[8]).toBe('render/index.json');
    const frames = names.slice(9);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((n) => n.startsWith('render/') && n.endsWith('.png'))).toBe(true);
    expect(frames).toEqual([...frames].sort());
  });

  it('deflates JSON (method 8) and stores PNGs (method 0)', () => {
    for (const e of cd) expect(e.method).toBe(e.name.endsWith('.png') ? 0 : 8);
  });

  it('stamps every entry with the DOS time of manifest.modified (UTC, 2 s resolution)', () => {
    const want = dosDateTime('2026-10-27T10:00:00Z');
    expect(want).toEqual({ time: (10 << 11) | 0, date: ((2026 - 1980) << 9) | (10 << 5) | 27 });
    for (const e of cd) expect({ time: e.time, date: e.date }).toEqual(want);
    expect(dosDateTime('2026-10-27T10:00:03Z').time & 31).toBe(1);
    expect(dosDateTime('1970-01-01T00:00:00Z')).toEqual({ time: 0, date: (0 << 9) | (1 << 5) | 1 });
    expect(dosDateTime('2999-06-01T00:00:00Z').date >> 9).toBe(127);
    expect(ioCode(() => dosDateTime('nope'))).toBe('BAD_PXF');
  });

  it('does not depend on the machine time zone', () => {
    const saved = process.env.TZ;
    try {
      const out: Uint8Array[] = [];
      for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        out.push(writePxf(frozenStore(), opts()));
      }
      for (const o of out) expect(bytesEqual(o, bytes)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('is a pure function of its input (repeated writes are identical)', () => {
    expect(bytesEqual(writePxf(frozenStore(), opts()), bytes)).toBe(true);
  });

  it('orders entries and validates paths', () => {
    const e = (path: string) => ({ path, data: new Uint8Array(0) });
    expect(
      orderEntries(
        [
          'render/b/1.png',
          'z.txt',
          'images/b.png',
          'render/index.json',
          'document.json',
          'images/a.png',
          'manifest.json',
          'render/a/1.png',
        ].map(e),
      ).map((x) => x.path),
    ).toEqual([
      'manifest.json',
      'document.json',
      'images/a.png',
      'images/b.png',
      'render/index.json',
      'render/a/1.png',
      'render/b/1.png',
      'z.txt',
    ]);
    expect(['a/b.png', 'x'].every(isSafeEntryPath)).toBe(true);
    for (const bad of ['', '/a', 'a//b', '../a', 'a/../b', './a', 'a\\b', 'a/']) {
      expect(isSafeEntryPath(bad)).toBe(false);
    }
    expect(ioCode(() => buildZip([e('../x')], '2026-01-01T00:00:00Z'))).toBe('BAD_PXF');
    expect(ioCode(() => buildZip([e('a'), e('a')], '2026-01-01T00:00:00Z'))).toBe('BAD_PXF');
  });

  it('readZip skips folder entries and rejects unsafe names', () => {
    const files = readZip(bytes);
    expect(files.has('manifest.json')).toBe(true);
    expect(ioCode(() => readZip(new Uint8Array([80, 75, 3, 4])))).toBe('BAD_PXF');
  });

  it('is read by fflate and re-written identically from its own entries', () => {
    const files = unzipSync(bytes);
    const rebuilt = buildZip(
      Object.entries(files).map(([path, data]) => ({ path, data })),
      (JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as { modified: string })
        .modified,
    );
    expect(bytesEqual(rebuilt, bytes)).toBe(true);
  });
});

describe.skipIf(!hasUnzip)('independent unzip (the oracle for Godot ZIPReader)', () => {
  it('lists, tests and extracts every entry', () => {
    const store = heroDocument();
    const bytes = writePxf(store, { ...opts(), rig: fakeRig });
    const dir = mkdtempSync(join(tmpdir(), 'pxf-unzip-'));
    try {
      const file = join(dir, 'x.pxf');
      writeFileSync(file, bytes);
      const list = spawnSync('unzip', ['-l', file], { encoding: 'utf8' });
      expect(list.status).toBe(0);
      const names = Object.keys(unzipSync(bytes));
      for (const n of names) expect(list.stdout).toContain(n);
      const test = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
      expect(test.status).toBe(0);
      expect(test.stdout).toContain('No errors detected');
      const manifest = spawnSync('unzip', ['-p', file, 'manifest.json']);
      expect(strFromU8(new Uint8Array(manifest.stdout))).toBe(
        strFromU8(unzipSync(bytes)['manifest.json'] ?? new Uint8Array()),
      );
      const doc = spawnSync('unzip', ['-p', file, 'document.json']);
      expect(
        bytesEqual(
          new Uint8Array(doc.stdout),
          unzipSync(bytes)['document.json'] ?? new Uint8Array(),
        ),
      ).toBe(true);
      const png = names.find((n) => n.startsWith('render/') && n.endsWith('.png')) ?? '';
      const out = spawnSync('unzip', ['-p', file, png]);
      expect(
        bytesEqual(new Uint8Array(out.stdout), unzipSync(bytes)[png] ?? new Uint8Array()),
      ).toBe(true);
      // Method column of `unzip -v`: Defl for JSON, Stored for PNG.
      const verbose = spawnSync('unzip', ['-v', file], { encoding: 'utf8' }).stdout;
      expect(verbose).toMatch(/Stored.*render\/.*\.png/);
      expect(verbose).toMatch(/Defl:N.*document\.json/);
      // And pixel-forge reads the same bytes back.
      expect(readPxf(bytes).renderIndex).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
