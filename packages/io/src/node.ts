/**
 * `@pixel-forge/io/node`: a minimal Node implementation of the {@link FileSystem} and {@link Clock}
 * ports, for the CLI and for tests. It is a separate entry point so that the main entry point of
 * `io` stays free of Node built-ins (eslint and dependency-cruiser allow `node:` imports in this
 * file only). The full server-side implementation (workspace roots, lockfiles) is T5.4's.
 * @packageDocumentation
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Clock, DirEntry, FileSystem } from './fs.js';

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
}

/** The system clock: `new Date()`. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * A {@link FileSystem} on `node:fs/promises`. Paths are passed through unchanged (relative paths
 * resolve against the process working directory). `rename` replaces an existing destination, as
 * POSIX does and as Node does on Windows.
 */
export function nodeFileSystem(): FileSystem {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const b = await readFile(path);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await writeFile(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      await rename(from, to);
    },
    async remove(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
      await rm(path, { recursive: options.recursive === true, force: true });
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
    async mkdirp(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    async readdir(path: string): Promise<DirEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}
