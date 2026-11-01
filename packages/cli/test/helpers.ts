// Shared helpers: temp folders (never the real home), the hero fixture, the built bundle, and an
// in-process runner that captures stdout and stderr.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { runCli } from '../src/index.js';

const HERO_SRC = fileURLToPath(new URL('../../../fixtures/generated/hero.pxf', import.meta.url));
const SAMPLE_SRC = fileURLToPath(new URL('./fixtures/sample.steps.json', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** The built single-file bundle (`pnpm build`). */
export const BUNDLE = join(PACKAGE, 'bundle', 'pf.mjs');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Registers a cleanup that runs after the current test. */
export function later(f: () => Promise<void> | void): void {
  cleanups.push(f);
}

/** A fresh canonical temp folder (the OS temp folder may be a symlink), removed after the test. */
export function tempDir(prefix = 'pf-cli-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  later(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Builds the bundle when it is missing (`pnpm build` and `pnpm test` build it first). */
export function ensureBundle(): string {
  if (!existsSync(BUNDLE)) {
    execFileSync('pnpm', ['bundle'], { cwd: PACKAGE, stdio: 'ignore' });
  }
  return BUNDLE;
}

/** A workspace: a separate base folder (`home`), and `work` holding hero.pxf and the sample script. */
export interface Workspace {
  readonly home: string;
  readonly work: string;
  readonly hero: string;
  readonly script: string;
  readonly out: string;
}

/** Creates a {@link Workspace} with copies of the hero and the sample script. */
export function workspace(): Workspace {
  const top = tempDir();
  const home = join(top, 'home');
  const work = join(top, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const hero = join(work, 'hero.pxf');
  const script = join(work, 'sample.steps.json');
  copyFileSync(HERO_SRC, hero);
  copyFileSync(SAMPLE_SRC, script);
  return { home, work, hero, script, out: join(top, 'out') };
}

/** The result of an in-process run. */
export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Runs `pf` in process with captured streams. `cwd` defaults to a temp folder; `home` is the base
 * folder for lockfiles (`PF_HOME`), so tests never touch the real one.
 */
export async function pf(
  args: readonly string[],
  where: { cwd?: string; home?: string } = {},
): Promise<Ran> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => (out += c.toString()));
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  const code = await runCli(args, {
    stdout,
    stderr,
    cwd: where.cwd ?? tempDir(),
    env: { PF_HOME: where.home ?? join(tempDir(), 'home') },
  });
  return { code, out, err };
}

/** Parses the one JSON line a command wrote. */
export function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
