/**
 * `defineOp`: one definition per operation (spec 6.3, ADR-003). The registry runs it, and the
 * generators turn it into the MCP tool, the CLI subcommand metadata and `OPERATIONS.md`.
 * @packageDocumentation
 */
import { z } from 'zod';
import type { OpContext } from './context.js';
import { isToolGroup, TOOL_GROUPS } from './groups.js';
import type { ToolGroup } from './groups.js';
import { SAFETY_CLASSES } from './safety.js';
import type { Safety } from './safety.js';

export { SAFETY_CLASSES } from './safety.js';
export type { Safety } from './safety.js';

/** The zod type an op input must have: an object (MCP tool inputs are JSON objects). */
export type OpInputSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>;

/**
 * One worked example of an op. The first one goes into the MCP tool description (spec 8); all
 * of them go into `OPERATIONS.md`. Inputs (and outputs, when given) are checked against the
 * schemas when the op is defined.
 */
export interface OpExample<In, Out> {
  /** What the example shows, one line. */
  readonly title: string;
  /** A valid input (without `confirm`; destructive examples get `confirm: true` added). */
  readonly input: In;
  /** The output the input produces on the example's document, when it is worth showing. */
  readonly output?: Out;
}

/** A handler: synchronous for `read`/`mutate`/`destructive`, possibly async for `io`. */
export type OpHandler<S extends Safety, In, Out> = S extends 'io'
  ? (ctx: OpContext, input: In) => Out | Promise<Out>
  : (ctx: OpContext, input: In) => Out;

/** What {@link defineOp} takes. */
export interface OpSpec<S extends Safety, I extends OpInputSchema, O extends z.ZodType> {
  /**
   * `area.verbNoun` in lower camel case, e.g. `rig.setPose`, `doc.open`. The MCP tool name
   * (`rig_set_pose`) and CLI command (`pf rig set-pose`) derive from it.
   */
  readonly name: string;
  readonly safety: S;
  /**
   * The tool group this op belongs to (TG.1): required, so an op without one does not compile.
   * `pf mcp --tools` lists only the chosen groups. See `groups.ts`.
   */
  readonly group: ToolGroup;
  /**
   * One line for LLMs and `--help`: what the op does, in the imperative, with units
   * ("angle deg clockwise, offset int px"). At most 200 characters.
   */
  readonly summary: string;
  /** Optional longer guidance: when to use it, what it does not do, follow-up ops. */
  readonly description?: string;
  /**
   * `destructive` only: what the caller should know before confirming (what is lost). It is added
   * to the tool description and to the `CONFIRM_REQUIRED` message.
   */
  readonly confirmText?: string;
  /**
   * The input object. Document ops put `doc: DocRef` first (the registry resolves it to
   * `ctx.document`); use `z.strictObject` so misspelt keys are reported, `.describe()` every field,
   * and plain `z.record` (not schema's `record` helper) for maps, so the JSON Schema can be built.
   */
  readonly input: I;
  /** The output (compact JSON). The registry checks every result against it. */
  readonly output: O;
  /** At least one example; see {@link OpExample}. */
  readonly examples: readonly [
    OpExample<z.input<I>, z.input<O>>,
    ...OpExample<z.input<I>, z.input<O>>[],
  ];
  /**
   * `mutate`/`destructive` only: `false` runs the handler **without** opening a transaction, for the
   * history ops themselves (`doc.undo`, `doc.redo` call `ctx.document.store.undo()`). Default `true`.
   */
  readonly transaction?: boolean;
  /** MCP overrides: a tool name other than the derived one (spec 8 uses `undo`, `lint`...), or hide it. */
  readonly mcp?: { readonly name?: string; readonly hidden?: boolean };
  /** CLI overrides: the command words (`['lint']`), or hide it. */
  readonly cli?: { readonly command?: readonly string[]; readonly hidden?: boolean };
  /** Does the work. Resolve refs with `ctx.refs`/the resolvers, mutate only through `ctx.tx`. */
  readonly handler: OpHandler<S, z.output<I>, z.input<O>>;
}

/** A defined op: the spec plus the derived names. Frozen. */
export interface OpDefinition<
  S extends Safety = Safety,
  I extends OpInputSchema = OpInputSchema,
  O extends z.ZodType = z.ZodType,
> extends OpSpec<S, I, O> {
  /** The MCP tool name, e.g. `rig_set_pose`. */
  readonly mcpName: string;
  /** The CLI command words, e.g. `['rig', 'set-pose']`. */
  readonly cliCommand: readonly string[];
  /** True when the input has a `doc` field: the registry resolves it to `ctx.document`. */
  readonly targetsDocument: boolean;
  /** Whether the registry opens a transaction around the handler. */
  readonly transactional: boolean;
}

/** Any op, type-erased for the registry (handlers are called with parsed input). */
export interface AnyOp {
  readonly name: string;
  readonly safety: Safety;
  readonly group: ToolGroup;
  readonly summary: string;
  readonly description?: string;
  readonly confirmText?: string;
  readonly input: OpInputSchema;
  readonly output: z.ZodType;
  readonly examples: readonly OpExample<unknown, unknown>[];
  readonly mcp?: { readonly name?: string; readonly hidden?: boolean };
  readonly cli?: { readonly command?: readonly string[]; readonly hidden?: boolean };
  readonly mcpName: string;
  readonly cliCommand: readonly string[];
  readonly targetsDocument: boolean;
  readonly transactional: boolean;
  readonly handler: (ctx: OpContext, input: never) => unknown;
}

/** Op names: `area.verbNoun`, lower camel case, ASCII. */
export const OP_NAME_REGEX = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
/** MCP tool names (MCP spec: 1-64 of `[a-zA-Z0-9_-]`). */
export const MCP_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
/** CLI command words: lower kebab case. */
export const CLI_WORD_REGEX = /^[a-z][a-z0-9-]*$/;
/** Longest allowed summary. */
export const MAX_SUMMARY = 200;

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The derived MCP tool name: `rig.setPose` -> `rig_set_pose`. */
export function defaultMcpName(name: string): string {
  return name.split('.').map(snake).join('_');
}

/** The derived CLI command: `rig.setPose` -> `['rig', 'set-pose']`. */
export function defaultCliCommand(name: string): string[] {
  return name.split('.').map(kebab);
}

function fail(name: string, message: string): never {
  throw new Error(`defineOp(${name}): ${message}`);
}

function checkExample(
  name: string,
  index: number,
  example: OpExample<unknown, unknown>,
  input: z.ZodType,
  output: z.ZodType,
): void {
  if (example.title.trim() === '') fail(name, `example ${String(index)} has no title`);
  const i = input.safeParse(example.input);
  if (!i.success) {
    fail(name, `example ${String(index)} input is invalid: ${z.prettifyError(i.error)}`);
  }
  if (example.output !== undefined) {
    const o = output.safeParse(example.output);
    if (!o.success) {
      fail(name, `example ${String(index)} output is invalid: ${z.prettifyError(o.error)}`);
    }
  }
}

/**
 * Defines an op. Checks the definition at once (it runs at import time, so a broken definition
 * fails every test that loads the registry):
 *
 * - `group` is one of {@link TOOL_GROUPS};
 * - the name matches {@link OP_NAME_REGEX}, the MCP name {@link MCP_NAME_REGEX}, the CLI words
 *   {@link CLI_WORD_REGEX};
 * - the summary is one non-empty line of at most {@link MAX_SUMMARY} characters;
 * - `input` is a zod object; `mutate`/`destructive` inputs have a `doc` field; `confirm` is not
 *   declared (the registry owns it); `transaction` is only set on `mutate`/`destructive` ops;
 * - every example's input (and output, if given) parses.
 *
 * See `docs/ai/PLAYBOOKS.md`, "Add an op".
 * @throws Error describing the first problem.
 */
export function defineOp<S extends Safety, I extends OpInputSchema, O extends z.ZodType>(
  spec: OpSpec<S, I, O>,
): OpDefinition<S, I, O> {
  const { name } = spec;
  if (!OP_NAME_REGEX.test(name))
    fail(name, 'name must look like "area.verbNoun" (lower camel case)');
  if (!(SAFETY_CLASSES as readonly string[]).includes(spec.safety)) {
    fail(name, `unknown safety class "${spec.safety}"`);
  }
  if (!isToolGroup(spec.group)) {
    fail(
      name,
      `unknown tool group ${JSON.stringify(spec.group)}; valid: ${TOOL_GROUPS.join(', ')}`,
    );
  }
  const summary = spec.summary.trim();
  if (summary === '' || summary.includes('\n') || summary.length > MAX_SUMMARY) {
    fail(name, `summary must be one non-empty line of at most ${String(MAX_SUMMARY)} characters`);
  }
  if (!(spec.input instanceof z.ZodObject)) fail(name, 'input must be a zod object');
  const shape = spec.input.shape;
  const targetsDocument = Object.hasOwn(shape, 'doc');
  const writes = spec.safety === 'mutate' || spec.safety === 'destructive';
  if (writes && !targetsDocument) fail(name, `${spec.safety} ops need a "doc" input field`);
  if (Object.hasOwn(shape, 'confirm')) {
    fail(name, '"confirm" is reserved: the registry adds it to destructive ops');
  }
  if (spec.confirmText !== undefined && spec.safety !== 'destructive') {
    fail(name, '"confirmText" only applies to destructive ops');
  }
  if (spec.transaction !== undefined && !writes) {
    fail(name, '"transaction" only applies to mutate and destructive ops');
  }
  const mcpName = spec.mcp?.name ?? defaultMcpName(name);
  if (!MCP_NAME_REGEX.test(mcpName)) fail(name, `bad MCP tool name "${mcpName}"`);
  const cliCommand = [...(spec.cli?.command ?? defaultCliCommand(name))];
  if (cliCommand.length === 0 || !cliCommand.every((w) => CLI_WORD_REGEX.test(w))) {
    fail(name, `bad CLI command ${JSON.stringify(cliCommand)}`);
  }
  if (spec.examples.length === 0) fail(name, 'at least one example is required');
  spec.examples.forEach((ex, i) => {
    checkExample(name, i, ex, spec.input, spec.output);
  });
  return Object.freeze({
    ...spec,
    summary,
    mcpName,
    cliCommand: Object.freeze(cliCommand),
    targetsDocument,
    transactional: writes && spec.transaction !== false,
  });
}
