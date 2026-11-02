// `pf check`: script validation, `${...}` references, expectations and the report (in process).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefError, parseRef, partialMismatches, resolveRefs } from '../src/index.js';
import { json, pf, workspace } from './helpers.js';
import type { Workspace } from './helpers.js';

interface Report {
  ok: boolean;
  counts: { passed: number; failed: number; skipped: number };
  steps: {
    index: number;
    id?: string;
    status: string;
    ok: boolean | null;
    ms: number;
    problems?: string[];
    output?: Record<string, unknown>;
    error?: { code: string };
    image?: { file: string; width: number; height: number };
  }[];
  lint: { doc: string; count?: number; error?: unknown }[];
}

/** Writes a script next to the hero and runs `pf check`. */
async function check(w: Workspace, steps: object[], extra: string[] = []) {
  const script = join(w.work, 'run.steps.json');
  writeFileSync(script, JSON.stringify({ steps }));
  const ran = await pf(['check', '--script', script, '--out', w.out, '--home', w.home, ...extra], {
    cwd: w.work,
  });
  const file = join(w.out, 'report.json');
  const report = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Report) : undefined;
  return { ...ran, report };
}

const open = { id: 'open', op: 'doc.open', input: { path: 'hero.pxf' } };

describe('pf check: the sample script', () => {
  it('passes, writes report.json and a PNG that the report names, and lints the open document', async () => {
    const w = workspace();
    const ran = await pf(['check', '--script', w.script, '--out', w.out, '--home', w.home], {
      cwd: w.work,
    });
    expect(ran.code).toBe(0);
    expect(json(ran.out)).toMatchObject({ ok: true, steps: 5, passed: 5, failed: 0, skipped: 0 });
    const report = JSON.parse(readFileSync(join(w.out, 'report.json'), 'utf8')) as Report;
    expect(report.steps.map((s) => s.status)).toEqual(Array<string>(5).fill('passed'));
    expect(report.steps.every((s) => s.ms >= 0)).toBe(true);
    const frame = report.steps[3];
    expect(frame?.image).toMatchObject({ file: '04-frame.png', width: 192, height: 192 });
    expect(JSON.stringify(report)).not.toContain('"data"'); // image data is removed
    const png = readFileSync(join(w.out, '04-frame.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(report.steps[4]).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(report.lint).toHaveLength(1);
    expect(report.lint[0]).toMatchObject({ count: 0 });
  });

  it('names an image after the op when the step has no id', async () => {
    const w = workspace();
    const { report } = await check(w, [
      open,
      {
        op: 'render.frame',
        input: { doc: '${open.output.doc}', animation: { group: 'default' }, frame: 0 },
      },
    ]);
    expect(report?.steps[1]?.image?.file).toBe('02-render.frame.png');
    expect(existsSync(join(w.out, '02-render.frame.png'))).toBe(true);
  });
});

describe('pf check: references', () => {
  it('keeps the JSON type of the referenced value (numbers, objects, array items)', async () => {
    const w = workspace();
    const { code, report } = await check(w, [
      open,
      { id: 'sum', op: 'doc.summary', input: { doc: '${open.output.doc}' } },
      {
        op: 'anim.create',
        input: { doc: '${open.output.doc}', group: 'walk', frames: '${sum.output.pixelsPerUnit}' },
        expect: { output: { label: 'walk' } },
      },
      {
        op: 'layer.update',
        input: { doc: '${open.output.doc}', layer: '${sum.output.layers.0.id}', visible: false },
      },
      {
        op: 'doc.summary',
        input: { doc: '${open.output.doc}' },
        expect: { output: { canvas: '${sum.output.canvas}', layers: [{ visible: false }] } },
      },
    ]);
    // the last expectation compares a 16-element array with a 1-element one: it must fail loudly
    expect(code).toBe(1);
    expect(report?.steps.slice(0, 4).map((s) => s.status)).toEqual(Array<string>(4).fill('passed'));
    expect(report?.steps[4]?.problems?.join('\n')).toContain('expected 1 items, got 16');
  });

  it('leaves a string that only contains ${...} alone', () => {
    const outputs = new Map([['a', { x: 1 }]]);
    expect(resolveRefs('id-${a.output.x}', outputs)).toBe('id-${a.output.x}');
    expect(resolveRefs({ k: ['${a.output.x}', '${a.output}'] }, outputs)).toEqual({
      k: [1, { x: 1 }],
    });
    expect(parseRef('${a.output.b.0}')).toEqual({ step: 'a', path: ['b', '0'] });
    expect(parseRef('${a.output}')).toEqual({ step: 'a', path: [] });
    expect(parseRef('plain')).toBeUndefined();
  });

  it('fails a step whose reference cannot be resolved', async () => {
    const w = workspace();
    const { code, report } = await check(w, [
      open,
      { id: 'a', op: 'doc.summary', input: { doc: '${open.output.doc}' } },
      { op: 'doc.summary', input: { doc: '${a.output.nothing}' } },
    ]);
    expect(code).toBe(1);
    expect(report?.steps[2]).toMatchObject({ status: 'failed' });
    expect(report?.steps[2]?.problems?.[0]).toContain('no "nothing" in the output');
  });

  it('fails a step that refers to a step which failed and was allowed to', async () => {
    const w = workspace();
    const { code, report } = await check(w, [
      { id: 'gone', op: 'doc.open', input: { path: 'absent.pxf' }, continueOnError: true },
      { op: 'doc.summary', input: { doc: '${gone.output.doc}' }, continueOnError: true },
      open,
    ]);
    expect(code).toBe(1);
    expect(report?.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'passed']);
    expect(report?.steps[1]?.problems?.[0]).toContain('produced no output');
  });

  it('throws RefError from resolveRefs', () => {
    expect(() => resolveRefs('${zz.output}', new Map())).toThrow(RefError);
    expect(() => resolveRefs('${a.output.list.5}', new Map([['a', { list: [1] }]]))).toThrow(
      RefError,
    );
  });
});

describe('pf check: expectations', () => {
  it('passes an expected failure by code and a deep partial output match', async () => {
    const w = workspace();
    const { code, report } = await check(w, [
      open,
      {
        op: 'doc.open',
        input: { path: 'absent.pxf' },
        expect: { ok: false },
      },
      { op: 'nope.nothing', input: {}, expect: { code: 'UNKNOWN_OP' } },
      {
        op: 'doc.summary',
        input: { doc: '${open.output.doc}' },
        expect: { output: { origin: { x: 24 }, rig: { bones: [{ name: 'root' }] } } },
      },
    ]);
    expect(report?.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed', 'failed']);
    // the last one: rig.bones has many entries, so the array length differs
    expect(code).toBe(1);
  });

  it('fails when the output differs, with the path of the difference', async () => {
    const w = workspace();
    const { code, report, err } = await check(w, [
      open,
      {
        id: 'bad',
        op: 'doc.summary',
        input: { doc: '${open.output.doc}' },
        expect: { output: { canvas: { w: 49 }, missing: 1 } },
      },
    ]);
    expect(code).toBe(1);
    expect(report?.steps[1]?.problems).toEqual([
      '$.canvas.w: expected 49, got 48',
      '$.missing: missing',
    ]);
    expect(err).toContain('step 2 (bad) failed');
  });

  it('fails when an op fails without the script expecting it, or succeeds when it should not', async () => {
    const w = workspace();
    const unexpected = await check(w, [{ op: 'doc.open', input: { path: 'absent.pxf' } }]);
    expect(unexpected.code).toBe(1);
    expect(unexpected.report?.steps[0]?.problems?.[0]).toContain('expected the op to succeed');
    const w2 = workspace();
    const wrongCode = await check(w2, [
      open,
      {
        op: 'doc.summary',
        input: { doc: '${open.output.doc}' },
        expect: { ok: false },
        continueOnError: true,
      },
      {
        op: 'doc.summary',
        input: { doc: '${open.output.doc}' },
        expect: { code: 'NOT_FOUND' },
        continueOnError: true,
      },
      { op: 'doc.summary', input: { doc: 'doc_nothing' }, expect: { code: 'BAD_INPUT' } },
    ]);
    expect(wrongCode.report?.steps[1]?.problems).toEqual([
      'expected the op to fail, but it succeeded',
    ]);
    expect(wrongCode.report?.steps[2]?.problems).toContain(
      'expected error code NOT_FOUND, got success',
    );
  });

  it('flags an output expectation on a step that failed', async () => {
    const w = workspace();
    const { report } = await check(w, [
      { op: 'doc.open', input: { path: 'absent.pxf' }, expect: { ok: false, output: { x: 1 } } },
    ]);
    expect(report?.steps[0]?.problems).toEqual(['expected an output, but the op failed']);
  });

  it('stops at the first failure and marks the rest skipped, unless continueOnError is set', async () => {
    const w = workspace();
    const stopped = await check(w, [
      open,
      { op: 'doc.summary', input: { doc: 'doc_nothing' } },
      { op: 'doc.summary', input: { doc: '${open.output.doc}' } },
    ]);
    expect(stopped.report?.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(stopped.report?.counts).toEqual({ passed: 1, failed: 1, skipped: 1 });
    expect(stopped.report?.ok).toBe(false);
    // the open document is still linted after a failure
    expect(stopped.report?.lint).toHaveLength(1);

    const w2 = workspace();
    const go = await check(w2, [
      open,
      { op: 'doc.summary', input: { doc: 'doc_nothing' }, continueOnError: true },
      { op: 'doc.summary', input: { doc: '${open.output.doc}' } },
    ]);
    expect(go.report?.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'passed']);
    expect(go.code).toBe(1);
  });

  it('keeps files outside the script folder, --out and --root unreachable', async () => {
    const w = workspace();
    const { code, report } = await check(w, [
      { op: 'doc.open', input: { path: '/etc/hosts' }, expect: { code: 'NOT_ALLOWED' } },
    ]);
    expect(code).toBe(0);
    expect(report?.steps[0]?.status).toBe('passed');
  });
});

describe('pf check: usage errors exit 2', () => {
  async function bad(content: string | undefined, file = 'bad.steps.json') {
    const w = workspace();
    const script = join(w.work, file);
    if (content !== undefined) writeFileSync(script, content);
    const ran = await pf(['check', '--script', script, '--out', w.out, '--home', w.home], {
      cwd: w.work,
    });
    return { ...ran, w };
  }

  it('reports a missing script, bad JSON and a script that fails validation', async () => {
    expect(await bad(undefined)).toMatchObject({ code: 2 });
    expect((await bad(undefined)).err).toContain('cannot read script');
    const notJson = await bad('{nope');
    expect(notJson.code).toBe(2);
    expect(notJson.err).toContain('is not JSON');
    const unknownKey = await bad('{"steps":[{"op":"doc.open","oops":1}]}');
    expect(unknownKey.code).toBe(2);
    expect(unknownKey.err).toContain('invalid script');
    expect((await bad('{"steps":[]}')).code).toBe(2);
    expect((await bad('{"steps":[{"op":"x","id":"1bad"}]}')).code).toBe(2);
  });

  it('rejects a reference to a later or unknown step and duplicate ids before running anything', async () => {
    const later = await bad(
      JSON.stringify({
        steps: [
          { op: 'doc.summary', input: { doc: '${open.output.doc}' } },
          { id: 'open', op: 'doc.open', input: { path: 'hero.pxf' } },
        ],
      }),
    );
    expect(later.code).toBe(2);
    expect(later.err).toContain('not an earlier step');
    expect(existsSync(join(later.w.out, 'report.json'))).toBe(false);
    const dup = await bad(
      JSON.stringify({
        steps: [
          { id: 'a', op: 'doc.open', input: { path: 'hero.pxf' } },
          { id: 'a', op: 'doc.open', input: { path: 'hero.pxf' } },
        ],
      }),
    );
    expect(dup.code).toBe(2);
    expect(dup.err).toContain('duplicate step id');
  });

  it('requires --script and --out', async () => {
    const w = workspace();
    expect((await pf(['check', '--out', w.out], { cwd: w.work })).code).toBe(2);
    expect((await pf(['check', '--script', w.script], { cwd: w.work })).code).toBe(2);
  });
});

describe('partialMismatches', () => {
  it('compares primitives, objects and arrays', () => {
    expect(partialMismatches({ a: 1, b: 2 }, { a: 1 })).toEqual([]);
    expect(partialMismatches([{ a: 1, b: 2 }], [{ a: 1 }])).toEqual([]);
    expect(partialMismatches(1, '1')).toEqual(['$: expected "1", got 1']);
    expect(partialMismatches({}, [])).toEqual(['$: expected an array']);
    expect(partialMismatches([], {})).toEqual(['$: expected an object']);
    expect(partialMismatches(null, { a: 1 })).toEqual(['$: expected an object']);
    expect(partialMismatches(Number.NaN, Number.NaN)).toEqual([]);
  });
});
