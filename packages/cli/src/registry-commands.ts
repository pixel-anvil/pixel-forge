/**
 * Registry to subcommand wiring: every entry of `cliMetadata(registry)` becomes a `pf` subcommand
 * with one `--flag` per input field. Hand-named commands (T5.6b) add on top of this and reuse
 * {@link addOpCommand} and {@link runOpCommand}.
 *
 * - `--doc <path>` opens the file first and passes its id to the op.
 * - Mutating ops change the file only with `--save`; without it the output says nothing was written.
 * - Destructive ops take the registry's own `--confirm`.
 * - Output is one line of compact JSON on stdout; an image output needs `--out <file>`.
 * - An op failure prints its `OpErrorJson` on stderr and exits 1; bad flags exit 2.
 * @packageDocumentation
 */
import { resolve } from 'node:path';
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { cliMetadata, registry as builtinRegistry, toJsonSchema } from '@pixel-forge/ops';
import type { CliCommand, CliOption, OpCallResult, OpHost, OpRegistry } from '@pixel-forge/ops';
import { writeJson } from './env.js';
import { friendlyFor, friendlyValue } from './friendly-commands.js';
import type { FriendlySpec } from './friendly-commands.js';
import type { CliEnv } from './env.js';
import { homeOption, openHost, rootOption } from './host.js';
import type { HostFlags } from './host.js';
import { imageOf, withoutImageData, writeImage } from './images.js';
import { resolvePathInputs } from './paths.js';

/** What the wiring shares with the shell that owns it. */
export interface WiringContext {
  readonly env: CliEnv;
  /** Set by an action to the exit code of the run. */
  exitCode: number;
}

/** Flags the wiring adds itself; an op input field may not use these names. */
const RESERVED_FLAGS: readonly string[] = ['root', 'home', 'save', 'out'];

/** Non-mutating ops that still change their document, so `--save` applies. */
const SAVES_AFTER: ReadonlySet<string> = new Set(['io.import', 'override.import']);

const INTEGER = /^-?\d+$/;

function parseInteger(value: string): number {
  const n = Number(value);
  if (!INTEGER.test(value) || !Number.isSafeInteger(n)) {
    throw new InvalidArgumentError('expected an integer');
  }
  return n;
}

function parseNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n))
    throw new InvalidArgumentError('expected a number');
  return n;
}

/** `--flag` alone means true (commander passes no string then); `--flag=false` and `=true` are explicit. */
function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InvalidArgumentError('expected true or false');
}

/** A JSON value, or the word itself when it is not valid JSON (`--frame 2`, `--frame frm_abc`). */
function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The commander option for one op input field. */
export function optionFor(o: CliOption, isDoc: boolean): Option {
  const placeholder = isDoc
    ? 'path'
    : o.kind === 'json'
      ? 'json'
      : o.kind === 'string'
        ? 'text'
        : 'n';
  const flags = o.kind === 'boolean' ? `${o.flag} [bool]` : `${o.flag} <${placeholder}>`;
  const description = isDoc
    ? 'Document file to open first (path).'
    : (o.description ?? o.name) + (o.kind === 'json' ? ' (JSON)' : '');
  const option = new Option(flags, description);
  switch (o.kind) {
    case 'integer':
      option.argParser(parseInteger);
      break;
    case 'number':
      option.argParser(parseNumber);
      break;
    case 'boolean':
      option.argParser(parseBoolean);
      break;
    case 'json':
      option.argParser(parseJsonOrString);
      break;
    case 'string':
      if (o.choices !== undefined) option.choices(o.choices);
      break;
  }
  if (option.attributeName() !== o.name) {
    throw new Error(`flag ${o.flag} would store ${option.attributeName()}, not ${o.name}`);
  }
  return o.required ? option.makeOptionMandatory() : option;
}

/** How `--save` behaves for a command. */
type SaveMode = 'none' | 'document' | 'new-file';

export interface OpCommandPlan {
  readonly spec: CliCommand;
  readonly hasDoc: boolean;
  readonly saveMode: SaveMode;
  readonly imageOutput: boolean;
}

function planFor(spec: CliCommand, registry: OpRegistry): OpCommandPlan {
  const hasDoc = spec.options.some((o) => o.name === 'doc' && o.kind === 'string');
  const mutates =
    spec.safety === 'mutate' || spec.safety === 'destructive' || SAVES_AFTER.has(spec.op);
  const saveMode: SaveMode =
    hasDoc && mutates ? 'document' : spec.op === 'doc.create' ? 'new-file' : 'none';
  const op = registry.get(spec.op);
  let imageOutput = false;
  if (op !== undefined) {
    const schema = toJsonSchema(op.output, 'output');
    imageOutput =
      typeof schema.properties === 'object' &&
      schema.properties !== null &&
      'image' in schema.properties;
  }
  return { spec, hasDoc, saveMode, imageOutput };
}

/**
 * Adds one op as a subcommand of `parent`, under the words of `spec.command` (creating the group
 * commands on the way, e.g. `rig` for `rig set-pose`). `friendly` turns some input fields into
 * positional arguments (see `friendly-commands.ts`); the default is the op's own friendly spec.
 */
export function addOpCommand(
  parent: Command,
  ctx: WiringContext,
  spec: CliCommand,
  registry: OpRegistry = builtinRegistry,
  friendly: FriendlySpec | undefined = friendlyFor(spec.op),
): Command {
  const plan = planFor(spec, registry);
  const positionals = friendly?.positionals ?? [];
  const positional = new Set(positionals.map((p) => p.field));
  const relaxed = new Set(friendly?.relax ?? []);
  let at = parent;
  for (const word of spec.command.slice(0, -1)) {
    at =
      at.commands.find((c) => c.name() === word) ??
      at.command(word).description(`${word} operations`);
  }
  const leaf = spec.command[spec.command.length - 1] ?? spec.op;
  if (at.commands.some((c) => c.name() === leaf)) {
    throw new Error(`command "${spec.command.join(' ')}" is defined twice`);
  }
  const command = at
    .command(leaf, friendly?.isDefault === true ? { isDefault: true } : undefined)
    .description(spec.summary);
  for (const p of positionals) {
    if (!spec.options.some((o) => o.name === p.field)) {
      throw new Error(`${spec.op}: positional "${p.name}" fills unknown field "${p.field}"`);
    }
    const word = `${p.name}${p.variadic === true ? '...' : ''}`;
    command.argument(p.optional === true ? `[${word}]` : `<${word}>`, p.description);
  }
  for (const o of spec.options) {
    if (RESERVED_FLAGS.includes(o.name)) {
      throw new Error(
        `${spec.op}: input field "${o.name}" clashes with the --${o.name} flag of pf`,
      );
    }
    if (positional.has(o.name)) continue;
    const flag = relaxed.has(o.name) ? { ...o, required: false } : o;
    command.addOption(optionFor(flag, o.name === 'doc' && plan.hasDoc));
  }
  command.addOption(rootOption());
  command.addOption(homeOption());
  if (plan.saveMode === 'document') {
    command.addOption(
      new Option('--save', 'Write the change to the file (otherwise nothing is written).'),
    );
  } else if (plan.saveMode === 'new-file') {
    command.addOption(new Option('--save <path>', 'Save the new document to this .pxf path.'));
  }
  if (plan.imageOutput) {
    command.addOption(
      new Option('--out <file>', 'PNG file to write the image to.').makeOptionMandatory(),
    );
  }
  command.action(async (...received: unknown[]) => {
    const flags: Record<string, unknown> = { ...command.opts() };
    positionals.forEach((p, i) => {
      const value = received[i];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        flags[p.field] = value;
      }
    });
    if (friendly !== undefined) {
      for (const [field, value] of Object.entries(friendly.defaults ?? {})) {
        flags[field] ??= value;
      }
      for (const o of spec.options) {
        if (flags[o.name] !== undefined) flags[o.name] = friendlyValue(o.name, flags[o.name]);
      }
    }
    ctx.exitCode = await runOpCommand(ctx, plan, registry, flags);
  });
  return command;
}

/** Adds every op of `cliMetadata(registry)` as a subcommand of `program`. */
export function addRegistryCommands(
  program: Command,
  ctx: WiringContext,
  registry: OpRegistry = builtinRegistry,
): void {
  const builtin = new Set(program.commands.map((c) => c.name()));
  for (const spec of cliMetadata(registry).commands) {
    if (builtin.has(spec.command[0] ?? '')) {
      throw new Error(
        `${spec.op}: command "${spec.command[0] ?? ''}" clashes with a built-in pf command`,
      );
    }
    addOpCommand(program, ctx, spec, registry);
  }
}

/** Parsed flags of an op command: the op's own fields plus the wiring's. */
type Flags = Record<string, unknown> & HostFlags;

/**
 * Runs one op command: opens `--doc`, calls the op, saves with `--save`, writes the image and
 * prints the result.
 * @returns the exit code: 0, or 1 when the op failed.
 */
export async function runOpCommand(
  ctx: WiringContext,
  plan: OpCommandPlan,
  registry: OpRegistry,
  flags: Flags,
): Promise<number> {
  const { env } = ctx;
  const { spec } = plan;
  const input: Record<string, unknown> = {};
  for (const o of spec.options) {
    if (flags[o.name] !== undefined) input[o.name] = flags[o.name];
  }
  const resolved = resolvePathInputs(input, env.cwd);
  const docPath = plan.hasDoc ? resolve(env.cwd, String(input.doc)) : undefined;

  const host = openHost(env, flags);
  try {
    if (docPath !== undefined) {
      const opened = await registry.call('doc.open', { path: docPath }, { host });
      if (!opened.ok) return fail(env, opened.error);
      resolved.doc = (opened.output as { doc: string }).doc;
    }
    const result = await registry.call(spec.op, resolved, { host });
    if (!result.ok) return fail(env, result.error);

    let output = result.output;
    const image = imageOf(output);
    if (image !== undefined && typeof flags.out === 'string') {
      const file = resolve(env.cwd, flags.out);
      writeImage(file, image);
      output = withoutImageData(output, file);
    }
    const envelope: Record<string, unknown> = { ok: true, op: spec.op, output };
    if (result.doc !== undefined) envelope.doc = result.doc;
    if (result.warnings !== undefined) envelope.warnings = result.warnings;

    const saved = await save(env, plan, flags, host, registry, result.output, resolved.doc);
    if (saved !== undefined) {
      if (!saved.ok) return fail(env, saved.error);
      envelope.saved = saved.output;
    } else if (plan.saveMode === 'document') {
      envelope.saved = false;
      envelope.note = `nothing was written to ${docPath ?? 'the file'}; pass --save to write the change`;
    }
    writeJson(env.stdout, envelope);
    return 0;
  } finally {
    await host.dispose();
  }
}

async function save(
  env: CliEnv,
  plan: OpCommandPlan,
  flags: Flags,
  host: OpHost,
  registry: OpRegistry,
  output: unknown,
  doc: unknown,
): Promise<OpCallResult | undefined> {
  if (plan.saveMode === 'document' && flags.save === true) {
    return registry.call('doc.save', { doc }, { host });
  }
  if (plan.saveMode === 'new-file' && typeof flags.save === 'string') {
    const created = (output as { doc: string }).doc;
    return registry.call(
      'doc.save',
      { doc: created, path: resolve(env.cwd, flags.save) },
      { host },
    );
  }
  return undefined;
}

function fail(env: CliEnv, error: unknown): number {
  writeJson(env.stderr, error);
  return 1;
}
