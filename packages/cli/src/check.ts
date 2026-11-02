/**
 * `pf check` (FR-HARN-01): runs a script of op calls headlessly and writes `report.json` and the
 * PNGs the ops returned. The script format is documented in the package README.
 * @packageDocumentation
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { registry } from '@pixel-forge/ops';
import type { OpCallResult, OpErrorJson, OpHost } from '@pixel-forge/ops';
import { z } from 'zod';
import { Script, RefError, partialMismatches, resolveRefs } from './check-script.js';
import type { ScriptStep, StepOutputs } from './check-script.js';
import { UsageError, writeJson } from './env.js';
import type { CliEnv } from './env.js';
import { openHost } from './host.js';
import type { HostFlags } from './host.js';
import { imageOf, withoutImageData, writeImage } from './images.js';
import { resolvePathInputs } from './paths.js';

/** Flags of `pf check`. */
export interface CheckFlags extends HostFlags {
  /** `--script`: the steps file. */
  readonly script: string;
  /** `--out`: the folder for `report.json` and the PNGs. */
  readonly out: string;
}

/** How a step ended. `skipped` steps never ran because an earlier step failed. */
export type StepStatus = 'passed' | 'failed' | 'skipped';

/** One step in `report.json`. */
export interface StepReport {
  /** 1-based position in the script. */
  readonly index: number;
  readonly id?: string;
  readonly op: string;
  readonly status: StepStatus;
  /** Whether the op itself succeeded (`null` when skipped). A passed step may have failed on purpose. */
  readonly ok: boolean | null;
  /** Wall time of the call, ms. */
  readonly ms: number;
  /** The output, with the decoded PNG's `data` replaced by `file`. */
  readonly output?: unknown;
  readonly error?: OpErrorJson;
  /** The document state after the call (ops with a `doc` field). */
  readonly doc?: unknown;
  /** The PNG written for an image output, relative to the report. */
  readonly image?: { readonly file: string; readonly width: number; readonly height: number };
  /** Why the step failed: unmet expectations or an unresolved reference. */
  readonly problems?: readonly string[];
}

/** The lint result of one document that was still open at the end. */
export interface LintReport {
  readonly doc: string;
  readonly path?: string;
  readonly count?: number;
  readonly findings?: unknown;
  readonly error?: OpErrorJson;
}

/** The shape of `report.json`. */
export interface CheckReport {
  readonly version: 1;
  /** True when no step failed. Lint findings do not change it. */
  readonly ok: boolean;
  readonly script: string;
  readonly totalMs: number;
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly steps: readonly StepReport[];
  /** `lint.run` over every document still open after the last step. */
  readonly lint: readonly LintReport[];
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

/** Reads and validates a script. @throws UsageError when it cannot be read or is invalid. */
export function loadScript(file: string): Script {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read script ${file}: ${e instanceof Error ? e.message : ''}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} is not JSON: ${e instanceof Error ? e.message : ''}`);
  }
  const parsed = Script.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(`invalid script ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The problems with a result against a step's `expect` (default: it must succeed). */
function judge(step: ScriptStep, result: OpCallResult, expectOutput: unknown): readonly string[] {
  const expect = step.expect;
  const wantOk = expect?.ok ?? expect?.code === undefined;
  const problems: string[] = [];
  if (result.ok !== wantOk) {
    problems.push(
      result.ok
        ? 'expected the op to fail, but it succeeded'
        : `expected the op to succeed, but it failed: ${result.error.code}: ${result.error.message}`,
    );
  }
  if (expect?.code !== undefined && (result.ok || result.error.code !== expect.code)) {
    problems.push(
      `expected error code ${expect.code}, got ${result.ok ? 'success' : result.error.code}`,
    );
  }
  if (expect?.output !== undefined) {
    if (result.ok) problems.push(...partialMismatches(result.output, expectOutput));
    else problems.push('expected an output, but the op failed');
  }
  return problems;
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Runs `pf check`. Workspace roots are the script's folder, `--out` and any `--root`; relative
 * paths in the script resolve against the script's folder. The host is disposed on every path.
 * @returns 0 when every step passed, 1 when a step or expectation failed.
 * @throws UsageError for an unreadable or invalid script (exit 2).
 */
export async function runCheck(env: CliEnv, flags: CheckFlags): Promise<number> {
  const scriptFile = resolve(env.cwd, flags.script);
  const script = loadScript(scriptFile);
  const scriptDir = dirname(scriptFile);
  const out = resolve(env.cwd, flags.out);
  mkdirSync(out, { recursive: true });

  const host = openHost(env, flags, [scriptDir, out]);
  const started = performance.now();
  const steps: StepReport[] = [];
  const lint: LintReport[] = [];
  const outputs = new Map<string, unknown>();
  try {
    let halted = false;
    for (const [i, step] of script.steps.entries()) {
      const index = i + 1;
      const base = { index, ...(step.id === undefined ? {} : { id: step.id }), op: step.op };
      if (halted) {
        steps.push({ ...base, status: 'skipped', ok: null, ms: 0 });
        continue;
      }
      const report = await runStep(step, index, base, outputs, host, scriptDir, out);
      steps.push(report);
      if (report.status === 'failed' && !step.continueOnError) halted = true;
    }
    for (const doc of host.list()) {
      const result = await registry.call('lint.run', { doc: doc.id }, { host });
      lint.push(
        result.ok
          ? {
              doc: doc.id,
              ...(doc.path === undefined ? {} : { path: doc.path }),
              ...(result.output as { count: number; findings: unknown }),
            }
          : {
              doc: doc.id,
              ...(doc.path === undefined ? {} : { path: doc.path }),
              error: result.error,
            },
      );
    }
  } finally {
    await host.dispose();
  }

  const counts = {
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    skipped: steps.filter((s) => s.status === 'skipped').length,
  };
  const report: CheckReport = {
    version: 1,
    ok: counts.failed === 0,
    script: scriptFile,
    totalMs: round(performance.now() - started),
    counts,
    steps,
    lint,
  };
  const reportFile = join(out, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  writeJson(env.stdout, { ok: report.ok, report: reportFile, steps: steps.length, ...counts });
  for (const s of steps.filter((x) => x.status === 'failed')) {
    env.stderr.write(
      `step ${String(s.index)} (${s.id ?? s.op}) failed:\n${(s.problems ?? []).map((p) => `  ${p}\n`).join('')}`,
    );
  }
  return report.ok ? 0 : 1;
}

async function runStep(
  step: ScriptStep,
  index: number,
  base: { readonly index: number; readonly id?: string; readonly op: string },
  outputs: Map<string, unknown>,
  host: OpHost,
  scriptDir: string,
  out: string,
): Promise<StepReport> {
  const started = performance.now();
  const elapsed = (): number => round(performance.now() - started);
  let input: Record<string, unknown>;
  let expectOutput: unknown;
  try {
    const known: StepOutputs = outputs;
    input = resolvePathInputs(resolveRefs(step.input, known) as Record<string, unknown>, scriptDir);
    expectOutput = resolveRefs(step.expect?.output, known);
  } catch (e) {
    if (!(e instanceof RefError)) throw e;
    return { ...base, status: 'failed', ok: false, ms: elapsed(), problems: [e.message] };
  }

  const result = await registry.call(step.op, input, { host });
  const ms = elapsed();
  const problems = judge(step, result, expectOutput);
  const status: StepStatus = problems.length === 0 ? 'passed' : 'failed';
  if (!result.ok) {
    return {
      ...base,
      status,
      ok: false,
      ms,
      error: result.error,
      ...(problems.length > 0 ? { problems } : {}),
    };
  }
  if (step.id !== undefined) outputs.set(step.id, result.output);
  const png = imageOf(result.output);
  let file: string | undefined;
  if (png !== undefined) {
    file = `${String(index).padStart(2, '0')}-${safeName(step.id ?? step.op)}.png`;
    writeImage(join(out, file), png);
  }
  return {
    ...base,
    status,
    ok: true,
    ms,
    output: file === undefined ? result.output : withoutImageData(result.output, file),
    ...(result.doc === undefined ? {} : { doc: result.doc }),
    ...(png === undefined || file === undefined
      ? {}
      : { image: { file: basename(file), width: png.width, height: png.height } }),
    ...(problems.length > 0 ? { problems } : {}),
  };
}
