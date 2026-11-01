/**
 * Document ownership lockfiles (spec 6.5): whoever opens a document writes
 * `<baseDir>/locks/<sha1(path)>.lock` containing `{pid, host}`. Lockfiles are never stored next to
 * the document. A second process that wants the same document gets `OpError('DOC_LOCKED')` with the
 * owner's pid in `details.pid`.
 *
 * **Creation is atomic and complete.** The record is first written to a private temp file in the
 * same folder, then hard-linked to the lock name. `link(2)` fails with `EEXIST` when the name is
 * taken (an exclusive create), and the new name never exists with partial content, so a reader never
 * sees a half-written record.
 *
 * **Stale locks.** A lock is stale when it names this host and its pid is dead (`kill(pid, 0)` says
 * `ESRCH`), or when the file is not a valid record. A stale lock is reclaimed by renaming it aside
 * (atomic, and only one of several concurrent reclaimers wins the rename), checking that what was
 * moved is the very record judged stale, and only then deleting it; the winner and the other
 * contenders then race on the exclusive create like on any free lock. If the rename grabbed a live
 * lock written in between, it is put back. The remaining window (a third process creating the lock
 * between the grab and the put-back) is microseconds wide and needs three processes; it is accepted.
 *
 * **Other hosts.** The pid of a record from a different hostname means nothing here (shared home
 * folder, containers), so such a lock is never judged stale: it stays `DOC_LOCKED` until its owner
 * releases it or someone deletes the file (the error names it in `details.lockFile`).
 *
 * **Release** is best effort: {@link LockHandle.release}, plus a synchronous sweep on normal process
 * `exit`. A crash leaves the file behind and is covered by the stale check. A release only deletes a
 * file that still holds this process's own record.
 * @packageDocumentation
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { OpError } from '@pixel-forge/ops';

/** The content of a lockfile. */
export interface LockRecord {
  /** Process id of the owner. */
  readonly pid: number;
  /** Hostname of the owner's machine. */
  readonly host: string;
}

/** The default base folder, `~/.pixel-forge`. Tests and embedders inject their own `baseDir`. */
export function defaultBaseDir(): string {
  return join(homedir(), '.pixel-forge');
}

/** The lockfile of a document path: `<baseDir>/locks/<sha1(path)>.lock` (hex digest of the UTF-8 path). */
export function lockFilePath(baseDir: string, docPath: string): string {
  const digest = createHash('sha1').update(docPath, 'utf8').digest('hex');
  return join(baseDir, 'locks', `${digest}.lock`);
}

/**
 * True unless the process is known to be gone. `EPERM` (a process of another user) counts as alive;
 * a non-positive or non-integer pid counts as dead.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(typeof e === 'object' && e !== null && 'code' in e && e.code === 'ESRCH');
  }
}

/** Parses lockfile text; `undefined` when it is not a valid record. */
export function parseLockRecord(text: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, host } = value as { pid?: unknown; host?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || host === '') return undefined;
  return { pid, host };
}

/** Options of {@link acquireLock}. */
export interface AcquireLockOptions {
  /** Base folder (`~/.pixel-forge`); the lock goes to `<baseDir>/locks/`. */
  readonly baseDir: string;
  /** The normalised, canonical document path (the lock identity). */
  readonly path: string;
  /** This machine's hostname; default `os.hostname()`. Injectable for tests. */
  readonly hostname?: string;
  /** Liveness probe for pids of this host; default {@link isProcessAlive}. Injectable for tests. */
  readonly isAlive?: (pid: number) => boolean;
  /** Sweep the lock on normal process exit; default `true`. */
  readonly releaseOnExit?: boolean;
}

/** A held lock. */
export interface LockHandle {
  /** The document path the lock is for. */
  readonly path: string;
  /** The lockfile's path. */
  readonly lockFile: string;
  /** Deletes the lockfile if it still holds this process's record. Idempotent, never throws. */
  release(): Promise<void>;
}

interface HeldLock extends LockHandle {
  releaseSync(): void;
}

const held = new Set<HeldLock>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const lock of [...held]) lock.releaseSync();
  });
}

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

const sibling = (file: string, suffix: string): string =>
  `${file}.${String(process.pid)}-${randomBytes(4).toString('hex')}.${suffix}`;

/** Exclusive create with complete content: temp file, then `link`. `false` when the lock exists. */
async function createExclusive(file: string, text: string): Promise<boolean> {
  const tmp = sibling(file, 'tmp');
  await writeFile(tmp, text, { flag: 'wx' });
  try {
    await link(tmp, file);
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Moves a stale lock aside and deletes it, unless what moved is not the record judged stale (then it
 * is put back). Losing the rename to another reclaimer (`ENOENT`) is fine.
 */
async function reclaim(file: string, staleText: string): Promise<void> {
  const aside = sibling(file, 'stale');
  try {
    await rename(file, aside);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return;
    throw e;
  }
  const moved = await readFile(aside, 'utf8').catch(() => undefined);
  if (moved !== undefined && moved !== staleText) {
    await link(aside, file).catch(() => undefined); // EEXIST: a third process got in; see the module note
  }
  await rm(aside, { force: true });
}

function lockedError(path: string, file: string, owner: LockRecord, here: string): OpError {
  const where = owner.host === here ? '' : ` on host ${owner.host}`;
  return new OpError(
    'DOC_LOCKED',
    `${path} is open in another process (pid ${String(owner.pid)}${where})`,
    { path, pid: owner.pid, host: owner.host, lockFile: file },
  );
}

/**
 * Acquires the ownership lock of `path`, reclaiming a stale one.
 * @throws OpError `DOC_LOCKED` (`details.pid`, `host`, `path`, `lockFile`) when a live process, or any
 *   process of another host, owns it; `IO_FAILED` when the lock folder cannot be used.
 */
export async function acquireLock(options: AcquireLockOptions): Promise<LockHandle> {
  const here = options.hostname ?? osHostname();
  const alive = options.isAlive ?? isProcessAlive;
  const file = lockFilePath(options.baseDir, options.path);
  const text = JSON.stringify({ pid: process.pid, host: here });
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 16; attempt++) {
      if (await createExclusive(file, text)) {
        const lock: HeldLock = {
          path: options.path,
          lockFile: file,
          async release() {
            held.delete(lock);
            const current = await readFile(file, 'utf8').catch(() => undefined);
            if (current === text) await unlink(file).catch(() => undefined);
          },
          releaseSync() {
            held.delete(lock);
            try {
              if (readFileSync(file, 'utf8') === text) unlinkSync(file);
            } catch {
              // best effort
            }
          },
        };
        if (options.releaseOnExit !== false) {
          held.add(lock);
          installExitHook();
        }
        return lock;
      }
      const seen = await readFile(file, 'utf8').catch((e: unknown) => {
        if (errCode(e) === 'ENOENT') return undefined;
        throw e;
      });
      if (seen === undefined) continue; // released meanwhile: try again
      const owner = parseLockRecord(seen);
      if (owner !== undefined && !(owner.host === here && !alive(owner.pid))) {
        throw lockedError(options.path, file, owner, here);
      }
      await reclaim(file, seen); // dead owner on this host, or a corrupt file
    }
  } catch (e) {
    if (e instanceof OpError) throw e;
    throw new OpError(
      'IO_FAILED',
      `cannot lock ${options.path}: ${e instanceof Error ? e.message : String(e)}`,
      { path: options.path, lockFile: file },
      { cause: e },
    );
  }
  throw new OpError('IO_FAILED', `cannot lock ${options.path}: the lock keeps changing`, {
    path: options.path,
    lockFile: file,
  });
}
