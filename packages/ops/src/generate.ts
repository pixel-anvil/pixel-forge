/**
 * Generators over the registry (spec 6.3, ADR-003): MCP tool definitions, CLI subcommand metadata
 * and `docs/contracts/OPERATIONS.md`. Pure functions of the registry; `packages/ops/scripts/gen-ops.mjs`
 * writes them and `pnpm gen:check` (part of `pnpm verify`) fails when a committed copy is stale.
 * @packageDocumentation
 */
import { z } from 'zod';
import type { AnyOp, Safety } from './define.js';
import { OP_ERROR_CODES } from './errors.js';
import type { OpErrorCode } from './errors.js';
import type { OpRegistry } from './registry.js';

/** A JSON Schema object (draft 2020-12) as produced by zod. */
export type JsonSchema = Record<string, unknown>;

/** Conventions every tool description states (spec 8). */
export const CONVENTIONS =
  'Conventions: origin top-left, y down, angles deg clockwise, integer px.';

/** The JSON Schema of the `confirm` field the registry adds to destructive ops. */
export const CONFIRM_SCHEMA: JsonSchema = Object.freeze({
  type: 'boolean',
  description: 'Must be true: this operation is destructive.',
});

/** The reserved-name lookahead of schema's name patterns (`^(?!(?:__proto__|…)$)`). */
const RESERVED_LOOKAHEAD = /^\^\(\?!\(\?:[^)]*\)\$\)/;

/**
 * JSON Schema (draft 2020-12) of a zod schema, compact for LLM context: no `$schema` key, no
 * `±Number.MAX_SAFE_INTEGER` bounds (zod adds them to every `z.int()`) and no reserved-name
 * lookahead in name patterns (zod still rejects `__proto__` & co.; JSON Schema may be looser, zod
 * parsing is the authority). `io: 'input'` for op inputs (fields with defaults are optional),
 * `'output'` for outputs.
 * @throws Error when the schema has a part JSON Schema cannot express (e.g. `z.custom`).
 */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    override: (ctx) => {
      const s = ctx.jsonSchema as Record<string, unknown>;
      if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
      if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
      if (typeof s.pattern === 'string' && RESERVED_LOOKAHEAD.test(s.pattern)) {
        s.pattern = `^${s.pattern.replace(RESERVED_LOOKAHEAD, '')}`;
      }
    },
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

/** The input JSON Schema of an op as transports publish it (with `confirm` for destructive ops). */
export function opInputSchema(op: AnyOp): JsonSchema {
  const json = toJsonSchema(op.input, 'input');
  if (op.safety !== 'destructive') return json;
  const properties = { ...(json.properties as Record<string, unknown> | undefined) };
  properties.confirm = { ...CONFIRM_SCHEMA };
  return { ...json, properties };
}

/** An example input as shown to callers (destructive ones carry `confirm: true`). */
export function exampleInput(op: AnyOp, input: unknown): unknown {
  return op.safety === 'destructive' && typeof input === 'object' && input !== null
    ? { ...input, confirm: true }
    : input;
}

const SAFETY_NOTE: Readonly<Record<Safety, string>> = {
  read: 'Read-only.',
  mutate: 'Edit: one undo step.',
  destructive: 'Destructive: pass "confirm": true. One undo step.',
  io: 'File I/O.',
};

/** The safety note of an op: a history op (no transaction) moves through the steps, it adds none. */
function safetyNote(op: AnyOp): string {
  const mutates = op.safety === 'mutate' || op.safety === 'destructive';
  return mutates && !op.transactional
    ? 'Moves through the history, adds no undo step.'
    : SAFETY_NOTE[op.safety];
}

/** The MCP tool description: summary, guidance, safety, conventions and the first example. */
export function toolDescription(op: AnyOp): string {
  const parts = [op.summary];
  if (op.description !== undefined) parts.push(op.description.trim());
  parts.push(
    `${safetyNote(op)}${op.confirmText === undefined ? '' : ` ${op.confirmText}`} ${CONVENTIONS}`,
  );
  const ex = op.examples[0];
  if (ex !== undefined) {
    parts.push(`Example (${ex.title}): ${JSON.stringify(exampleInput(op, ex.input))}`);
  }
  return parts.join('\n\n');
}

/** An MCP tool definition (MCP `Tool`: name, description, schemas, annotations). */
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Present when the output schema is an object (MCP requires that for `structuredContent`). */
  readonly outputSchema?: JsonSchema;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
  /** Non-standard: the op name, so a transport can route without a second table. */
  readonly _meta: { readonly 'pixel-forge/op': string; readonly 'pixel-forge/safety': Safety };
}

/** MCP tool definitions of every op not hidden from MCP, sorted by op name. */
export function mcpTools(registry: OpRegistry): McpToolDefinition[] {
  return registry
    .list()
    .filter((op) => op.mcp?.hidden !== true)
    .map((op) => {
      const output = toJsonSchema(op.output, 'output');
      return {
        name: op.mcpName,
        title: op.name,
        description: toolDescription(op),
        inputSchema: opInputSchema(op),
        ...(output.type === 'object' ? { outputSchema: output } : {}),
        annotations: {
          title: op.name,
          readOnlyHint: op.safety === 'read',
          destructiveHint: op.safety === 'destructive',
          openWorldHint: false,
        },
        _meta: { 'pixel-forge/op': op.name, 'pixel-forge/safety': op.safety },
      };
    });
}

/**
 * How a CLI option takes its value: a scalar, or `json` (any JSON value; a word that is not valid
 * JSON is taken as a string, so `--frame 2` and `--frame frm_abc` both work).
 */
export type CliOptionKind = 'string' | 'integer' | 'number' | 'boolean' | 'json';

/** One `--flag` of a generated subcommand: a top-level input field. */
export interface CliOption {
  /** The input field. */
  readonly name: string;
  /** `--kebab-case` of the field. */
  readonly flag: string;
  readonly kind: CliOptionKind;
  readonly required: boolean;
  readonly description?: string;
  /** Allowed values of a string enum. */
  readonly choices?: readonly string[];
}

/** One generated subcommand. */
export interface CliCommand {
  readonly op: string;
  /** Command words after `pf`, e.g. `["rig", "set-pose"]`. */
  readonly command: readonly string[];
  readonly summary: string;
  readonly safety: Safety;
  readonly options: readonly CliOption[];
}

/** The CLI metadata file. */
export interface CliMetadata {
  readonly $comment: string;
  readonly commands: readonly CliCommand[];
}

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function optionKind(prop: JsonSchema): { kind: CliOptionKind; choices?: string[] } {
  if (prop.type === 'string' && Array.isArray(prop.enum)) {
    return { kind: 'string', choices: prop.enum.map(String) };
  }
  switch (prop.type) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return { kind: prop.type };
    default:
      return { kind: 'json' };
  }
}

/** CLI subcommand metadata of every op not hidden from the CLI, sorted by op name. */
export function cliMetadata(registry: OpRegistry): CliMetadata {
  const commands = registry
    .list()
    .filter((op) => op.cli?.hidden !== true)
    .map((op): CliCommand => {
      const schema = opInputSchema(op);
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const options = Object.entries(props).map(([name, prop]): CliOption => {
        const { kind, choices } = optionKind(prop);
        return {
          name,
          flag: `--${kebab(name)}`,
          kind,
          required: required.has(name),
          ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
          ...(choices === undefined ? {} : { choices }),
        };
      });
      return {
        op: op.name,
        command: op.cliCommand,
        summary: op.summary,
        safety: op.safety,
        options,
      };
    });
  return {
    $comment:
      'Generated by `pnpm gen` from the op registry (packages/ops). Do not edit. Option kind "json" takes any JSON value; a word that is not valid JSON is a string.',
    commands,
  };
}

/** What each error code means, for `OPERATIONS.md`. */
const ERROR_TEXT: Readonly<Record<OpErrorCode, string>> = {
  BAD_INPUT: 'The input fails the schema (`details.issues`: `{path, message}`).',
  UNKNOWN_OP: 'No op of that name.',
  NOT_FOUND: 'A reference does not resolve (`details.kind`, `details.ref`, `details.available`).',
  AMBIGUOUS: 'A name matches several entities (`details.candidates`); pass an id.',
  CONFIRM_REQUIRED: 'A destructive op was called without `"confirm": true`.',
  REFUSED: 'The document state refuses the request (`details.reason`).',
  INVALID_VALUE: 'A value the document model rejects (`details.reason` when known).',
  NOT_ALLOWED: 'A path outside the workspace roots.',
  DOC_LOCKED: 'Another process owns the document (`details.pid`).',
  CONFLICT: 'Clashes with the host state or the history.',
  BAD_FILE: 'The file cannot be read as what it claims to be (`details.cause`).',
  IO_FAILED: 'A file system call failed.',
  NOT_IMPLEMENTED: 'Not built yet.',
  INTERNAL: 'A bug; nothing was changed.',
};

const SAFETY_TEXT: Readonly<Record<Safety, string>> = {
  read: 'Changes nothing.',
  mutate: 'One transaction on one document = one undo step, labelled `AI: <op>`.',
  destructive: 'Like `mutate`, and the caller must pass `"confirm": true`.',
  io: 'Reads or writes files through the host ports; may change its document once (one undo step).',
};

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A short type label of a JSON Schema node for the field tables. */
export function typeLabel(schema: JsonSchema): string {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).map(typeLabel).join(' \\| ');
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' \\| ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const type = schema.type;
  if (type === 'array' && typeof schema.items === 'object' && schema.items !== null) {
    return `${typeLabel(schema.items as JsonSchema)}[]`;
  }
  if (type === 'object') {
    if (typeof schema.additionalProperties === 'object' && schema.properties === undefined) {
      return `map of ${typeLabel(schema.additionalProperties as JsonSchema)}`;
    }
    const keys = Object.keys(schema.properties ?? {});
    return keys.length === 0 ? 'object' : `{${keys.join(', ')}}`;
  }
  if (type === 'integer') {
    const min = typeof schema.minimum === 'number' ? ` >= ${String(schema.minimum)}` : '';
    return `integer${min}`;
  }
  return typeof type === 'string' ? type : 'any';
}

function fieldTable(schema: JsonSchema): string[] {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const rows = Object.entries(props).map(
    ([name, p]) =>
      `| \`${name}\` | ${typeLabel(p)} | ${required.has(name) ? 'yes' : 'no'} | ${cell(typeof p.description === 'string' ? p.description : '')} |`,
  );
  if (rows.length === 0) return ['(no fields)'];
  return ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows];
}

/** `docs/contracts/OPERATIONS.md`: every op with its schemas, safety and examples. */
export function operationsMarkdown(registry: OpRegistry): string {
  const ops = registry.list();
  const lines: string[] = [
    '# Operations',
    '',
    '<!-- Generated by `pnpm gen` from the op registry (packages/ops/src/ops). Do not edit; `pnpm gen:check` fails when stale. -->',
    '',
    'The operation API (spec 6.3, ADR-003): every mutation and query of a document goes through these ops, over MCP, the CLI, `pf check` and (M2) `__pf.run`. Contract: additive changes only.',
    '',
    `${CONVENTIONS} References: animations by \`{"group", "direction"}\` or \`{"id"}\`, frames by 0-based index or id, layers, bones, parts, views and variants by name or id (an id match wins; an ambiguous name is \`AMBIGUOUS\`).`,
    '',
    '## Results',
    '',
    'A call returns `{"ok": true, "op", "output", "doc"?, "warnings"?}` or `{"ok": false, "op", "error"}`. `doc` is `{id, version, undoEntry, canUndo, canRedo}` for ops on a document. `warnings` (present only when non-empty) lists problems that happened **after** the change was committed, such as a change listener of the document throwing: the op succeeded, the change is applied and in `doc.undoEntry`.',
    '',
    'Over MCP (`pf mcp`, `tools/list` carries no `outputSchema`) a success is that envelope as compact JSON in a text block; an output with a top-level `image` also returns an `image` content block and its `data` is left out of the text. A failure is a tool result with `isError: true` whose text is the error object `{"code", "message", "details"}`; it is never a protocol error.',
    '',
    '## Safety classes',
    '',
    '| Class | Meaning |',
    '| --- | --- |',
    ...(['read', 'mutate', 'destructive', 'io'] as const).map(
      (s) => `| \`${s}\` | ${SAFETY_TEXT[s]} |`,
    ),
    '',
    '## Errors',
    '',
    'Every failure is `{"code", "message", "details"}`, identical on every transport.',
    '',
    '| Code | Meaning |',
    '| --- | --- |',
    ...OP_ERROR_CODES.map((c) => `| \`${c}\` | ${ERROR_TEXT[c]} |`),
    '',
    '## Index',
    '',
    '| Op | Safety | MCP tool | CLI | Summary |',
    '| --- | --- | --- | --- | --- |',
    ...ops.map(
      (op) =>
        `| [\`${op.name}\`](#${op.name.replace(/\./g, '').toLowerCase()}) | ${op.safety} | ${op.mcp?.hidden === true ? '-' : `\`${op.mcpName}\``} | ${op.cli?.hidden === true ? '-' : `\`pf ${op.cliCommand.join(' ')}\``} | ${cell(op.summary)} |`,
    ),
  ];
  for (const op of ops) {
    lines.push('', `## ${op.name}`, '', op.summary, '');
    if (op.description !== undefined) lines.push(op.description.trim(), '');
    lines.push(
      `- Safety: \`${op.safety}\`${op.transactional ? '' : op.safety === 'mutate' || op.safety === 'destructive' ? ' (manages the history itself, no transaction)' : ''}`,
      `- MCP tool: ${op.mcp?.hidden === true ? '(hidden)' : `\`${op.mcpName}\``}`,
      `- CLI: ${op.cli?.hidden === true ? '(hidden)' : `\`pf ${op.cliCommand.join(' ')}\``}`,
      '',
      '### Input',
      '',
      ...fieldTable(opInputSchema(op)),
      '',
      '### Output',
      '',
      ...fieldTable(toJsonSchema(op.output, 'output')),
      '',
      '### Examples',
    );
    for (const ex of op.examples) {
      lines.push(
        '',
        `${ex.title}:`,
        '',
        '```json',
        JSON.stringify(exampleInput(op, ex.input)),
        '```',
      );
      if (ex.output !== undefined) {
        lines.push('', 'Output:', '', '```json', JSON.stringify(ex.output), '```');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** One generated file: a repo-relative path and its content (JSON is formatted by the script). */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/** Repo-relative output paths of the generators. */
export const GENERATED_PATHS = {
  mcpTools: 'packages/ops/generated/mcp-tools.json',
  cli: 'packages/ops/generated/cli.json',
  operations: 'docs/contracts/OPERATIONS.md',
} as const;

/** Every generated file of a registry. */
export function generatedFiles(registry: OpRegistry): GeneratedFile[] {
  return [
    { path: GENERATED_PATHS.mcpTools, content: `${JSON.stringify(mcpTools(registry), null, 2)}\n` },
    { path: GENERATED_PATHS.cli, content: `${JSON.stringify(cliMetadata(registry), null, 2)}\n` },
    { path: GENERATED_PATHS.operations, content: operationsMarkdown(registry) },
  ];
}
