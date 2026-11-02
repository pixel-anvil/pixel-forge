// Registry subcommands: wiring from `cliMetadata`, reads, mutations with and without --save,
// destructive ops with and without --confirm, image output and bad flags.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { cliMetadata, registry } from '@pixel-forge/ops';
import { describe, expect, it } from 'vitest';
import {
  addRegistryCommands,
  createProgram,
  friendlyFor,
  optionFor,
  resolveEnv,
} from '../src/index.js';
import { json, pf, tempDir, workspace } from './helpers.js';

/** Every command path under `command`, as "a b". */
function leaves(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((c) =>
    c.commands.length > 0 ? leaves(c, [...prefix, c.name()]) : [[...prefix, c.name()].join(' ')],
  );
}

describe('registry wiring', () => {
  it('registers every cliMetadata command with a flag per input field', () => {
    const program = createProgram({ env: resolveEnv(), exitCode: 0 });
    const registered = new Set(leaves(program));
    const { commands } = cliMetadata(registry);
    expect(commands.length).toBeGreaterThan(30);
    for (const spec of commands) {
      expect(registered.has(spec.command.join(' ')), spec.op).toBe(true);
      let at: Command = program;
      for (const word of spec.command) {
        const next = at.commands.find((c) => c.name() === word);
        if (next === undefined) throw new Error(`${spec.op}: no command ${word}`);
        at = next;
      }
      // A hand-named command (friendly-commands.ts) takes some fields as positional arguments.
      const positional = friendlyFor(spec.op)?.positionals ?? [];
      expect(at.registeredArguments.length, spec.op).toBe(positional.length);
      for (const o of spec.options) {
        const asArgument = positional.some((p) => p.field === o.name);
        expect(
          asArgument || at.options.some((x) => x.long === o.flag),
          `${spec.op} ${o.flag}`,
        ).toBe(true);
      }
    }
    for (const builtin of ['mcp', 'check', 'version']) expect(registered.has(builtin)).toBe(true);
  });

  it('refuses a command that clashes with a built-in, and flags that clash with the wiring', () => {
    const clash = new Command('pf');
    clash.command('doc');
    expect(() => {
      addRegistryCommands(clash, { env: resolveEnv(), exitCode: 0 });
    }).toThrow(/clashes with a built-in/);
    expect(() =>
      optionFor({ name: 'fooBar', flag: '--baz', kind: 'string', required: false }, false),
    ).toThrow(/would store baz/);
  });

  it('exposes --out only on image ops and --save only on mutating ones', () => {
    const program = createProgram({ env: resolveEnv(), exitCode: 0 });
    const find = (...words: string[]): Command => {
      let at = program;
      for (const w of words) {
        const next = at.commands.find((c) => c.name() === w);
        if (next === undefined) throw new Error(w);
        at = next;
      }
      return at;
    };
    const has = (c: Command, long: string): boolean => c.options.some((o) => o.long === long);
    expect(has(find('render', 'frame'), '--out')).toBe(true);
    expect(has(find('doc', 'summary'), '--out')).toBe(false);
    expect(has(find('doc', 'summary'), '--save')).toBe(false);
    expect(has(find('layer', 'update'), '--save')).toBe(true);
    expect(has(find('rig', 'bake'), '--save')).toBe(true);
    expect(has(find('import'), '--save')).toBe(true);
    expect(has(find('export'), '--save')).toBe(false);
    expect(has(find('doc', 'create'), '--save')).toBe(true);
  });
});

async function summary(w: ReturnType<typeof workspace>) {
  const ran = await pf(['doc', 'summary', '--doc', 'hero.pxf'], { cwd: w.work, home: w.home });
  expect(ran.code).toBe(0);
  return (json(ran.out).output as { layers: { id: string; visible: boolean }[] }).layers;
}

describe('read ops', () => {
  it('doc summary prints compact JSON on stdout', async () => {
    const w = workspace();
    const ran = await pf(['doc', 'summary', '--doc', 'hero.pxf'], { cwd: w.work, home: w.home });
    expect(ran.code).toBe(0);
    expect(ran.out.trim().split('\n')).toHaveLength(1);
    expect(json(ran.out)).toMatchObject({
      ok: true,
      op: 'doc.summary',
      output: { name: 'hero', canvas: { w: 48, h: 48 } },
    });
    expect(json(ran.out).saved).toBeUndefined();
    expect(ran.err).toBe('');
  });

  it('an op failure goes to stderr as the OpErrorJson and exits 1', async () => {
    const w = workspace();
    const ran = await pf(['doc', 'summary', '--doc', 'absent.pxf'], { cwd: w.work, home: w.home });
    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(json(ran.err)).toMatchObject({
      code: expect.any(String) as unknown,
      message: expect.any(String) as unknown,
    });
  });

  it('keeps files outside the workspace root unreachable (--root, default cwd)', async () => {
    const w = workspace();
    const elsewhere = tempDir();
    const ran = await pf(['doc', 'summary', '--doc', w.hero], { cwd: elsewhere, home: w.home });
    expect(ran.code).toBe(1);
    expect(json(ran.err).code).toBe('NOT_ALLOWED');
    const allowed = await pf(['doc', 'summary', '--doc', w.hero, '--root', w.work], {
      cwd: elsewhere,
      home: w.home,
    });
    expect(allowed.code).toBe(0);
  });
});

describe('mutating ops', () => {
  it('change the file only with --save', async () => {
    const w = workspace();
    const [first] = await summary(w);
    expect(first?.visible).toBe(true);
    const before = readFileSync(w.hero);

    const dry = await pf(
      ['layer', 'update', '--doc', 'hero.pxf', '--layer', first?.id ?? '', '--visible', 'false'],
      {
        cwd: w.work,
        home: w.home,
      },
    );
    expect(dry.code).toBe(0);
    expect(json(dry.out)).toMatchObject({ ok: true, saved: false });
    expect(json(dry.out).note).toContain('nothing was written');
    expect(json(dry.out).doc).toMatchObject({ undoEntry: expect.any(Number) as unknown });
    expect(readFileSync(w.hero).equals(before)).toBe(true);
    expect((await summary(w))[0]?.visible).toBe(true);

    const saved = await pf(
      [
        'layer',
        'update',
        '--doc',
        'hero.pxf',
        '--layer',
        first?.id ?? '',
        '--visible=false',
        '--save',
      ],
      {
        cwd: w.work,
        home: w.home,
      },
    );
    expect(saved.code).toBe(0);
    expect(json(saved.out).saved).toMatchObject({ wrote: true });
    expect(readFileSync(w.hero).equals(before)).toBe(false);
    expect((await summary(w))[0]?.visible).toBe(false);
  });

  it('take a bare boolean flag as true and json flags as JSON or a plain word', async () => {
    const w = workspace();
    const [first] = await summary(w);
    await pf(
      [
        'layer',
        'update',
        '--doc',
        'hero.pxf',
        '--layer',
        first?.id ?? '',
        '--visible',
        'false',
        '--save',
      ],
      {
        cwd: w.work,
        home: w.home,
      },
    );
    const bare = await pf(
      ['layer', 'update', '--doc', 'hero.pxf', '--layer', first?.id ?? '', '--visible', '--save'],
      {
        cwd: w.work,
        home: w.home,
      },
    );
    expect(bare.code).toBe(0);
    expect((await summary(w))[0]?.visible).toBe(true);
    const frame = await pf(
      [
        'frame',
        'duplicate',
        '--doc',
        'hero.pxf',
        '--animation',
        '{"group":"default"}',
        '--frame',
        '0',
      ],
      { cwd: w.work, home: w.home },
    );
    expect(frame.code).toBe(0);
    const byId = await pf(
      ['frame', 'duplicate', '--doc', 'hero.pxf', '--animation', 'default', '--frame', 'frm_nope'],
      { cwd: w.work, home: w.home },
    );
    expect(byId.code).toBe(1); // a word that is not JSON reaches the op as a string
  });

  it('create a new document with --save <path>', async () => {
    const w = workspace();
    const made = await pf(['doc', 'create', '--width', '8', '--height', '8', '--save', 'new.pxf'], {
      cwd: w.work,
      home: w.home,
    });
    expect(made.code).toBe(0);
    expect(json(made.out).saved).toMatchObject({ wrote: true });
    const again = await pf(['doc', 'summary', '--doc', 'new.pxf'], { cwd: w.work, home: w.home });
    expect(json(again.out)).toMatchObject({ output: { canvas: { w: 8, h: 8 } } });
    const dry = await pf(['doc', 'create', '--width', '8', '--height', '8'], {
      cwd: w.work,
      home: w.home,
    });
    expect(json(dry.out).saved).toBeUndefined();
  });
});

describe('destructive ops', () => {
  const bake = [
    'rig',
    'bake',
    '--doc',
    'hero.pxf',
    '--animation',
    '{"group":"default"}',
    '--mode',
    'new',
    '--name',
    'baked',
  ];

  it('are refused without --confirm, run with it, and save only with --save', async () => {
    const w = workspace();
    const before = readFileSync(w.hero);
    const refused = await pf(bake, { cwd: w.work, home: w.home });
    expect(refused.code).toBe(1);
    expect(json(refused.err).code).toBe('CONFIRM_REQUIRED');

    const dry = await pf([...bake, '--confirm'], { cwd: w.work, home: w.home });
    expect(dry.code).toBe(0);
    expect(json(dry.out)).toMatchObject({ ok: true, saved: false });
    expect(readFileSync(w.hero).equals(before)).toBe(true);

    const saved = await pf([...bake, '--confirm', '--save'], { cwd: w.work, home: w.home });
    expect(saved.code).toBe(0);
    expect(readFileSync(w.hero).equals(before)).toBe(false);
  });
});

describe('image output', () => {
  const frame = [
    'render',
    'frame',
    'hero.pxf',
    '--animation',
    '{"group":"default"}',
    '--frame',
    '0',
    '--scale',
    '2',
  ];

  it('needs --out, and writes the PNG there instead of printing base64', async () => {
    const w = workspace();
    const missing = await pf(frame, { cwd: w.work, home: w.home });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('--out');

    const ran = await pf([...frame, '--out', 'shots/hero.png'], { cwd: w.work, home: w.home });
    expect(ran.code).toBe(0);
    const out = json(ran.out).output as { image: Record<string, unknown> };
    expect(out.image).toMatchObject({ mimeType: 'image/png', width: 96, height: 96 });
    expect(out.image.data).toBeUndefined();
    expect(out.image.file).toBe(join(w.work, 'shots', 'hero.png'));
    expect(
      readFileSync(join(w.work, 'shots', 'hero.png'))
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });
});

describe('bad flags exit 2', () => {
  it('rejects a wrong type, an unknown flag, a bad choice and a missing required flag', async () => {
    const w = workspace();
    const run = (args: string[]) => pf(args, { cwd: w.work, home: w.home });
    expect((await run(['doc', 'create', '--width', 'wide', '--height', '8'])).code).toBe(2);
    expect((await run(['doc', 'create', '--width', '1.5', '--height', '8'])).code).toBe(2);
    expect(
      (await run(['doc', 'create', '--width', '8', '--height', '8', '--pixels-per-unit', 'x']))
        .code,
    ).toBe(2);
    expect((await run(['doc', 'create', '--width', '8'])).code).toBe(2);
    expect((await run(['doc', 'create', '--width', '8', '--height', '8', '--nope'])).code).toBe(2);
    expect(
      (await run(['anim', 'create', '--doc', 'hero.pxf', '--group', 'x', '--loop', 'sideways']))
        .code,
    ).toBe(2);
    expect(
      (await run(['layer', 'update', '--doc', 'hero.pxf', '--layer', 'x', '--visible', 'maybe']))
        .code,
    ).toBe(2);
    expect((await run(['bogus'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(['rig'])).code).toBe(2);
  });

  it('prints help and the version with exit 0', async () => {
    const help = await pf(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: pf');
    const sub = await pf(['rig', 'set-pose', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.out).toContain('--animation <json>');
    expect((await pf(['--version'])).out.trim()).toBe('0.0.0-dev');
    expect((await pf(['version'])).out.trim()).toBe('0.0.0-dev');
  });

  it('an op that fails because of the file is a failure (1), not a usage error', async () => {
    const w = workspace();
    writeFileSync(join(w.work, 'junk.pxf'), 'not a zip');
    const ran = await pf(['doc', 'summary', '--doc', 'junk.pxf'], { cwd: w.work, home: w.home });
    expect(ran.code).toBe(1);
    expect(json(ran.err).code).toBe('BAD_FILE');
  });
});
