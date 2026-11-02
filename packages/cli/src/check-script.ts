/**
 * The `pf check` script format (FR-HARN-01), its validation, `${step.output.path}` references and
 * the `expect` matcher. Pure: no file access.
 * @packageDocumentation
 */
import { z } from 'zod';

const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A whole-string reference: `${stepId.output}` or `${stepId.output.path.0.to}`. */
const REF = /^\$\{([A-Za-z_][A-Za-z0-9_-]*)\.output((?:\.[A-Za-z0-9_-]+)*)\}$/;

/** What a step is expected to do. */
export const StepExpect = z.strictObject({
  ok: z.boolean().optional(),
  code: z.string().min(1).optional(),
  output: z.unknown().optional(),
});
/** What a step is expected to do: see {@link StepExpect}. */
export type StepExpect = z.output<typeof StepExpect>;

/** One step of a script. */
export const ScriptStep = z.strictObject({
  id: z
    .string()
    .regex(STEP_ID, 'letters, digits, "_" and "-", not starting with a digit')
    .optional(),
  op: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  expect: StepExpect.optional(),
  continueOnError: z.boolean().default(false),
});
/** One step of a script, after parsing (defaults applied). */
export type ScriptStep = z.output<typeof ScriptStep>;

/** The reference `value` stands for, or `undefined` when it is not a whole-string reference. */
export function parseRef(value: string): { step: string; path: readonly string[] } | undefined {
  const m = REF.exec(value);
  if (m === null) return undefined;
  const [, step = '', rest = ''] = m;
  return { step, path: rest === '' ? [] : rest.slice(1).split('.') };
}

/** Calls `visit` for every whole-string reference inside a JSON value. */
function eachRef(value: unknown, visit: (step: string) => void): void {
  if (typeof value === 'string') {
    const ref = parseRef(value);
    if (ref !== undefined) visit(ref.step);
  } else if (Array.isArray(value)) {
    for (const item of value) eachRef(item, visit);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) eachRef(item, visit);
  }
}

/** A `steps.json`. */
export const Script = z
  .strictObject({ steps: z.array(ScriptStep).min(1) })
  .superRefine((script, ctx) => {
    const seen = new Set<string>();
    script.steps.forEach((step, index) => {
      const refs = (target: string): void => {
        if (!seen.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index],
            message: `refers to "${target}", which is not an earlier step with that id`,
          });
        }
      };
      eachRef(step.input, refs);
      eachRef(step.expect, refs);
      if (step.id !== undefined) {
        if (seen.has(step.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'id'],
            message: `duplicate step id "${step.id}"`,
          });
        }
        seen.add(step.id);
      }
    });
  });
/** A parsed script. */
export type Script = z.output<typeof Script>;

/** The outputs of the steps that ran, by step id. */
export type StepOutputs = ReadonlyMap<string, unknown>;

/** Thrown when a reference cannot be resolved at run time (the step failed, or the path is missing). */
export class RefError extends Error {
  override readonly name = 'RefError';
}

function walk(value: unknown, path: readonly string[], text: string): unknown {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at) && /^\d+$/.test(key)) {
      at = at[Number(key)];
    } else if (typeof at === 'object' && at !== null && Object.hasOwn(at, key)) {
      at = (at as Record<string, unknown>)[key];
    } else {
      throw new RefError(`${text}: no "${key}" in the output`);
    }
    if (at === undefined) throw new RefError(`${text}: no "${key}" in the output`);
  }
  return at;
}

/**
 * Replaces every whole-string `"${stepId.output.path}"` in a JSON value with the value it names,
 * keeping its JSON type. A string that merely contains `${...}` is left alone.
 * @throws RefError when the step has no output (it failed or was skipped) or the path is missing.
 */
export function resolveRefs(value: unknown, outputs: StepOutputs): unknown {
  if (typeof value === 'string') {
    const ref = parseRef(value);
    if (ref === undefined) return value;
    if (!outputs.has(ref.step)) {
      throw new RefError(`${value}: step "${ref.step}" produced no output`);
    }
    return walk(outputs.get(ref.step), ref.path, value);
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, outputs));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, outputs)]));
  }
  return value;
}

/**
 * Deep partial match: every key of `expected` must be in `actual` and match; extra keys of
 * `actual` are ignored. Arrays must have the same length and match element by element (each
 * element partially). Everything else is compared with `Object.is`.
 * @returns the paths that differ (empty when it matches), as `path: reason`.
 */
export function partialMismatches(actual: unknown, expected: unknown, at = '$'): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected an array`];
    if (actual.length !== expected.length) {
      return [`${at}: expected ${String(expected.length)} items, got ${String(actual.length)}`];
    }
    return expected.flatMap((item, i) => partialMismatches(actual[i], item, `${at}[${String(i)}]`));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return [`${at}: expected an object`];
    }
    return Object.entries(expected).flatMap(([key, item]) =>
      Object.hasOwn(actual, key)
        ? partialMismatches((actual as Record<string, unknown>)[key], item, `${at}.${key}`)
        : [`${at}.${key}: missing`],
    );
  }
  return Object.is(actual, expected)
    ? []
    : [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}
