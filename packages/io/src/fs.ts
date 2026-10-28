/**
 * The `FileSystem` and `Clock` ports (spec 6.8) plus an in-memory fake for tests.
 *
 * `io` never touches the disk itself: `saveAtomic`, `pack` and `unpack` take a {@link FileSystem}.
 * The production Node implementation belongs to `server` (T5.4); a minimal adapter for the CLI and
 * for tests lives in the separate entry point `@pixel-forge/io/node`, so this pure entry point never
 * imports a Node built-in. Paths are POSIX style (`/` separators); an adapter maps them if needed.
 * @packageDocumentation
 */

/** One entry of a directory listing. */
export interface DirEntry {
  /** File or folder name, without the parent path. */
  readonly name: string;
  /** True for a folder. Anything else (files, links) reads as a file. */
  readonly isDirectory: boolean;
}

/**
 * The file operations `io` needs. All paths are POSIX style. Every method rejects with an `Error`
 * on failure; callers (`saveAtomic`) wrap failures in `IoError('FS_FAILED')`.
 */
export interface FileSystem {
  /** Whole file contents. Rejects when the file does not exist. */
  readFile(path: string): Promise<Uint8Array>;
  /** Creates or replaces the file. The parent folder must exist. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Moves a file, replacing `to` if it exists (POSIX `rename` semantics). */
  rename(from: string, to: string): Promise<void>;
  /** Deletes a file, or a folder with `recursive`. Succeeds when `path` does not exist. */
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  /** True when a file or folder exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Creates the folder and its missing parents. Succeeds when it already exists. */
  mkdirp(path: string): Promise<void>;
  /** The entries of a folder, sorted by name (code-unit order). Rejects when it does not exist. */
  readdir(path: string): Promise<DirEntry[]>;
}

/**
 * The clock port: the only source of time for `.pxf` timestamps (no `Date.now` in pure code).
 * The Node implementation (`systemClock`) is in `@pixel-forge/io/node`.
 */
export interface Clock {
  /** The current instant. */
  now(): Date;
}

/** A clock that always returns the same instant (an ISO 8601 string). For tests and scripts. */
export function fixedClock(iso: string): Clock {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new RangeError(`fixedClock: not a date: ${iso}`);
  return { now: () => new Date(t) };
}

/** A clock that advances by `stepMs` after every reading, starting at `startIso`. For tests. */
export function steppedClock(startIso: string, stepMs = 1000): Clock {
  let t = new Date(startIso).getTime();
  if (Number.isNaN(t)) throw new RangeError(`steppedClock: not a date: ${startIso}`);
  return {
    now: () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
  };
}

/** `a/b` with duplicate and trailing slashes collapsed (a leading `/` of `a` is kept). */
export function joinPath(...parts: readonly string[]): string {
  const lead = parts[0]?.startsWith('/') === true ? '/' : '';
  const segs = parts.flatMap((p) => p.split('/')).filter((s) => s !== '' && s !== '.');
  return lead + segs.join('/');
}

/** The parent folder of `path` (`''` for a bare name, `'/'` for a root child). */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : path.slice(0, i);
}

/** Operations a {@link MemoryFileSystem} reports to its `onOp` hook. */
export type MemoryFsOp =
  'readFile' | 'writeFile' | 'rename' | 'remove' | 'exists' | 'mkdirp' | 'readdir';

/** Options of {@link MemoryFileSystem}. */
export interface MemoryFileSystemOptions {
  /**
   * Called before every operation with its name and path (the destination for `rename`). It may
   * throw to simulate a failure; the operation then does not happen.
   */
  readonly onOp?: (op: MemoryFsOp, path: string) => void;
}

function fsError(code: string, op: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${op} '${path}'`), { code });
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw fsError('EINVAL', 'normalize (.. is not supported)', path);
    out.push(seg);
  }
  return out.join('/');
}

/**
 * An in-memory {@link FileSystem} for tests: a map of files and a set of folders, with POSIX
 * semantics (writing needs an existing parent, `rename` replaces, `remove` is idempotent). Paths are
 * normalised (`a//b/./c` is `a/b/c`; a leading `/` is ignored). Stored bytes are copied on the way in
 * and out. Use `onOp` to inject failures, and subclass to simulate torn writes.
 */
export class MemoryFileSystem implements FileSystem {
  readonly #files = new Map<string, Uint8Array>();
  readonly #dirs = new Set<string>(['']);
  readonly #onOp: ((op: MemoryFsOp, path: string) => void) | undefined;

  constructor(options: MemoryFileSystemOptions = {}) {
    this.#onOp = options.onOp;
  }

  /** Every file path, sorted. For assertions ("no temp file left"). */
  files(): string[] {
    return [...this.#files.keys()].sort();
  }

  /** Every folder path (without the root), sorted. */
  directories(): string[] {
    return [...this.#dirs].filter((d) => d !== '').sort();
  }

  /** A copy of the file contents, or `undefined`. Does not call `onOp`. */
  peek(path: string): Uint8Array | undefined {
    const f = this.#files.get(normalize(path));
    return f === undefined ? undefined : f.slice();
  }

  /** Puts a file in place, creating its folders, without calling `onOp`. For test setup. */
  seed(path: string, data: Uint8Array): void {
    const p = normalize(path);
    this.#mkdirs(dirnameOf(p));
    this.#files.set(p, data.slice());
  }

  #mkdirs(dir: string): void {
    let acc = '';
    for (const seg of dir.split('/')) {
      if (seg === '') continue;
      acc = acc === '' ? seg : `${acc}/${seg}`;
      this.#dirs.add(acc);
    }
  }

  #hook(op: MemoryFsOp, path: string): void {
    this.#onOp?.(op, path);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.#run(() => {
      this.#hook('readFile', path);
      const f = this.#files.get(normalize(path));
      if (f === undefined) throw fsError('ENOENT', 'readFile', path);
      return f.slice();
    });
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.#run(() => {
      this.#hook('writeFile', path);
      const p = normalize(path);
      if (this.#dirs.has(p)) throw fsError('EISDIR', 'writeFile', path);
      if (!this.#dirs.has(dirnameOf(p) === '/' ? '' : dirnameOf(p))) {
        throw fsError('ENOENT', 'writeFile (no parent folder)', path);
      }
      this.#files.set(p, data.slice());
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.#run(() => {
      this.#hook('rename', to);
      const a = normalize(from);
      const b = normalize(to);
      const f = this.#files.get(a);
      if (f === undefined) throw fsError('ENOENT', 'rename', from);
      if (this.#dirs.has(b)) throw fsError('EISDIR', 'rename', to);
      if (!this.#dirs.has(dirnameOf(b) === '/' ? '' : dirnameOf(b))) {
        throw fsError('ENOENT', 'rename (no parent folder)', to);
      }
      this.#files.delete(a);
      this.#files.set(b, f);
    });
  }

  remove(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    return this.#run(() => {
      this.#hook('remove', path);
      const p = normalize(path);
      if (this.#files.delete(p)) return;
      if (!this.#dirs.has(p) || p === '') return;
      const prefix = `${p}/`;
      const inside =
        [...this.#files.keys()].some((k) => k.startsWith(prefix)) ||
        [...this.#dirs].some((d) => d.startsWith(prefix));
      if (inside && options.recursive !== true) throw fsError('ENOTEMPTY', 'remove', path);
      for (const k of [...this.#files.keys()]) if (k.startsWith(prefix)) this.#files.delete(k);
      for (const d of [...this.#dirs]) if (d === p || d.startsWith(prefix)) this.#dirs.delete(d);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.#run(() => {
      this.#hook('exists', path);
      const p = normalize(path);
      return this.#files.has(p) || this.#dirs.has(p);
    });
  }

  mkdirp(path: string): Promise<void> {
    return this.#run(() => {
      this.#hook('mkdirp', path);
      const p = normalize(path);
      if (this.#files.has(p)) throw fsError('EEXIST', 'mkdirp (is a file)', path);
      this.#mkdirs(p);
    });
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.#run(() => {
      this.#hook('readdir', path);
      const p = normalize(path);
      if (!this.#dirs.has(p)) throw fsError('ENOENT', 'readdir', path);
      const prefix = p === '' ? '' : `${p}/`;
      const out = new Map<string, boolean>();
      for (const k of this.#files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) out.set(rest, false);
      }
      for (const d of this.#dirs) {
        if (d === '' || !d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) out.set(rest, true);
      }
      return [...out.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, isDirectory]) => ({ name, isDirectory }));
    });
  }

  /** Runs `f` and returns its result as a promise (a throw becomes a rejection). */
  #run<T>(f: () => T): Promise<T> {
    try {
      return Promise.resolve(f());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
