import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng } from '@pixel-forge/png';
import type { TestImage } from './image.js';

/** Context passed to a fixture generator's `default async function generate(ctx)`. */
export interface FixtureContext {
  /** Absolute path of the `fixtures/` directory (read-only reference; write through the methods). */
  readonly root: string;
  /**
   * Write a PNG at `relPath` (relative to `fixtures/`). Every `write*` method also accepts a path
   * under `../godot/` (the Godot test project's fixtures); any other path outside `fixtures/` is
   * refused.
   */
  writePng(relPath: string, img: TestImage): void;
  /** Write pretty-printed JSON (2 spaces, trailing newline) at `relPath`. */
  writeJson(relPath: string, obj: unknown): void;
  /** Write raw bytes (a `.pxf`, say) at `relPath` (relative to `fixtures/`). */
  writeFile(relPath: string, bytes: Uint8Array): void;
}

/** Options for {@link runFixtures}. */
export interface RunFixturesOptions {
  /** The `fixtures/` directory. Generators live in `<root>/src/*.ts|*.mjs`. */
  root: string;
  /** Where outputs are written. Default: `root`. */
  outDir?: string;
  /** Called with each generator file name before it runs. */
  onGenerator?: (file: string) => void;
}

/** Generator file names in `<root>/src`, sorted (`.ts` and `.mjs`). */
export function listGenerators(root: string): string[] {
  const dir = join(root, 'src');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
}

/** Repository folders (siblings of `fixtures/`) that generators may write into, as `../<dir>/...`. */
const EXTERNAL_DIRS = ['godot'];

/**
 * Resolves `relPath` under `base` (the output directory). A path `../<dir>/...` with `<dir>` in
 * {@link EXTERNAL_DIRS} goes to `<repoBase>/<dir>/...` instead, where `repoBase` is the repository
 * root (or, when checking, a folder inside the temporary output).
 */
function safeJoin(base: string, repoBase: string, relPath: string): string {
  const norm = posix.normalize(relPath.split(sep).join('/'));
  const dir = norm.split('/')[1];
  if (norm.startsWith('../') && dir !== undefined && EXTERNAL_DIRS.includes(dir)) {
    const full = resolve(repoBase, norm.slice(3));
    if (full.startsWith(join(repoBase, dir) + sep)) return full;
  }
  const full = resolve(base, relPath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`fixture path escapes the fixtures directory: ${relPath}`);
  }
  return full;
}

/**
 * Run every generator in sorted order. A generator that throws (or has no default function) fails the
 * run with an error naming the file. Returns the sorted relative paths written (forward slashes).
 */
export async function runFixtures(opts: RunFixturesOptions): Promise<string[]> {
  const root = resolve(opts.root);
  const outDir = resolve(opts.outDir ?? root);
  // Real run: external dirs are the repository's. Check run: they sit in `<outDir>/.repo`.
  const repoBase = outDir === root ? dirname(root) : join(outDir, '.repo');
  const written = new Set<string>();
  const record = (full: string): void => {
    // A real run gives `../godot/...` directly; a check run puts those files under `.repo/`.
    const rel = relative(outDir, full).split(sep).join('/');
    written.add(rel.startsWith('.repo/') ? `../${rel.slice('.repo/'.length)}` : rel);
  };
  const ctx: FixtureContext = {
    root,
    writePng(relPath, img) {
      const full = safeJoin(outDir, repoBase, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, encodePng({ ...img, kind: 'rgba' }));
      record(full);
    },
    writeJson(relPath, obj) {
      const full = safeJoin(outDir, repoBase, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
      record(full);
    },
    writeFile(relPath, bytes) {
      const full = safeJoin(outDir, repoBase, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      record(full);
    },
  };
  for (const file of listGenerators(root)) {
    opts.onGenerator?.(file);
    try {
      const mod = (await import(
        /* @vite-ignore */ pathToFileURL(join(root, 'src', file)).href
      )) as {
        default?: unknown;
      };
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      await (mod.default as (c: FixtureContext) => Promise<void> | void)(ctx);
    } catch (e) {
      throw new Error(
        `fixture generator ${file} failed: ${e instanceof Error ? e.message : String(e)}`,
        {
          cause: e,
        },
      );
    }
  }
  return [...written].sort();
}

/**
 * Regenerate into a temp dir and compare with the committed outputs under `root`. Returns the list of
 * problems (`missing: <path>` / `differs: <path>`); empty means up to date.
 */
export async function checkFixtures(opts: { root: string }): Promise<string[]> {
  const root = resolve(opts.root);
  const tmp = mkdtempSync(join(tmpdir(), 'pf-fixtures-'));
  try {
    const files = await runFixtures({ root, outDir: tmp });
    const problems: string[] = [];
    for (const f of files) {
      const committed = join(root, f);
      const fresh = f.startsWith('../') ? join(tmp, '.repo', f.slice(3)) : join(tmp, f);
      if (!existsSync(committed)) problems.push(`missing: ${f}`);
      else if (!readFileSync(committed).equals(readFileSync(fresh))) problems.push(`differs: ${f}`);
    }
    return problems;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
