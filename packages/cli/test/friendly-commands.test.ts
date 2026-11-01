// The hand-named commands end to end on the synthetic hero: render, export, lint, override
// import|list|resolve (with the touch-up round trip), pack, unpack and godot install.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runGodotInstall } from '../src/godot-install.js';
import { resolveEnv } from '../src/index.js';
import { ensureBundle, json, pf, tempDir, workspace } from './helpers.js';
import type { Workspace } from './helpers.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Runs `pf` in the workspace and expects success. */
async function ok(w: Workspace, args: string[]) {
  const ran = await pf(args, { cwd: w.work, home: w.home });
  expect(ran.err, args.join(' ')).toBe('');
  expect(ran.code, args.join(' ')).toBe(0);
  return json(ran.out);
}

describe('pf render', () => {
  it('renders hero.pxf to --out; the frame defaults to 0; "render frame" is the same command', async () => {
    const w = workspace();
    const out = await ok(w, ['render', 'hero.pxf', '--animation', 'default', '--out', 'f.png']);
    expect(out).toMatchObject({ ok: true, op: 'render.frame', output: { frameIndex: 0 } });
    expect([...readFileSync(join(w.work, 'f.png')).subarray(0, 4)]).toEqual(PNG_MAGIC);
    const long = await ok(w, [
      'render',
      'frame',
      'hero.pxf',
      '--animation',
      '{"group":"default"}',
      '--frame',
      '0',
      '--scale',
      '2',
      '--out',
      'g.png',
    ]);
    expect(long).toMatchObject({ output: { scale: 2 } });
  });

  it('needs --out and --animation (exit 2), and fails on an unknown animation (exit 1)', async () => {
    const w = workspace();
    const run = (args: string[]) => pf(args, { cwd: w.work, home: w.home });
    expect((await run(['render', 'hero.pxf', '--animation', 'default'])).code).toBe(2);
    expect((await run(['render', 'hero.pxf', '--out', 'x.png'])).code).toBe(2);
    expect((await run(['render'])).code).toBe(2);
    const missing = await run(['render', 'hero.pxf', '--animation', 'nope', '--out', 'x.png']);
    expect(missing.code).toBe(1);
    expect(json(missing.err).code).toBe('NOT_FOUND');
  });

  it('still reaches the contact sheet command', async () => {
    const w = workspace();
    await ok(w, ['render', 'contact-sheet', '--doc', 'hero.pxf', '--out', 'sheet.png']);
    expect(existsSync(join(w.work, 'sheet.png'))).toBe(true);
  });
});

describe('pf export and pf lint', () => {
  it('exports a sheet PNG and JSON, animations given as group[/direction]', async () => {
    const w = workspace();
    const out = await ok(w, [
      'export',
      'hero.pxf',
      'sheets/hero.png',
      '--animations',
      'default',
      '--scale',
      '2',
    ]);
    expect(out).toMatchObject({
      ok: true,
      op: 'io.export',
      output: { frames: 1, size: { w: 96, h: 96 }, animations: ['default'] },
    });
    expect(existsSync(join(w.work, 'sheets', 'hero.png'))).toBe(true);
    expect(existsSync(join(w.work, 'sheets', 'hero.json'))).toBe(true);
    expect((await pf(['export', 'hero.pxf'], { cwd: w.work, home: w.home })).code).toBe(2);
  });

  it('lints a document and prints the findings; findings do not change the exit code', async () => {
    const w = workspace();
    const out = await ok(w, ['lint', 'hero.pxf']);
    expect(out).toMatchObject({
      ok: true,
      op: 'lint.run',
      output: { count: expect.any(Number) as unknown },
    });
    const narrow = await ok(w, ['lint', 'hero.pxf', '--enable', '["rig.jointGap"]']);
    expect(narrow).toMatchObject({ op: 'lint.run' });
    const bad = await pf(['lint', 'absent.pxf'], { cwd: w.work, home: w.home });
    expect(bad.code).toBe(1);
  });
});

/** The bytes of the sheet PNG exported from `file` (scale 1, the default animation: the frame itself). */
async function frameBytes(w: Workspace, file: string, png: string): Promise<Buffer> {
  await ok(w, ['export', file, png, '--animations', 'default']);
  return readFileSync(join(w.work, png));
}

describe('pf override', () => {
  it('round trip: edit 3 px, import, and the render equals the edited PNG', async () => {
    const w = workspace();
    // The "edit": a copy of the hero with three pixels painted on frame 0, exported at scale 1.
    copyFileSync(w.hero, join(w.work, 'touched.pxf'));
    const painted = await ok(w, [
      'pixels',
      'write-grid',
      '--doc',
      'touched.pxf',
      '--animation',
      '{"group":"default"}',
      '--frame',
      '0',
      '--x',
      '26',
      '--y',
      '4',
      '--rows',
      '["11","1_"]',
      '--legend',
      '{"1":"#ff00ff"}',
      '--save',
    ]);
    expect(painted).toMatchObject({
      output: { changed: 3 },
      saved: { path: expect.any(String) as unknown },
    });
    const edited = await frameBytes(w, 'touched.pxf', 'edited.png');
    const before = await frameBytes(w, 'hero.pxf', 'before.png');
    expect(edited.equals(before)).toBe(false);

    const dry = await ok(w, ['override', 'import', 'hero.pxf', 'default', '0', 'edited.png']);
    expect(dry).toMatchObject({
      ok: true,
      op: 'override.import',
      output: { changed: 3, animation: 'default', frameIndex: 0 },
      saved: false,
    });
    expect((await frameBytes(w, 'hero.pxf', 'still.png')).equals(before)).toBe(true);

    const imported = await ok(w, [
      'override',
      'import',
      'hero.pxf',
      'default',
      '0',
      'edited.png',
      '--save',
    ]);
    expect(imported).toMatchObject({
      output: { changed: 3 },
      saved: { path: expect.any(String) as unknown },
    });
    expect((await frameBytes(w, 'hero.pxf', 'after.png')).equals(edited)).toBe(true);

    // list and resolve see what the import made
    const list = await ok(w, ['override', 'list', 'hero.pxf']);
    const ids = (list.output as { valid: string[] }).valid;
    expect(ids.length).toBeGreaterThan(0);
    const keep = await ok(w, ['override', 'resolve', 'hero.pxf', ...ids, '--action', 'keep']);
    expect(keep).toMatchObject({ output: { action: 'keep', resolved: ids } });
    const discard = await ok(w, [
      'override',
      'resolve',
      'hero.pxf',
      ...ids,
      '--action',
      'discard',
      '--save',
    ]);
    expect(discard).toMatchObject({
      output: { resolved: ids },
      saved: { path: expect.any(String) as unknown },
    });
    expect((await frameBytes(w, 'hero.pxf', 'reverted.png')).equals(before)).toBe(true);
  });

  it('reports usage and op errors with the right exit codes', async () => {
    const w = workspace();
    const run = (args: string[]) => pf(args, { cwd: w.work, home: w.home });
    expect((await run(['override', 'import', 'hero.pxf', 'default'])).code).toBe(2);
    const noFile = await run(['override', 'import', 'hero.pxf', 'default', '0', 'none.png']);
    expect(noFile.code).toBe(1);
    expect(json(noFile.err).code).toBe('IO_FAILED');
    const noAction = await run(['override', 'resolve', 'hero.pxf', 'ovr_x']);
    expect(noAction.code).toBe(2);
    const noIds = await run(['override', 'resolve', 'hero.pxf', '--action', 'keep']);
    expect(noIds.code).toBe(1);
    expect(json(noIds.err).code).toBe('BAD_INPUT');
  });
});

describe('pf unpack and pf pack', () => {
  it('unpack then pack gives a document whose render is unchanged (and the same bytes)', async () => {
    const w = workspace();
    const un = await ok(w, ['unpack', 'hero.pxf']);
    expect(un).toMatchObject({
      op: 'pxf.unpack',
      output: { file: w.hero, dir: join(w.work, 'hero.pxfd') },
    });
    const dir = join(w.work, 'hero.pxfd');
    expect(readdirSync(dir).sort()).toEqual(
      expect.arrayContaining(['.gdignore', 'document.json', 'manifest.json']),
    );

    const packed = await ok(w, ['pack', 'hero.pxfd', 'again.pxf']);
    expect(packed).toMatchObject({ op: 'pxf.pack', output: { file: join(w.work, 'again.pxf') } });
    const original = await frameBytes(w, 'hero.pxf', 'o.png');
    const rebuilt = await frameBytes(w, 'again.pxf', 'r.png');
    expect(rebuilt.equals(original)).toBe(true);
    expect(readFileSync(join(w.work, 'again.pxf')).equals(readFileSync(w.hero))).toBe(true);

    // default names, and an existing folder needs --overwrite
    const clash = await pf(['unpack', 'hero.pxf'], { cwd: w.work, home: w.home });
    expect(clash.code).toBe(1);
    expect(json(clash.err).code).toBe('CONFLICT');
    await ok(w, ['unpack', 'hero.pxf', '--overwrite']);
    await ok(w, ['pack', 'hero.pxfd']);
  });

  it('refuses names that are not .pxf / .pxfd and paths outside the roots', async () => {
    const w = workspace();
    const run = (args: string[]) => pf(args, { cwd: w.work, home: w.home });
    expect((await run(['unpack', 'hero.pxf', 'folder'])).code).toBe(1);
    expect((await run(['pack', 'folder'])).code).toBe(1);
    expect((await run(['unpack'])).code).toBe(2);
    const outside = await run(['unpack', w.hero, join(tempDir(), 'x.pxfd')]);
    expect(json(outside.err).code).toBe('NOT_ALLOWED');
  });
});

/** A Godot project folder with a stub `project.godot`. */
function godotProject(): string {
  const dir = tempDir('pf-godot-');
  writeFileSync(join(dir, 'project.godot'), 'config_version=5\n');
  return dir;
}

describe('pf godot install', () => {
  it('copies the addon without test files, and reports the old and new versions', async () => {
    const project = godotProject();
    const first = await pf(['godot', 'install', project]);
    expect(first.code).toBe(0);
    expect(json(first.out)).toMatchObject({
      ok: true,
      op: 'godot.install',
      output: { target: join(project, 'addons', 'pixel_forge'), from: null, to: '0.1.0' },
    });
    const target = join(project, 'addons', 'pixel_forge');
    expect(existsSync(join(target, 'plugin.cfg'))).toBe(true);
    expect(readdirSync(target).filter((n) => n.startsWith('test'))).toEqual([]);

    // an older install is replaced, a sibling addon is not touched
    writeFileSync(join(target, 'plugin.cfg'), 'version="0.0.1"\n');
    writeFileSync(join(target, 'stale.gd'), '');
    mkdirSync(join(project, 'addons', 'other'));
    writeFileSync(join(project, 'addons', 'other', 'keep.txt'), 'x');
    const again = await pf(['godot', 'install', project]);
    expect(json(again.out)).toMatchObject({ output: { from: '0.0.1', to: '0.1.0' } });
    expect(existsSync(join(target, 'stale.gd'))).toBe(false);
    expect(existsSync(join(project, 'addons', 'other', 'keep.txt'))).toBe(true);
    expect(readdirSync(join(project, 'addons')).sort()).toEqual(['other', 'pixel_forge']);
  });

  it('refuses a folder with no project.godot (exit 1), and a missing argument (exit 2)', async () => {
    const empty = tempDir();
    const ran = await pf(['godot', 'install', empty]);
    expect(ran.code).toBe(1);
    expect(json(ran.err)).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'not-a-godot-project' },
    });
    expect(existsSync(join(empty, 'addons'))).toBe(false);
    expect((await pf(['godot', 'install'])).code).toBe(2);
  });

  it('excludes test files from a source that has them, and reports a missing addon', () => {
    const source = tempDir();
    writeFileSync(join(source, 'plugin.cfg'), 'version="2.0.0"\n');
    writeFileSync(join(source, 'driver.gd'), '');
    writeFileSync(join(source, 'test_driver.gd'), '');
    writeFileSync(join(source, 'test_driver.gd.uid'), '');
    mkdirSync(join(source, 'tests'));
    writeFileSync(join(source, 'tests', 'a.gd'), '');
    const project = godotProject();
    const lines: string[] = [];
    const sink = { write: (s: string) => lines.push(s) } as unknown as NodeJS.WritableStream;
    const env = resolveEnv({ stdout: sink as never, stderr: sink as never, cwd: project });
    expect(runGodotInstall(env, '.', () => source)).toBe(0);
    expect(readdirSync(join(project, 'addons', 'pixel_forge')).sort()).toEqual([
      'driver.gd',
      'plugin.cfg',
    ]);
    lines.length = 0;
    expect(runGodotInstall(env, '.', () => undefined)).toBe(1);
    expect(lines.join('')).toContain('addon-missing');
  });

  it('works from the real bundle, also through a symlink (how pf sits on PATH)', async () => {
    const bundle = ensureBundle();
    const bin = tempDir();
    const link = join(bin, 'pf');
    symlinkSync(bundle, link);
    const project = godotProject();
    const cwd = tempDir();
    const viaNode = await execa('node', [link, 'godot', 'install', project], { cwd });
    expect(JSON.parse(viaNode.stdout)).toMatchObject({ ok: true, output: { to: '0.1.0' } });
    expect(existsSync(join(project, 'addons', 'pixel_forge', 'plugin.gd'))).toBe(true);

    // executed directly through the shebang, as the shell does
    const second = godotProject();
    execFileSync(link, ['godot', 'install', second], { cwd });
    expect(existsSync(join(second, 'addons', 'pixel_forge', 'plugin.cfg'))).toBe(true);
  });
});
