// DocumentHost: ownership through adopt/rebind/close, workspace roots and symlinks. The hero
// fixture is opened through the ops (`doc.open`), as every transport does.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { nodeFileSystem } from '@pixel-forge/io/node';
import type { FileSystem } from '@pixel-forge/io';
import { registry } from '@pixel-forge/ops';
import type { HostedDocument } from '@pixel-forge/ops';
import { describe, expect, it } from 'vitest';
import { createDocumentHost, lockFilePath, resolveWorkspaceRoots } from '../src/index.js';
import type { DocumentHost } from '../src/index.js';
import { later, tempDir, workspace } from './helpers.js';

function hostFor(
  w: { base: string; root: string },
  extra: { hostname?: string } = {},
): DocumentHost {
  const host = createDocumentHost({
    baseDir: w.base,
    roots: [w.root],
    releaseOnExit: false,
    ...extra,
  });
  later(() => host.dispose());
  return host;
}

const locks = (base: string): string[] =>
  existsSync(join(base, 'locks')) ? readdirSync(join(base, 'locks')).sort() : [];

async function openHero(host: DocumentHost, path: string): Promise<HostedDocument> {
  await registry.execute('doc.open', { path }, { host });
  const doc = host.byPath(host.resolvePath(path));
  if (doc === undefined) throw new Error('not open');
  return doc;
}

async function rejection(
  p: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; details: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

describe('DocumentHost ownership', () => {
  it('locks on adopt with a path, in the base folder and nowhere else', async () => {
    const w = workspace();
    const host = hostFor(w);
    const doc = await openHero(host, w.hero);
    expect(locks(w.base)).toEqual([lockFilePath(w.base, w.hero).split('/').pop()]);
    expect(readdirSync(w.root)).toEqual(['hero.pxf']); // nothing next to the document
    expect(await host.close(doc.id)).toBe(true);
    expect(locks(w.base)).toEqual([]);
    expect(await host.close(doc.id)).toBe(false);
  });

  it('refuses a second host on the same base folder with DOC_LOCKED and this pid', async () => {
    const w = workspace();
    await openHero(hostFor(w), w.hero);
    const other = hostFor(w);
    const err = await rejection(registry.execute('doc.open', { path: w.hero }, { host: other }));
    expect(err).toMatchObject({
      code: 'DOC_LOCKED',
      details: { pid: process.pid, host: hostname() },
    });
    expect(other.list()).toEqual([]);
  });

  it('takes the lock before it reads the file, and gives it back when the read or parse fails', async () => {
    const w = workspace();
    const real = nodeFileSystem();
    const heldAtRead: boolean[] = [];
    const fs: FileSystem = {
      ...real,
      readFile: (path) => {
        heldAtRead.push(existsSync(lockFilePath(w.base, path)));
        return real.readFile(path);
      },
    };
    const host = createDocumentHost({ baseDir: w.base, roots: [w.root], releaseOnExit: false, fs });
    later(() => host.dispose());
    await registry.execute('doc.open', { path: w.hero }, { host });
    expect(heldAtRead).toEqual([true]); // another process cannot save in between

    // Not a .pxf: the open fails and leaves no lock behind.
    const junk = join(w.root, 'junk.pxf');
    writeFileSync(junk, 'not a zip');
    expect((await rejection(registry.execute('doc.open', { path: junk }, { host }))).code).toBe(
      'BAD_FILE',
    );
    expect(locks(w.base)).toEqual([lockFilePath(w.base, w.hero).split('/').pop()]);
    // A file that cannot be read at all: the same.
    const missing = join(w.root, 'missing.pxf');
    expect((await rejection(registry.execute('doc.open', { path: missing }, { host }))).code).toBe(
      'IO_FAILED',
    );
    expect(locks(w.base)).toHaveLength(1);
    expect(host.list()).toHaveLength(1);
    // The lock of the failed open really is free: another host can take it.
    const source = host.byPath(w.hero);
    if (source === undefined) throw new Error('hero not open');
    const other = hostFor(w);
    expect((await other.adopt({ store: source.store, path: junk })).path).toBe(junk);
  });

  it('reports a clash inside one host as CONFLICT and keeps the lock', async () => {
    const w = workspace();
    const host = hostFor(w);
    const doc = await openHero(host, w.hero);
    const err = await rejection(host.adopt({ store: doc.store, path: w.hero }));
    expect(err.code).toBe('CONFLICT');
    expect(locks(w.base)).toHaveLength(1);
    expect(host.list()).toHaveLength(1);
  });

  it('holds no lock for an unsaved document, takes one on rebind, and moves it on save-as', async () => {
    const w = workspace();
    const source = await openHero(hostFor(w), w.hero);
    const w2 = workspace();
    const host = hostFor({ base: w2.base, root: w.root }); // separate base: the hero stays locked in w.base
    const doc = await host.adopt({ store: source.store });
    expect(doc.path).toBeUndefined();
    expect(locks(w2.base)).toEqual([]);

    const a = join(w.root, 'a.pxf');
    const b = join(w.root, 'b.pxf');
    await host.rebind(doc.id, a);
    expect(host.byPath(a)).toBe(doc);
    expect(locks(w2.base)).toEqual([lockFilePath(w2.base, a).split('/').pop()]);
    await host.rebind(doc.id, a); // same path: nothing changes
    await host.rebind(doc.id, b);
    expect(doc.path).toBe(b);
    expect(locks(w2.base)).toEqual([lockFilePath(w2.base, b).split('/').pop()]);
    await host.dispose();
    expect(locks(w2.base)).toEqual([]);
  });

  it('leaves the document and its old lock untouched when the new path is locked', async () => {
    const w = workspace();
    const first = hostFor(w);
    const doc = await openHero(first, w.hero);
    const taken = join(w.root, 'taken.pxf');
    const other = hostFor(w);
    const source = await other.adopt({ store: doc.store, path: taken });
    expect(source.path).toBe(taken);

    const err = await rejection(first.rebind(doc.id, taken));
    expect(err).toMatchObject({ code: 'DOC_LOCKED', details: { pid: process.pid } });
    expect(doc.path).toBe(w.hero);
    expect(first.byPath(w.hero)).toBe(doc);
    expect(locks(w.base).sort()).toEqual(
      [lockFilePath(w.base, w.hero), lockFilePath(w.base, taken)]
        .map((f) => f.split('/').pop())
        .sort(),
    );
    // the old lock is still the first host's: a third host cannot take it
    expect((await rejection(hostFor(w).adopt({ store: doc.store, path: w.hero }))).code).toBe(
      'DOC_LOCKED',
    );
  });

  it('refuses to rebind an unknown document, like the memory host', async () => {
    const w = workspace();
    const host = hostFor(w);
    await openHero(host, w.hero);
    const unknown = 'doc_nope000' as HostedDocument['id'];
    expect((await rejection(host.rebind(unknown, w.hero))).code).toBe('NOT_FOUND');
    expect(locks(w.base)).toHaveLength(1);
  });

  it('serialises concurrent rebinds to one path: one lock, the second is a no-op', async () => {
    const w = workspace();
    const host = hostFor(w);
    const doc = await openHero(host, w.hero);
    const copy = join(w.root, 'copy.pxf');
    const results = await Promise.allSettled([
      host.rebind(doc.id, copy),
      host.rebind(doc.id, copy),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']); // second is a no-op
    expect(locks(w.base)).toHaveLength(1);
  });
});

describe('DocumentHost workspace roots', () => {
  it('accepts paths inside a root and returns them canonical', () => {
    const w = workspace();
    const host = hostFor(w);
    expect(host.resolvePath(join(w.root, 'sub', '..', 'x.pxf'))).toBe(join(w.root, 'x.pxf'));
    expect(host.resolvePath(w.root)).toBe(w.root);
  });

  it('rejects a path outside the roots, including by .. and by a sibling prefix', () => {
    const w = workspace();
    const host = hostFor(w);
    for (const bad of [
      join(w.root, '..', 'secret.pxf'),
      `${w.root}-evil/x.pxf`,
      '/etc/passwd',
      '/',
    ]) {
      expect(() => host.resolvePath(bad), bad).toThrow(
        expect.objectContaining({ code: 'NOT_ALLOWED' }),
      );
    }
    expect(() => host.resolvePath('rel.pxf')).toThrow(
      expect.objectContaining({ code: 'BAD_INPUT' }),
    );
    expect(() => host.resolvePath('')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });

  it('rejects a symlink inside a root that leads out, and accepts one that stays inside', () => {
    const w = workspace();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.pxf'), 'x');
    symlinkSync(outside, join(w.root, 'out-dir')); // folder link
    symlinkSync(join(outside, 'secret.pxf'), join(w.root, 'out-file.pxf')); // file link
    symlinkSync(join(outside, 'not-yet.pxf'), join(w.root, 'dangling.pxf')); // target does not exist
    symlinkSync('out-dir', join(w.root, 'chain')); // link to a link
    mkdirSync(join(w.root, 'real'));
    symlinkSync('real', join(w.root, 'inside-dir'));
    symlinkSync('..', join(w.root, 'real', 'up'));
    symlinkSync('../..', join(w.root, 'real', 'esc'));
    const host = hostFor(w);

    for (const bad of [
      'out-dir/secret.pxf',
      'out-dir/new.pxf',
      'out-file.pxf',
      'dangling.pxf',
      'chain/secret.pxf',
      'real/esc/x.pxf', // a link whose target climbs out of the root with ..
    ]) {
      expect(() => host.resolvePath(join(w.root, bad)), bad).toThrow(
        expect.objectContaining({ code: 'NOT_ALLOWED' }),
      );
    }
    expect(host.resolvePath(join(w.root, 'inside-dir', 'x.pxf'))).toBe(
      join(w.root, 'real', 'x.pxf'),
    );
    expect(host.resolvePath(join(w.root, 'real', 'up', 'hero.pxf'))).toBe(w.hero);
  });

  it('works when the root itself is reached through a symlink, and names both forms of a file once', async () => {
    const w = workspace();
    const alias = join(tempDir(), 'alias');
    symlinkSync(w.root, alias);
    const host = createDocumentHost({ baseDir: w.base, roots: [alias], releaseOnExit: false });
    later(() => host.dispose());
    expect(host.roots).toEqual([w.root]);
    expect(host.resolvePath(join(alias, 'hero.pxf'))).toBe(w.hero);
    expect(host.resolvePath(w.hero)).toBe(w.hero);
    await registry.execute('doc.open', { path: join(alias, 'hero.pxf') }, { host });
    const again = await registry.execute('doc.open', { path: w.hero }, { host });
    expect(again).toMatchObject({ alreadyOpen: true });
  });

  // The temp volume decides: macOS volumes are usually case-insensitive, Linux CI is not.
  const caseInsensitive = ((): boolean => {
    const dir = tempDir();
    writeFileSync(join(dir, 'Probe'), 'x');
    return existsSync(join(dir, 'pROBE'));
  })();

  it.skipIf(!caseInsensitive)(
    'names one file once however its letter case is typed (true case of the existing part)',
    async () => {
      const w = workspace();
      const host = hostFor(w);
      const typed = join(w.root.replace(/work$/, 'WORK'), 'HERO.pxf');
      expect(typed).not.toBe(w.hero);
      expect(host.resolvePath(typed)).toBe(w.hero);
      // A file about to be created keeps the case it is given; the folder part takes the true case.
      expect(host.resolvePath(join(w.root.replace(/work$/, 'Work'), 'New.pxf'))).toBe(
        join(w.root, 'New.pxf'),
      );
      // One document and one lock for both spellings.
      await registry.execute('doc.open', { path: typed }, { host });
      const again = await registry.execute('doc.open', { path: w.hero }, { host });
      expect(again).toMatchObject({ alreadyOpen: true });
      expect(locks(w.base)).toHaveLength(1);
      expect(lockFilePath(w.base, host.resolvePath(typed))).toBe(lockFilePath(w.base, w.hero));
      // A second host (another process) sees the lock whichever spelling it uses.
      const other = hostFor(w);
      const clash = await rejection(registry.execute('doc.open', { path: typed }, { host: other }));
      expect(clash.code).toBe('DOC_LOCKED');
    },
  );

  it.skipIf(!caseInsensitive)('accepts a root typed in another letter case', () => {
    const w = workspace();
    const host = createDocumentHost({
      baseDir: w.base,
      roots: [w.root.replace(/work$/, 'WORK')],
      releaseOnExit: false,
    });
    later(() => host.dispose());
    expect(host.roots).toEqual([w.root]);
    expect(host.resolvePath(w.hero)).toBe(w.hero);
    expect(host.resolvePath(join(w.root.replace(/work$/, 'WORK'), 'hero.pxf'))).toBe(w.hero);
  });

  it('rejects relative roots and detects symlink loops', () => {
    expect(() => createDocumentHost({ roots: ['rel'] })).toThrow(RangeError);
    const w = workspace();
    symlinkSync(join(w.root, 'loop-b'), join(w.root, 'loop-a'));
    symlinkSync(join(w.root, 'loop-a'), join(w.root, 'loop-b'));
    expect(() => hostFor(w).resolvePath(join(w.root, 'loop-a', 'x.pxf'))).toThrow(
      expect.objectContaining({ code: 'IO_FAILED' }),
    );
  });

  it('without roots accepts any absolute path and only normalises a relative one', () => {
    const host = createDocumentHost({ baseDir: tempDir(), releaseOnExit: false });
    expect(host.roots).toBeUndefined();
    expect(host.resolvePath('/etc/./hosts')).toMatch(/\/etc\/hosts$/);
    expect(host.resolvePath('a/../b.pxf')).toBe('b.pxf');
  });

  it('gets its default fs and clock from io/node: it reads and writes real files', async () => {
    const w = workspace();
    const host = hostFor(w);
    const target = join(w.root, 'copy.pxf');
    copyFileSync(w.hero, target);
    expect((await host.fs.readFile(target)).byteLength).toBeGreaterThan(0);
    expect(host.clock.now()).toBeInstanceOf(Date);
  });
});

describe('resolveWorkspaceRoots', () => {
  it('prefers explicit roots, then the environment, then the working directory', () => {
    const cwd = '/proj/app';
    expect(resolveWorkspaceRoots({ cwd, env: {} })).toEqual([cwd]);
    expect(resolveWorkspaceRoots({ cwd, env: { PF_WORKSPACE_ROOTS: '/a:/b/../c' } })).toEqual([
      '/a',
      '/c',
    ]);
    expect(
      resolveWorkspaceRoots({
        cwd,
        roots: ['sub', '/x/', 'sub'],
        env: { PF_WORKSPACE_ROOTS: '/a' },
      }),
    ).toEqual(['/proj/app/sub', '/x']);
    expect(resolveWorkspaceRoots({ cwd, roots: [], env: {} })).toEqual([cwd]);
    expect(resolveWorkspaceRoots().length).toBeGreaterThan(0);
  });
});
