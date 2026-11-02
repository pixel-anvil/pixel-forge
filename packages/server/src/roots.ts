/**
 * Workspace roots (NFR-06: MCP file I/O is restricted to configured workspace roots) and symlink
 * resolution, so that a link inside a root cannot lead out of it.
 *
 * Paths are POSIX style (as in the `FileSystem` port); Windows is not supported yet.
 * @packageDocumentation
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { normalizePath } from '@pixel-forge/ops';

/** Environment variable with extra workspace roots, separated like `PATH`. */
export const WORKSPACE_ROOTS_ENV = 'PF_WORKSPACE_ROOTS';

const MAX_LINKS = 40;

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

const isMissing = (e: unknown): boolean => {
  const code = errCode(e);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * Gives the existing part of a link-free path the letter case the file system stores. On a
 * case-insensitive volume (the macOS default) `/p/Hero.pxf` and `/p/hero.pxf` are one file, so the
 * lock identity, `byPath` and the roots check must see one spelling. Only `realpathSync.native`
 * returns the true name (plain `realpathSync` keeps the caller's case). The longest existing prefix
 * is looked up; the components after it do not exist yet and stay as given.
 */
function withTrueCase(parts: readonly string[]): string[] {
  for (let n = parts.length; n > 0; n--) {
    let real: string;
    try {
      real = realpathSync.native(`/${parts.slice(0, n).join('/')}`);
    } catch (e) {
      if (isMissing(e)) continue;
      throw e;
    }
    return [...real.split('/').filter((s) => s !== ''), ...parts.slice(n)];
  }
  return [...parts];
}

/**
 * The physical form of an absolute path: every symbolic link along it is followed (including links
 * whose target does not exist yet and links after `..`), so the result contains no link, and the
 * existing part has the letter case the file system stores (see {@link withTrueCase}). Components
 * that do not exist are kept as they are (a file about to be created). Synchronous, so it fits
 * `OpHost.resolvePath`.
 * @throws Error `ELOOP` after 40 links; any other file system error except "does not exist".
 */
export function canonicalPath(path: string): string {
  if (!path.startsWith('/')) throw new RangeError(`canonicalPath needs an absolute path: ${path}`);
  let pending = path.split('/').filter((s) => s !== '' && s !== '.');
  let resolved: string[] = [];
  let links = 0;
  while (pending.length > 0) {
    const seg = pending[0] ?? '';
    pending = pending.slice(1);
    if (seg === '..') {
      resolved = resolved.slice(0, -1);
      continue;
    }
    const candidate = `/${[...resolved, seg].join('/')}`;
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    if (!isLink) {
      resolved = [...resolved, seg];
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links: ${path}`), { code: 'ELOOP' });
    }
    const target = readlinkSync(candidate);
    if (target.startsWith('/')) resolved = [];
    pending = [...target.split('/').filter((s) => s !== '' && s !== '.'), ...pending];
  }
  return `/${withTrueCase(resolved).join('/')}`;
}

/** Options of {@link resolveWorkspaceRoots}. */
export interface WorkspaceRootsOptions {
  /** Explicit roots (the `--workspace-root` flags); relative ones resolve against `cwd`. */
  readonly roots?: readonly string[];
  /** Environment to read {@link WORKSPACE_ROOTS_ENV} from; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory: base of relative roots and the default root; default `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * The workspace roots to run with: explicit `roots` if any, else {@link WORKSPACE_ROOTS_ENV}, else
 * the working directory. Each is made absolute and folded (not symlink-resolved: the host does that
 * when it starts), and duplicates are dropped. Claude Code starts `pf mcp` in the project folder, so
 * the default confines a session to that project.
 */
export function resolveWorkspaceRoots(options: WorkspaceRootsOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fromEnv = (env[WORKSPACE_ROOTS_ENV] ?? '').split(delimiter).filter((s) => s !== '');
  const wanted =
    options.roots !== undefined && options.roots.length > 0
      ? options.roots
      : fromEnv.length > 0
        ? fromEnv
        : [cwd];
  return [...new Set(wanted.filter((r) => r !== '').map((r) => normalizePath(resolve(cwd, r))))];
}

/** True when `path` is `root` or lies below it (both canonical and absolute). */
export function isInside(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}
