/**
 * The server's {@link OpHost}: an in-process document host (`createMemoryHost`, by composition) plus
 * ownership. It adds three things to the memory host:
 *
 * - `resolvePath` also resolves symbolic links and checks the workspace roots on the physical path,
 *   so a link inside a root cannot lead out of it;
 * - `adopt`, `rebind` and `close` take, move and release the document's lockfile (see `lockfile.ts`);
 * - `fs` and `clock` default to the Node implementations of `@pixel-forge/io/node`.
 * @packageDocumentation
 */
import { nodeFileSystem, systemClock } from '@pixel-forge/io/node';
import { OpError, createMemoryHost, normalizePath } from '@pixel-forge/ops';
import type { AdoptInit, HostedDocument, OpHost } from '@pixel-forge/ops';
import { acquireLock, defaultBaseDir } from './lockfile.js';
import type { LockHandle } from './lockfile.js';
import { canonicalPath, isInside } from './roots.js';

/** Options of {@link createDocumentHost}. */
export interface DocumentHostOptions {
  /**
   * Base folder for lockfiles and discovery; default `~/.pixel-forge`. Inject a temporary folder in
   * tests so they never touch the real home directory.
   */
  readonly baseDir?: string;
  /**
   * Absolute workspace roots (see `resolveWorkspaceRoots`). When given, every path must be absolute
   * and, after symlink resolution, inside one of them. When omitted, any absolute path is accepted
   * (still normalised and symlink-resolved) and a relative one is only normalised, as in the memory
   * host.
   */
  readonly roots?: readonly string[];
  /** File system port; default `nodeFileSystem()` from `@pixel-forge/io/node`. */
  readonly fs?: OpHost['fs'];
  /** Clock port; default `systemClock`. */
  readonly clock?: OpHost['clock'];
  /** Rig renderer to share; default a fresh one (as in the memory host). */
  readonly renderer?: OpHost['renderer'];
  /** This machine's hostname for lockfiles; default `os.hostname()`. For tests. */
  readonly hostname?: string;
  /** Liveness probe for lock pids; default `kill(pid, 0)`. For tests. */
  readonly isAlive?: (pid: number) => boolean;
  /** Release held locks when the process exits normally; default `true`. */
  readonly releaseOnExit?: boolean;
}

/** An {@link OpHost} with ownership: what `pf mcp` (headless) and `pf serve` run the ops against. */
export interface DocumentHost extends OpHost {
  /** The base folder in use. */
  readonly baseDir: string;
  /** The workspace roots after symlink resolution, or `undefined` when unrestricted. */
  readonly roots: readonly string[] | undefined;
  /** Closes every open document and releases every lock. */
  dispose(): Promise<void>;
}

/**
 * Creates a {@link DocumentHost}.
 *
 * `resolvePath` returns the **canonical** path (`..` folded, every symlink followed), which is what
 * the lockfile hash and `byPath` are keyed on, so two names of one file are the same document. A
 * document must be adopted and rebound with a path obtained from `resolvePath`.
 *
 * Adopt, rebind and close run one at a time, in call order, so concurrent calls see a consistent
 * lock table. A symlink changed between `resolvePath` and the file access is not detected.
 * @throws RangeError when a root is not absolute.
 */
export function createDocumentHost(options: DocumentHostOptions = {}): DocumentHost {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const inner = createMemoryHost({
    fs: options.fs ?? nodeFileSystem(),
    clock: options.clock ?? systemClock,
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
  });
  const roots = options.roots?.map((r) => {
    if (!r.startsWith('/')) throw new RangeError(`workspace root must be absolute: ${r}`);
    return canonicalPath(normalizePath(r));
  });
  const locks = new Map<string, LockHandle>();
  const lock = (path: string): Promise<LockHandle> =>
    acquireLock({
      baseDir,
      path,
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.releaseOnExit === undefined ? {} : { releaseOnExit: options.releaseOnExit }),
    });

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const result = tail.then(f);
    tail = result.catch(() => undefined);
    return result;
  };

  const releaseLock = async (path: string | undefined): Promise<void> => {
    if (path === undefined) return;
    const handle = locks.get(path);
    locks.delete(path);
    await handle?.release();
  };

  return {
    ...inner,
    baseDir,
    roots,
    resolvePath(path) {
      if (path === '') throw new OpError('BAD_INPUT', 'empty path', { path });
      const norm = normalizePath(path);
      if (!norm.startsWith('/')) {
        if (roots === undefined) return norm;
        throw new OpError('BAD_INPUT', `path must be absolute: ${path}`, { path, roots });
      }
      let real: string;
      try {
        real = canonicalPath(norm);
      } catch (e) {
        throw new OpError(
          'IO_FAILED',
          `cannot resolve ${norm}: ${e instanceof Error ? e.message : String(e)}`,
          { path: norm },
          { cause: e },
        );
      }
      if (roots !== undefined && !roots.some((r) => isInside(real, r))) {
        throw new OpError(
          'NOT_ALLOWED',
          `path is outside the workspace roots: ${norm}${real === norm ? '' : ` (resolves to ${real})`}`,
          { path: norm, resolved: real, roots },
        );
      }
      return real;
    },
    adopt: (init: AdoptInit) =>
      serial(async () => {
        const path = init.path;
        // No path: nothing to lock. A clash with an open document: the memory host refuses (CONFLICT)
        // and our own lock must not be taken (it would read as another process's).
        if (
          path === undefined ||
          inner.get(init.store.doc.meta.id) !== undefined ||
          inner.byPath(path) !== undefined
        ) {
          return inner.adopt(init);
        }
        const handle = await lock(path);
        try {
          const hosted = await inner.adopt(init);
          locks.set(path, handle);
          return hosted;
        } catch (e) {
          await handle.release();
          throw e;
        }
      }),
    adoptFile: (path, read) =>
      serial(async () => {
        const samePath = inner.byPath(path);
        if (samePath !== undefined) {
          throw new OpError('CONFLICT', `${path} is already open as ${samePath.id}`, {
            doc: samePath.id,
            path,
          });
        }
        // Lock first, read second: with the lock held no other process can save in between, so
        // the bytes read are the ones the next save replaces.
        const handle = await lock(path);
        try {
          const loaded = await read();
          const hosted = await inner.adopt({ store: loaded.store, path, file: loaded.file });
          locks.set(path, handle);
          return hosted;
        } catch (e) {
          await handle.release();
          throw e;
        }
      }),
    rebind: (id, path) =>
      serial(async () => {
        const hosted: HostedDocument | undefined = inner.get(id);
        const other = inner.byPath(path);
        if (
          hosted === undefined ||
          hosted.path === path ||
          (other !== undefined && other !== hosted)
        ) {
          return inner.rebind(id, path); // NOT_FOUND, no-op or CONFLICT, decided by the memory host
        }
        const oldPath = hosted.path;
        const handle = await lock(path); // DOC_LOCKED leaves the document untouched
        try {
          const rebound = await inner.rebind(id, path);
          locks.set(path, handle);
          await releaseLock(oldPath);
          return rebound;
        } catch (e) {
          await handle.release();
          throw e;
        }
      }),
    close: (id) =>
      serial(async () => {
        const path = inner.get(id)?.path;
        const closed = await inner.close(id);
        await releaseLock(path);
        return closed;
      }),
    dispose: () =>
      serial(async () => {
        for (const doc of inner.list()) {
          const path = doc.path;
          await inner.close(doc.id);
          await releaseLock(path);
        }
      }),
  };
}
