import { Option } from 'commander';
import { createDocumentHost, resolveWorkspaceRoots } from '@pixel-forge/server';
import type { DocumentHost } from '@pixel-forge/server';
import type { CliEnv } from './env.js';

/** The environment variable that moves the base folder (locks, `server.json`). */
export const HOME_ENV = 'PF_HOME';

/** Flags every command that opens documents takes. */
export interface HostFlags {
  /** `--root`, repeatable. */
  readonly root?: readonly string[];
  /** `--home`. */
  readonly home?: string;
}

/**
 * Creates the document host of one CLI run. Roots: `extraRoots` plus `--root` flags; when there
 * are none, `PF_WORKSPACE_ROOTS`, else the working directory (`resolveWorkspaceRoots`). The base
 * folder is `--home`, else `PF_HOME`, else `~/.pixel-forge`.
 */
export function openHost(
  env: CliEnv,
  flags: HostFlags,
  extraRoots: readonly string[] = [],
): DocumentHost {
  const explicit = [...extraRoots, ...(flags.root ?? [])];
  const roots = resolveWorkspaceRoots({
    ...(explicit.length > 0 ? { roots: explicit } : {}),
    env: env.env,
    cwd: env.cwd,
  });
  const baseDir = flags.home ?? env.env[HOME_ENV];
  return createDocumentHost({
    roots,
    ...(baseDir === undefined || baseDir === '' ? {} : { baseDir }),
  });
}

/** The repeatable `--root <dir>` option of every command that opens documents. */
export const rootOption = (): Option =>
  new Option(
    '--root <dir>',
    'Workspace root; repeatable (default: the working directory).',
  ).argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value]);

/** The `--home <dir>` option (base folder of lockfiles and `server.json`). */
export const homeOption = (): Option =>
  new Option(
    '--home <dir>',
    `Folder for lockfiles and server.json (default ~/.pixel-forge, env ${HOME_ENV}).`,
  );
