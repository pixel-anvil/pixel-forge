import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '@pixel-forge/png';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFixtures, listGenerators, runFixtures } from '../src/index.js';

let root: string;
const gen = (name: string, body: string) => {
  writeFileSync(join(root, 'src', name), body);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-fix-'));
  mkdirSync(join(root, 'src'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const GOOD = `export default async function generate(ctx) {
  ctx.writePng('out/a.png', { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) });
  ctx.writeJson('out/a.json', { ok: true });
  ctx.writeFile('out/a.bin', new Uint8Array([7, 8]));
}`;

describe('fixtures runner', () => {
  it('runs generators in sorted order and writes outputs', async () => {
    gen('b.mjs', GOOD);
    gen('a.mjs', `export default function g(ctx) { ctx.writeJson('order.json', {}); }`);
    gen('notes.txt', 'ignored');
    expect(listGenerators(root)).toEqual(['a.mjs', 'b.mjs']);
    const seen: string[] = [];
    const files = await runFixtures({ root, onGenerator: (f) => seen.push(f) });
    expect(seen).toEqual(['a.mjs', 'b.mjs']);
    expect(files).toEqual(['order.json', 'out/a.bin', 'out/a.json', 'out/a.png']);
    expect([...readFileSync(join(root, 'out/a.bin'))]).toEqual([7, 8]);
    expect([...decodePng(readFileSync(join(root, 'out/a.png'))).data]).toEqual([1, 2, 3, 255]);
    expect(readFileSync(join(root, 'out/a.json'), 'utf8')).toBe('{\n  "ok": true\n}\n');
  });

  it('fails when a generator throws or has no default export', async () => {
    gen('bad.mjs', `export default () => { throw new Error('boom'); }`);
    await expect(runFixtures({ root })).rejects.toThrow(/bad\.mjs failed: boom/);
    rmSync(join(root, 'src', 'bad.mjs'));
    gen('bad2.mjs', `export const x = 1;`);
    await expect(runFixtures({ root })).rejects.toThrow(/no default export/);
  });

  it('refuses paths that escape the fixtures dir', async () => {
    gen('evil.mjs', `export default (ctx) => ctx.writeJson('../evil.json', {});`);
    await expect(runFixtures({ root })).rejects.toThrow(/escapes/);
  });

  it('check detects missing and differing committed outputs', async () => {
    gen('a.mjs', GOOD);
    expect(await checkFixtures({ root })).toEqual([
      'missing: out/a.bin',
      'missing: out/a.json',
      'missing: out/a.png',
    ]);
    await runFixtures({ root });
    expect(await checkFixtures({ root })).toEqual([]);
    writeFileSync(join(root, 'out/a.json'), '{}');
    expect(await checkFixtures({ root })).toEqual(['differs: out/a.json']);
  });
});

describe('fixtures runner: outputs under ../godot', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pf-repo-'));
    root = join(repo, 'fixtures');
    mkdirSync(join(root, 'src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const G = `export default async function generate(ctx) {
  ctx.writeFile('../godot/test/fixtures/a.bin', new Uint8Array([1, 2]));
  ctx.writeJson('own.json', { n: 1 });
}`;

  it('writes into the repository folder and checks it against a fresh run', async () => {
    gen('g.mjs', G);
    const files = await runFixtures({ root });
    expect(files).toEqual(['../godot/test/fixtures/a.bin', 'own.json']);
    expect([...readFileSync(join(repo, 'godot/test/fixtures/a.bin'))]).toEqual([1, 2]);
    expect(await checkFixtures({ root })).toEqual([]);
    writeFileSync(join(repo, 'godot/test/fixtures/a.bin'), new Uint8Array([9]));
    expect(await checkFixtures({ root })).toEqual(['differs: ../godot/test/fixtures/a.bin']);
    rmSync(join(repo, 'godot/test/fixtures/a.bin'));
    expect(await checkFixtures({ root })).toEqual(['missing: ../godot/test/fixtures/a.bin']);
  });

  it('refuses other folders outside fixtures and traversal out of godot', async () => {
    gen('x.mjs', `export default (ctx) => ctx.writeJson('../docs/x.json', {});`);
    await expect(runFixtures({ root })).rejects.toThrow(/escapes/);
    rmSync(join(root, 'src', 'x.mjs'));
    gen('y.mjs', `export default (ctx) => ctx.writeJson('../godot/../docs/y.json', {});`);
    await expect(runFixtures({ root })).rejects.toThrow(/escapes/);
  });
});
