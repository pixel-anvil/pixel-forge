/**
 * `server.json` discovery (spec 6.5): `pf serve` writes `<baseDir>/server.json`
 * `{pid, port, token, protocolVersion}` and removes it on exit; another process (`pf mcp`) reads it
 * to find a running server. Stale entries (the pid is gone) are detected and removed by
 * {@link discoverServer}. These are helpers only; nothing here listens or connects.
 *
 * The file holds the per-run token, so it is written with mode 0600 (and the folder 0700), by temp
 * file and rename so a reader never sees a partial file. The server runs on `127.0.0.1`, so a pid
 * check is a sound liveness test (unlike for lockfiles, there is no host to compare).
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpError } from '@pixel-forge/ops';
import { isProcessAlive } from './lockfile.js';

/**
 * The wire protocol version this build speaks. `pf serve` writes it to `server.json`; a client
 * (`pf mcp`) forwards only to a server whose `protocolVersion` equals it. Nothing listens yet (M2).
 */
export const SERVER_PROTOCOL_VERSION = 1;

/** The content of `server.json`. */
export interface ServerInfo {
  /** Process id of `pf serve`. */
  readonly pid: number;
  /** TCP port on `127.0.0.1`. */
  readonly port: number;
  /** Random per-run token for WS and HTTP. */
  readonly token: string;
  /** Wire protocol version; a client that does not speak it must not forward. */
  readonly protocolVersion: number;
}

/** The path of `server.json` under `baseDir`. */
export function serverInfoPath(baseDir: string): string {
  return join(baseDir, 'server.json');
}

/** Parses `server.json` text; `undefined` when it is not a valid {@link ServerInfo}. */
export function parseServerInfo(text: string): ServerInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, port, token, protocolVersion } = value as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (!int(pid, 1, Number.MAX_SAFE_INTEGER) || !int(port, 1, 65535)) return undefined;
  if (typeof token !== 'string' || token === '') return undefined;
  if (!int(protocolVersion, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return { pid, port, token, protocolVersion };
}

/**
 * Writes `server.json` (replacing any previous one, atomically). The caller decides whether to
 * overwrite a live server's entry; check {@link discoverServer} first.
 * @throws OpError `IO_FAILED`.
 */
export async function writeServerInfo(baseDir: string, info: ServerInfo): Promise<void> {
  const file = serverInfoPath(baseDir);
  const tmp = `${file}.${String(process.pid)}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new OpError(
      'IO_FAILED',
      `cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`,
      { file },
      { cause: e },
    );
  }
}

/** The entry as written, whether its server is alive or not; `undefined` if missing or invalid. */
export async function readServerInfo(baseDir: string): Promise<ServerInfo | undefined> {
  const text = await readFile(serverInfoPath(baseDir), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseServerInfo(text);
}

/** Options of {@link discoverServer} and {@link removeServerInfo}. */
export interface DiscoverOptions {
  /** Liveness probe; default {@link isProcessAlive}. Injectable for tests. */
  readonly isAlive?: (pid: number) => boolean;
  /** Delete a stale or invalid entry; default `true`. */
  readonly removeStale?: boolean;
}

/**
 * The running server, or `undefined` when there is none: the file is missing, invalid, or names a
 * dead pid. A stale or invalid file is deleted (unless `removeStale: false`), but only if it still
 * has the content that was judged stale, so a server that has just started is not wiped.
 */
export async function discoverServer(
  baseDir: string,
  options: DiscoverOptions = {},
): Promise<ServerInfo | undefined> {
  const file = serverInfoPath(baseDir);
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const info = parseServerInfo(text);
  if (info !== undefined && (options.isAlive ?? isProcessAlive)(info.pid)) return info;
  if (options.removeStale !== false) {
    const again = await readFile(file, 'utf8').catch(() => undefined);
    if (again === text) await rm(file, { force: true });
  }
  return undefined;
}

/**
 * Removes `server.json` on shutdown. With `pid`, only if the entry is that process's own, so a
 * server never deletes the entry of its successor. Returns whether a file was removed.
 */
export async function removeServerInfo(
  baseDir: string,
  options: { readonly pid?: number } = {},
): Promise<boolean> {
  const file = serverInfoPath(baseDir);
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  if (options.pid !== undefined && parseServerInfo(text)?.pid !== options.pid) return false;
  await rm(file, { force: true });
  return true;
}
