import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IoError,
  MemoryFileSystem,
  dirnameOf,
  fixedClock,
  joinPath,
  pack,
  readPxf,
  saveAtomic,
  steppedClock,
  unpack,
  writePxf,
} from '../src/index.js';
import { nodeFileSystem, systemClock } from '../src/node.js';
import { bytesEqual, heroDocument, need } from './helpers.js';
import { frozenStore, opts } from './pxf-helpers.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('paths and clocks', () => {
  it('joinPath / dirnameOf', () => {
    expect(joinPath('a', 'b/c', './d/')).toBe('a/b/c/d');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(dirnameOf('a/b/c.pxf')).toBe('a/b');
    expect(dirnameOf('c.pxf')).toBe('');
    expect(dirnameOf('/c.pxf')).toBe('/');
  });

  it('fixed and stepped clocks', () => {
    expect(fixedClock('2026-01-01T00:00:00Z').now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const s = steppedClock('2026-01-01T00:00:00Z', 5000);
    expect(s.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(s.now().toISOString()).toBe('2026-01-01T00:00:05.000Z');
    expect(() => fixedClock('x')).toThrow(RangeError);
    expect(() => steppedClock('x')).toThrow(RangeError);
    expect(Number.isNaN(systemClock.now().getTime())).toBe(false);
  });
});

describe('MemoryFileSystem', () => {
  it('has POSIX-like semantics', async () => {
    const fs = new MemoryFileSystem();
    expect(await fs.exists('a')).toBe(false);
    expect(dec(await rejects(fs.readFile('a')).then(() => undefined))).toBe('');
    await expect(fs.writeFile('d/a.txt', enc('x'))).rejects.toThrow(/ENOENT/);
    await fs.mkdirp('/d/e/');
    await fs.mkdirp('d/e');
    await fs.writeFile('d/a.txt', enc('one'));
    await fs.writeFile('d/./a.txt', enc('two'));
    await fs.writeFile('d/e/b.txt', enc('b'));
    expect(dec(await fs.readFile('/d/a.txt'))).toBe('two');
    expect(await fs.exists('d')).toBe(true);
    expect(await fs.readdir('d')).toEqual([
      { name: 'a.txt', isDirectory: false },
      { name: 'e', isDirectory: true },
    ]);
    expect(await fs.readdir('')).toEqual([{ name: 'd', isDirectory: true }]);
    await expect(fs.readdir('nope')).rejects.toThrow(/ENOENT/);
    await expect(fs.writeFile('d', enc('x'))).rejects.toThrow(/EISDIR/);
    await expect(fs.mkdirp('d/a.txt')).rejects.toThrow(/EEXIST/);
    await expect(fs.writeFile('../x', enc('x'))).rejects.toThrow(/EINVAL/);

    await fs.rename('d/a.txt', 'd/e/b.txt'); // replaces
    expect(fs.files()).toEqual(['d/e/b.txt']);
    expect(dec(fs.peek('d/e/b.txt'))).toBe('two');
    await expect(fs.rename('missing', 'x')).rejects.toThrow(/ENOENT/);
    await expect(fs.rename('d/e/b.txt', 'd/e')).rejects.toThrow(/EISDIR/);
    await expect(fs.rename('d/e/b.txt', 'zz/x')).rejects.toThrow(/ENOENT/);

    await expect(fs.remove('d')).rejects.toThrow(/ENOTEMPTY/);
    await fs.remove('d/e/b.txt');
    await fs.remove('d/e/b.txt'); // idempotent
    await fs.remove('never-there');
    await fs.remove('d/e');
    expect(fs.directories()).toEqual(['d']);
    await fs.remove('');
    fs.seed('x/y/z.bin', enc('z'));
    await fs.remove('x', { recursive: true });
    expect(fs.files()).toEqual([]);
    expect(fs.directories()).toEqual(['d']);
    expect(fs.peek('nothing')).toBeUndefined();
  });

  it('copies bytes in and out', async () => {
    const fs = new MemoryFileSystem();
    const data = enc('abc');
    await fs.writeFile('f', data);
    data[0] = 0;
    const out = await fs.readFile('f');
    out[1] = 0;
    expect(dec(fs.peek('f'))).toBe('abc');
  });

  it('onOp can inject failures', async () => {
    const fs = new MemoryFileSystem({
      onOp: (op, path) => {
        if (op === 'readFile' && path === 'bad') throw new Error('disk on fire');
      },
    });
    await expect(fs.readFile('bad')).rejects.toThrow('disk on fire');
  });
});

describe('saveAtomic (FR-DOC-01)', () => {
  const ORIGINAL = enc('original file');
  const NEW = enc('new file contents');

  function seeded(onOp?: ConstructorParameters<typeof MemoryFileSystem>[0]) {
    const fs = new MemoryFileSystem(onOp);
    fs.seed('docs/a.pxf', ORIGINAL);
    return fs;
  }

  it('replaces the file and leaves no temp file', async () => {
    const fs = seeded();
    await saveAtomic(fs, 'docs/a.pxf', NEW);
    expect(dec(fs.peek('docs/a.pxf'))).toBe('new file contents');
    expect(fs.files()).toEqual(['docs/a.pxf']);
  });

  it('creates missing parent folders', async () => {
    const fs = new MemoryFileSystem();
    await saveAtomic(fs, 'a/b/c.pxf', NEW);
    expect(fs.files()).toEqual(['a/b/c.pxf']);
    await saveAtomic(fs, 'top.pxf', NEW);
    expect(fs.files()).toEqual(['a/b/c.pxf', 'top.pxf']);
  });

  it('uses a content-derived or given temp name', async () => {
    const seen: string[] = [];
    const fs = new MemoryFileSystem({ onOp: (op, p) => op === 'writeFile' && seen.push(p) });
    await saveAtomic(fs, 'a.pxf', NEW);
    await saveAtomic(fs, 'a.pxf', NEW, { nonce: '42' });
    expect(seen[0]).toMatch(/^a\.pxf\.tmp-[0-9a-f]{12}$/);
    expect(seen[1]).toBe('a.pxf.tmp-42');
  });

  it('a throwing write leaves the original intact and no temp', async () => {
    const fs = seeded({
      onOp: (op) => {
        if (op === 'writeFile') throw new Error('ENOSPC');
      },
    });
    const e = await rejects(saveAtomic(fs, 'docs/a.pxf', NEW));
    expect(e).toBeInstanceOf(IoError);
    expect((e as IoError).code).toBe('FS_FAILED');
    expect(((e as IoError).cause as Error).message).toBe('ENOSPC');
    expect(dec(fs.peek('docs/a.pxf'))).toBe('original file');
    expect(fs.files()).toEqual(['docs/a.pxf']);
  });

  it('a torn write (partial temp file, then failure) leaves the original and removes the temp', async () => {
    class Torn extends MemoryFileSystem {
      override async writeFile(path: string, data: Uint8Array): Promise<void> {
        await super.writeFile(path, data.subarray(0, 4));
        throw new Error('power cut');
      }
    }
    const fs = new Torn();
    fs.seed('docs/a.pxf', ORIGINAL);
    await expect(saveAtomic(fs, 'docs/a.pxf', NEW)).rejects.toThrow(IoError);
    expect(dec(fs.peek('docs/a.pxf'))).toBe('original file');
    expect(fs.files()).toEqual(['docs/a.pxf']);
  });

  it('a throwing rename leaves the original intact and no temp', async () => {
    const fs = seeded({
      onOp: (op) => {
        if (op === 'rename') throw new Error('EXDEV');
      },
    });
    await expect(saveAtomic(fs, 'docs/a.pxf', NEW)).rejects.toThrow(/EXDEV/);
    expect(dec(fs.peek('docs/a.pxf'))).toBe('original file');
    expect(fs.files()).toEqual(['docs/a.pxf']);
  });

  it('still reports the original error when cleaning up also fails', async () => {
    const fs = seeded({
      onOp: (op) => {
        if (op === 'rename') throw new Error('first');
        if (op === 'remove') throw new Error('second');
      },
    });
    await expect(saveAtomic(fs, 'docs/a.pxf', NEW)).rejects.toThrow(/first/);
  });

  it('end to end: a failing .pxf save keeps the previous file readable', async () => {
    const store = frozenStore();
    const good = writePxf(store, opts());
    let fail = false;
    const fs = new MemoryFileSystem({
      onOp: (op) => {
        if (fail && op === 'rename') throw new Error('crash');
      },
    });
    await saveAtomic(fs, 'hero.pxf', good);
    store.transact('Edit', (tx) => {
      tx.update((d) => {
        d.meta.name = 'changed';
      });
    });
    fail = true;
    await expect(saveAtomic(fs, 'hero.pxf', writePxf(store, opts()))).rejects.toThrow(IoError);
    expect(bytesEqual(need(fs.peek('hero.pxf')), good)).toBe(true);
    expect(fs.files()).toEqual(['hero.pxf']);
    expect(readPxf(need(fs.peek('hero.pxf'))).doc.meta.name).toBe('hero');
  });
});

describe('pack / unpack (.pxfd)', () => {
  it('round trips byte-identically and writes .gdignore', async () => {
    for (const store of [frozenStore(), heroDocument()]) {
      const bytes = writePxf(store, opts());
      const fs = new MemoryFileSystem();
      await fs.writeFile('x.pxf', bytes).catch(() => undefined);
      fs.seed('x.pxf', bytes);
      await unpack(fs, 'x.pxf', 'x.pxfd');
      const files = fs.files();
      expect(files).toContain('x.pxfd/.gdignore');
      expect(files).toContain('x.pxfd/manifest.json');
      expect(files).toContain('x.pxfd/document.json');
      expect(files.some((f) => f.startsWith('x.pxfd/images/'))).toBe(true);
      expect(files).toContain('x.pxfd/render/index.json');
      expect(files.some((f) => /^x\.pxfd\/render\/base\/.*\.png$/.test(f))).toBe(true);
      expect(fs.peek('x.pxfd/.gdignore')).toHaveLength(0);
      // Content is identical to the zip entries.
      expect(dec(fs.peek('x.pxfd/manifest.json'))).toContain('"format": "pxf"');

      await pack(fs, 'y.pxf', 'x.pxfd');
      expect(bytesEqual(need(fs.peek('y.pxf')), bytes)).toBe(true);
      // Re-pack over an existing file (atomic replace).
      await pack(fs, 'x.pxf', 'x.pxfd');
      expect(bytesEqual(need(fs.peek('x.pxf')), bytes)).toBe(true);
      expect(fs.files().filter((f) => f.includes('.tmp-'))).toEqual([]);
    }
  });

  it('pack ignores stray files and picks up edits to the folder', async () => {
    const bytes = writePxf(frozenStore(), opts({ renderCache: false }));
    const fs = new MemoryFileSystem();
    fs.seed('a.pxf', bytes);
    await unpack(fs, 'a.pxf', 'a.pxfd');
    fs.seed('a.pxfd/.DS_Store', enc('junk'));
    fs.seed('a.pxfd/notes/readme.txt', enc('junk'));
    await pack(fs, 'b.pxf', 'a.pxfd');
    expect(bytesEqual(need(fs.peek('b.pxf')), bytes)).toBe(true);
  });

  it('unpack refuses an existing folder unless overwrite is set', async () => {
    const bytes = writePxf(frozenStore(), opts({ renderCache: false }));
    const fs = new MemoryFileSystem();
    fs.seed('a.pxf', bytes);
    await unpack(fs, 'a.pxf', 'a.pxfd');
    fs.seed('a.pxfd/stale.png', enc('old'));
    const e = await rejects(unpack(fs, 'a.pxf', 'a.pxfd'));
    expect((e as IoError).code).toBe('EXISTS');
    await unpack(fs, 'a.pxf', 'a.pxfd', { overwrite: true });
    expect(fs.files()).not.toContain('a.pxfd/stale.png');
  });

  it('reports bad inputs', async () => {
    const fs = new MemoryFileSystem();
    const code = async (p: Promise<unknown>) => ((await rejects(p)) as IoError).code;
    expect(await code(unpack(fs, 'missing.pxf', 'd'))).toBe('FS_FAILED');
    fs.seed('junk.pxf', enc('not a zip'));
    expect(await code(unpack(fs, 'junk.pxf', 'd'))).toBe('BAD_PXF');
    expect(await code(pack(fs, 'o.pxf', 'nodir'))).toBe('FS_FAILED');
    await fs.mkdirp('empty.pxfd');
    expect(await code(pack(fs, 'o.pxf', 'empty.pxfd'))).toBe('BAD_PXF');
    fs.seed('bad.pxfd/manifest.json', enc('{"format":"nope"}'));
    fs.seed('bad.pxfd/document.json', enc('{}'));
    expect(await code(pack(fs, 'o.pxf', 'bad.pxfd'))).toBe('INVALID_DOCUMENT');
    fs.seed('bad.pxfd/manifest.json', enc('{'));
    expect(await code(pack(fs, 'o.pxf', 'bad.pxfd'))).toBe('BAD_PXF');
    expect(fs.files()).not.toContain('o.pxf');
  });

  it('a minimal zip without manifest cannot be unpacked', async () => {
    const { zipSync } = await import('fflate');
    const fs = new MemoryFileSystem();
    fs.seed('m.pxf', zipSync({ 'other.txt': enc('x') }));
    expect(((await rejects(unpack(fs, 'm.pxf', 'd'))) as IoError).code).toBe('BAD_PXF');
  });
});

describe('@pixel-forge/io/node adapter', () => {
  it('works on a real folder: atomic save, pack, unpack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pxf-node-'));
    try {
      const fs = nodeFileSystem();
      const bytes = writePxf(frozenStore(), opts());
      const file = join(dir, 'sub', 'hero.pxf');
      await saveAtomic(fs, file, bytes);
      expect(bytesEqual(new Uint8Array(readFileSync(file)), bytes)).toBe(true);
      expect((await fs.readdir(join(dir, 'sub'))).map((e) => e.name)).toEqual(['hero.pxf']);

      const folder = join(dir, 'hero.pxfd');
      await unpack(fs, file, folder);
      expect(await fs.exists(join(folder, '.gdignore'))).toBe(true);
      expect((await fs.readdir(folder)).map((e) => `${e.name}:${String(e.isDirectory)}`)).toEqual([
        '.gdignore:false',
        'document.json:false',
        'images:true',
        'manifest.json:false',
        'render:true',
      ]);
      const out = join(dir, 'again.pxf');
      await pack(fs, out, folder);
      expect(bytesEqual(await fs.readFile(out), bytes)).toBe(true);

      await fs.rename(out, join(dir, 'moved.pxf'));
      expect(await fs.exists(out)).toBe(false);
      await fs.remove(join(dir, 'moved.pxf'));
      await fs.remove(join(dir, 'moved.pxf'));
      await fs.remove(folder, { recursive: true });
      expect(await fs.exists(folder)).toBe(false);
      await expect(fs.readFile(join(dir, 'nope'))).rejects.toThrow();
      await expect(fs.exists(join(dir, 'hero.pxf', 'x'))).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
