// Shared helpers: temp folders (never the real home), the hero fixture, and child processes.
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach } from 'vitest';

const HERO_SRC = fileURLToPath(new URL('../../../fixtures/generated/hero.pxf', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Registers a cleanup that runs after the current test. */
export function later(f: () => Promise<void> | void): void {
  cleanups.push(f);
}

/** A fresh canonical temp folder (the OS temp folder may itself be a symlink), removed after the test. */
export function tempDir(prefix = 'pf-server-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  later(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A workspace with a copy of the hero at `<root>/hero.pxf` and a separate, empty base folder. */
export function workspace(): { base: string; root: string; hero: string } {
  const top = tempDir();
  const base = join(top, 'home');
  const root = join(top, 'work');
  mkdirSync(base);
  mkdirSync(root);
  const hero = join(root, 'hero.pxf');
  copyFileSync(HERO_SRC, hero);
  return { base, root, hero };
}

/** A process that has exited; its pid is dead (and unlikely to be reused during a test). */
export async function deadPid(): Promise<number> {
  const child = execa('node', ['-e', '']);
  const pid = child.pid;
  await child;
  if (pid === undefined) throw new Error('no pid');
  return pid;
}

/** One line of JSON from a child. */
export type ChildReport =
  | { ok: true; pid: number }
  | { ok: false; code: string; details: Record<string, unknown>; message: string };

/** A child process of `fixtures/child.mjs`. */
export interface Child {
  readonly pid: number;
  /** Tells the child to do its work and resolves with its report. */
  go(): Promise<ChildReport>;
  /** Closes the child's stdin so it exits normally, and waits for it. */
  finish(): Promise<void>;
}

/** Starts a child (`mode`: `host` opens the document through the ops, `lock` takes the lock only). */
export async function spawnChild(
  mode: 'host' | 'lock',
  base: string,
  root: string,
  docPath: string,
): Promise<Child> {
  const proc = execa('node', [CHILD, mode, base, root, docPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
  });
  later(async () => {
    proc.kill();
    await proc;
  });
  const pending: ((line: string) => void)[] = [];
  const queued: string[] = [];
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const waiter = pending.shift();
      if (waiter === undefined) queued.push(line);
      else waiter(line);
    }
  });
  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const queuedLine = queued.shift();
      if (queuedLine !== undefined) resolve(queuedLine);
      else pending.push(resolve);
      void proc.then((r) => {
        reject(new Error(`child exited early: ${r.stderr}`));
      });
    });
  await nextLine(); // {"ready":true}
  const pid = proc.pid;
  if (pid === undefined) throw new Error('no pid');
  return {
    pid,
    async go() {
      proc.stdin.write('go\n');
      return JSON.parse(await nextLine()) as ChildReport;
    },
    async finish() {
      proc.stdin.end();
      await proc;
    },
  };
}
