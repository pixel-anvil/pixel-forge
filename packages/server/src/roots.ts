/**
 * Workspace roots (NFR-06: MCP file I/O is restricted to configured workspace roots) and symlink
 * resolution, so that a link inside a root cannot lead out of it.
 *
 * Paths are POSIX style (as in the `FileSystem` port); Windows is not supported yet.
 * @packageDocumentation
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { normalizePath } from '@pixel-forge/ops';

/** Environment variable with extra workspace roots, separated like `PATH`. */
export const WORKSPACE_ROOTS_ENV = 'PF_WORKSPACE_ROOTS';

const MAX_LINKS = 40;

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

/**
 * The physical form of an absolute path: every symbolic link along it is followed (including links
 * whose target does not exist yet and links after `..`), so the result contains no link. Components
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
      const code = errCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
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
  return `/${resolved.join('/')}`;
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
