/**
 * `pf godot install <res-dir>`: copies the Godot addon into a project (`<res-dir>/addons/pixel_forge`).
 *
 * This is a plain file copy to a folder the user names, outside the workspace roots on purpose, so it
 * does not go through an op. The addon is read from `addon/pixel_forge` next to the bundle
 * (`tsup.config.mjs` copies `godot/addons/pixel_forge` there at build time); the path is taken from
 * the **real** location of the running file, because `pf` on `PATH` is a symlink to the bundle.
 * @packageDocumentation
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './env.js';
import type { CliEnv } from './env.js';

/** Folder of the addon inside a project's `res://`. */
const ADDON_PATH = ['addons', 'pixel_forge'] as const;

/** Test files that never ship with the addon (`test_*.gd` and their `.uid`, a `test/` folder). */
const isTestFile = (name: string): boolean =>
  /^test_.*\.gd(\.uid)?$/.test(name) || name === 'test' || name === 'tests' || name === '.DS_Store';

/** `version="x"` of a `plugin.cfg`, or `undefined` when the file or the key is missing. */
export function pluginVersion(cfgPath: string): string | undefined {
  if (!existsSync(cfgPath)) return undefined;
  return /^\s*version\s*=\s*"([^"]*)"/m.exec(readFileSync(cfgPath, 'utf8'))?.[1];
}

/**
 * Where the bundled addon is, looking at the real path of the running file: `bundle/addon/pixel_forge`
 * for the bundle, and the same folder seen from `src/` or `dist/` when run unbundled.
 * @returns the first folder that holds a `plugin.cfg`, or `undefined`.
 */
export function findAddonSource(moduleUrl: string = import.meta.url): string | undefined {
  const here = dirname(realpathSync(fileURLToPath(moduleUrl)));
  return [join(here, 'addon', 'pixel_forge'), join(here, '..', 'bundle', 'addon', 'pixel_forge')]
    .map((p) => resolve(p))
    .find((p) => existsSync(join(p, 'plugin.cfg')));
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

function refuse(env: CliEnv, code: string, message: string, details: object = {}): number {
  writeJson(env.stderr, { code, message, details });
  return 1;
}

/**
 * Installs the addon into the Godot project `resDir` (the folder with `project.godot`). Only
 * `addons/pixel_forge` is replaced: the new copy is made beside it first and swapped in, so a failed
 * copy leaves the old addon. Prints `{ok, op: "godot.install", output: {target, from, to, files}}`.
 * @param findSource where the addon to copy is (default: next to the running bundle)
 * @returns 0, or 1 when the target is no Godot project or the addon is missing from the bundle.
 */
export function runGodotInstall(
  env: CliEnv,
  resDir: string,
  findSource: () => string | undefined = findAddonSource,
): number {
  const project = resolve(env.cwd, resDir);
  if (!existsSync(join(project, 'project.godot'))) {
    return refuse(
      env,
      'REFUSED',
      `${project} has no project.godot; pass the Godot project folder`,
      {
        reason: 'not-a-godot-project',
        path: project,
      },
    );
  }
  const source = findSource();
  if (source === undefined) {
    return refuse(env, 'NOT_FOUND', 'the addon is not in this build; run "pnpm build"', {
      reason: 'addon-missing',
    });
  }
  const target = join(project, ...ADDON_PATH);
  const addons = dirname(target);
  const from = pluginVersion(join(target, 'plugin.cfg')) ?? null;
  const to = pluginVersion(join(source, 'plugin.cfg')) ?? null;
  const staging = join(addons, `.pixel_forge.new-${String(process.pid)}`);
  try {
    mkdirSync(addons, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, {
      recursive: true,
      filter: (src) => !isTestFile(src.slice(src.lastIndexOf('/') + 1)),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return refuse(
      env,
      'IO_FAILED',
      `cannot install into ${target}: ${e instanceof Error ? e.message : String(e)}`,
      { path: target },
    );
  }
  writeJson(env.stdout, {
    ok: true,
    op: 'godot.install',
    output: { target, from, to, files: countFiles(target) },
  });
  return 0;
}
