// The built bundle as a real process, started from a folder outside the repository.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBundle, tempDir, workspace } from './helpers.js';

let bundle = '';
beforeAll(() => {
  bundle = ensureBundle();
});

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('the pf bundle', () => {
  it('prints its version from any directory', async () => {
    const cwd = tempDir();
    const flag = await execa('node', [bundle, '--version'], { cwd });
    expect(flag.stdout).toBe(pkg.version);
    const word = await execa('node', [bundle, 'version'], { cwd });
    expect(word.stdout).toBe(pkg.version);
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is one file: it needs no node_modules next to it', async () => {
    const result = await execa('node', [bundle, 'doc', 'create', '--help'], { cwd: tempDir() });
    expect(result.stdout).toContain('--width');
  });

  it('runs a check script over a fixture: exit 0, report.json and a PNG', async () => {
    const w = workspace();
    const result = await execa(
      'node',
      [bundle, 'check', '--script', w.script, '--out', w.out, '--home', w.home],
      { cwd: tempDir(), reject: false },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, steps: 5, passed: 5 });
    const report = JSON.parse(readFileSync(join(w.out, 'report.json'), 'utf8')) as {
      ok: boolean;
      steps: { image?: { file: string } }[];
    };
    expect(report.ok).toBe(true);
    const file = report.steps.find((s) => s.image !== undefined)?.image?.file;
    expect(file).toBe('04-frame.png');
    expect(
      readFileSync(join(w.out, file ?? ''))
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  it('exits 1 when a step fails and 2 for a script it cannot read', async () => {
    const w = workspace();
    const bad = join(w.work, 'bad.json');
    await execa('node', [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(bad)}, '{"steps":[{"op":"doc.open","input":{"path":"nope.pxf"}}]}')`,
    ]);
    const failed = await execa(
      'node',
      [bundle, 'check', '--script', bad, '--out', w.out, '--home', w.home],
      {
        reject: false,
      },
    );
    expect(failed.exitCode).toBe(1);
    expect(existsSync(join(w.out, 'report.json'))).toBe(true);
    const missing = await execa(
      'node',
      [bundle, 'check', '--script', join(w.work, 'absent.json'), '--out', w.out],
      { reject: false },
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('cannot read script');
  });
});
