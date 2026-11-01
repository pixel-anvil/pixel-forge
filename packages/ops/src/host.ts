/**
 * The document host the ops run against (spec 6.5, 6.8): the open documents, the ports
 * (`FileSystem`, `Clock`), the workspace roots and **one rig renderer per host** (KNOWN_ISSUES
 * CORE-03: `renderFrame` has no default renderer, so the host owns one and every op shares its
 * `(variant, angle)` cache).
 *
 * `OpHost` is the contract; `createMemoryHost` is the in-process implementation without lockfiles
 * (tests, the `pf check` harness). The server's `DocumentHost` (T5.4) implements the same interface
 * and adds lockfiles (`DOC_LOCKED` from {@link OpHost.adopt}) and discovery.
 * @packageDocumentation
 */
import { createRigRenderer } from '@pixel-forge/core';
import type { DocumentStore, RigRenderer } from '@pixel-forge/core';
import type { Clock, FileSystem, PxfFile } from '@pixel-forge/io';
import type { DocId } from '@pixel-forge/schema';
import { OpError } from './errors.js';

/** One open document of a host. */
export interface HostedDocument {
  /** The document's own id (`meta.id`); ops address the document by it (`doc` input field). */
  readonly id: DocId;
  /** The live store; ops mutate it only through the transaction the registry opens. */
  readonly store: DocumentStore;
  /** Normalised path of the backing `.pxf`, or `undefined` for an unsaved document. */
  path: string | undefined;
  /** The file as last read or written, passed as `previous` to `buildPxf` for incremental saves. */
  file: PxfFile | undefined;
  /** `store.version` when the document was last read or saved, `undefined` if never saved. */
  savedVersion: number | undefined;
}

/** What {@link OpHost.adopt} registers. */
export interface AdoptInit {
  readonly store: DocumentStore;
  /** Normalised path (from {@link OpHost.resolvePath}); omit for a new, unsaved document. */
  readonly path?: string;
  /** The file the store was read from. */
  readonly file?: PxfFile;
}

/**
 * The host interface the registry and op handlers see. Handlers do no direct I/O (spec 6.3): file
 * access goes through `fs`, time through `clock`, rendering through `renderer`.
 */
export interface OpHost {
  /** File system port (POSIX paths). */
  readonly fs: FileSystem;
  /** Clock port (`.pxf` timestamps). */
  readonly clock: Clock;
  /** The host's single rig renderer: pass it to every `renderFrame` (CORE-03). */
  readonly renderer: RigRenderer;
  /**
   * Normalises `path` (POSIX, `.` and `..` folded) and checks it against the workspace roots.
   * @throws OpError `NOT_ALLOWED` outside every root; `BAD_INPUT` for an empty or relative path
   *   when roots are configured.
   */
  resolvePath(path: string): string;
  /** The open document with this id. */
  get(id: DocId): HostedDocument | undefined;
  /** The open document backed by this normalised path. */
  byPath(path: string): HostedDocument | undefined;
  /** Every open document, in opening order. */
  list(): readonly HostedDocument[];
  /**
   * Registers a document. The server host acquires the lockfile here (`DOC_LOCKED`).
   * @throws OpError `CONFLICT` when a document with the same id or path is already open.
   */
  adopt(init: AdoptInit): Promise<HostedDocument>;
  /**
   * Moves an open document to a new normalised path (first save, save-as). The server host locks
   * `path` first (`DOC_LOCKED`) and only then releases the old path's lock. Rebinding to the
   * document's current path changes nothing. `file` and `savedVersion` stay as they are; the save
   * updates them.
   * @throws OpError `NOT_FOUND` when `id` is not open; `CONFLICT` when another open document has
   *   this path.
   */
  rebind(id: DocId, path: string): Promise<HostedDocument>;
  /** Forgets a document (and releases its lock); `false` if it was not open. */
  close(id: DocId): Promise<boolean>;
}

/** Options of {@link createMemoryHost}. */
export interface MemoryHostOptions {
  /** File system port; tests use io's `MemoryFileSystem`. */
  readonly fs: FileSystem;
  /** Clock port; tests use io's `fixedClock`. */
  readonly clock: Clock;
  /**
   * Absolute workspace roots. When given, every path must be absolute and inside one of them;
   * when omitted, any path is accepted (still normalised).
   */
  readonly roots?: readonly string[];
  /** Renderer to share; default a fresh `createRigRenderer()`. */
  readonly renderer?: RigRenderer;
}

/**
 * Folds `.` and `..` segments and duplicate slashes of a POSIX path. A `..` above the root of an
 * absolute path is dropped (as POSIX does); in a relative path it is kept.
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = out[out.length - 1];
      if (last !== undefined && last !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const body = out.join('/');
  return absolute ? `/${body}` : body === '' ? '.' : body;
}

const under = (path: string, root: string): boolean =>
  root === '/' || path === root || path.startsWith(`${root}/`);

/**
 * An in-process {@link OpHost} without lockfiles: documents live in memory, files go through the
 * given `FileSystem`. Used by tests and the harness; the server host (T5.4) adds ownership.
 */
export function createMemoryHost(options: MemoryHostOptions): OpHost {
  const roots = options.roots?.map((r) => {
    if (!r.startsWith('/')) throw new RangeError(`workspace root must be absolute: ${r}`);
    return normalizePath(r);
  });
  const docs = new Map<DocId, HostedDocument>();
  const renderer = options.renderer ?? createRigRenderer();
  const byPath = (path: string): HostedDocument | undefined =>
    [...docs.values()].find((d) => d.path === path);
  return {
    fs: options.fs,
    clock: options.clock,
    renderer,
    resolvePath(path) {
      if (path === '') throw new OpError('BAD_INPUT', 'empty path', { path });
      const norm = normalizePath(path);
      if (roots === undefined) return norm;
      if (!norm.startsWith('/')) {
        throw new OpError('BAD_INPUT', `path must be absolute: ${path}`, { path, roots });
      }
      if (!roots.some((r) => under(norm, r))) {
        throw new OpError('NOT_ALLOWED', `path is outside the workspace roots: ${norm}`, {
          path: norm,
          roots,
        });
      }
      return norm;
    },
    get: (id) => docs.get(id),
    byPath,
    list: () => [...docs.values()],
    adopt(init) {
      const id = init.store.doc.meta.id;
      const clash = docs.get(id);
      if (clash !== undefined) {
        return Promise.reject(
          new OpError('CONFLICT', `a document with id ${id} is already open`, {
            doc: id,
            path: init.path ?? null,
            openPath: clash.path ?? null,
          }),
        );
      }
      const samePath = init.path === undefined ? undefined : byPath(init.path);
      if (samePath !== undefined) {
        return Promise.reject(
          new OpError('CONFLICT', `${String(init.path)} is already open as ${samePath.id}`, {
            doc: samePath.id,
            path: init.path ?? null,
          }),
        );
      }
      const hosted: HostedDocument = {
        id,
        store: init.store,
        path: init.path,
        file: init.file,
        savedVersion: init.file === undefined ? undefined : init.store.version,
      };
      docs.set(id, hosted);
      return Promise.resolve(hosted);
    },
    rebind(id, path) {
      const hosted = docs.get(id);
      if (hosted === undefined) {
        return Promise.reject(
          new OpError('NOT_FOUND', `no open document ${id}`, { kind: 'doc', doc: id }),
        );
      }
      const samePath = byPath(path);
      if (samePath !== undefined && samePath !== hosted) {
        return Promise.reject(
          new OpError('CONFLICT', `${path} is already open as ${samePath.id}`, {
            doc: samePath.id,
            path,
          }),
        );
      }
      hosted.path = path;
      return Promise.resolve(hosted);
    },
    close: (id) => Promise.resolve(docs.delete(id)),
  };
}
