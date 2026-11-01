/**
 * The op registry: looks ops up, validates input, resolves the target document, runs the handler
 * as **one transaction = one undo step** (FR-AI-14, spec W3) and maps every failure to an
 * {@link OpError}. Every transport (MCP, CLI, `pf check`, `__pf.run`) calls ops through it.
 * @packageDocumentation
 */
import type { DocId } from '@pixel-forge/schema';
import type { AnyOp } from './define.js';
import { commitChange } from './commit.js';
import { RunContext, isThenable, silentLogger, swallowRejection } from './context.js';
import type { OpLogger } from './context.js';
import { OpError, inputError, toOpError } from './errors.js';
import type { OpErrorJson } from './errors.js';
import type { HostedDocument, OpHost } from './host.js';
import { MAX_AVAILABLE } from './refs.js';

/** The default history label prefix: MCP edits are labelled `AI: <op>` (FR-AI-14). */
export const DEFAULT_LABEL_PREFIX = 'AI: ';

/** How to run an op. */
export interface RunOptions {
  /** The host whose documents the op works on. */
  readonly host: OpHost;
  /** History label prefix; the label is `<prefix><op name>`. Default {@link DEFAULT_LABEL_PREFIX}. */
  readonly labelPrefix?: string;
  /** Trace logger; default silent. */
  readonly log?: OpLogger;
  /**
   * Refuse (as `INTERNAL`, `reason: 'invalid-document'`) a change that adds `validate()` errors
   * the document did not have before (counted per finding code). Default `true`; a safety net
   * for handlers, not an input check. Only images the call changed get the pixel checks.
   */
  readonly validate?: boolean;
}

/** The document state after a call, for transports to echo. */
export interface DocState {
  readonly id: string;
  /** `store.version` after the call. */
  readonly version: number;
  /** The history entry the call recorded, or `null` (read ops, and changes that were no-ops). */
  readonly undoEntry: number | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** A successful run. */
export interface OpSuccess {
  readonly ok: true;
  readonly op: string;
  /** The output, parsed by the op's output schema. */
  readonly output: unknown;
  /** The target document's state (ops with a `doc` field). */
  readonly doc?: DocState;
  /**
   * Non-fatal problems after the change was committed (present only when there are some): a
   * change listener of the document's store threw. The change is applied and recorded in `doc`;
   * the op did **not** fail.
   */
  readonly warnings?: readonly string[];
}

/** A failed run. */
export interface OpFailure {
  readonly ok: false;
  readonly op: string;
  readonly error: OpErrorJson;
}

/** The envelope {@link OpRegistry.call} returns: never throws. */
export type OpCallResult = OpSuccess | OpFailure;

/** The tagged result of an internal run. */
interface Ran {
  readonly output: unknown;
  readonly document: HostedDocument | undefined;
  readonly entryId: number | undefined;
  readonly warnings: readonly string[];
}

/**
 * A set of ops with unique names, MCP tool names and CLI commands. Immutable; build it with
 * {@link createRegistry}.
 */
export class OpRegistry {
  private readonly ops: ReadonlyMap<string, AnyOp>;
  private readonly tools: ReadonlyMap<string, AnyOp>;

  /** @throws Error on a duplicate op name, MCP tool name or CLI command. */
  constructor(ops: readonly AnyOp[]) {
    const byName = new Map<string, AnyOp>();
    const byTool = new Map<string, AnyOp>();
    const byCommand = new Map<string, AnyOp>();
    for (const op of [...ops].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const command = op.cliCommand.join(' ');
      if (byName.has(op.name)) throw new Error(`duplicate op ${op.name}`);
      const tool = byTool.get(op.mcpName);
      if (tool !== undefined) {
        throw new Error(`MCP tool name ${op.mcpName} of ${op.name} is taken by ${tool.name}`);
      }
      const cmd = byCommand.get(command);
      if (cmd !== undefined) {
        throw new Error(`CLI command "${command}" of ${op.name} is taken by ${cmd.name}`);
      }
      byName.set(op.name, op);
      byTool.set(op.mcpName, op);
      byCommand.set(command, op);
    }
    this.ops = byName;
    this.tools = byTool;
  }

  /** Every op, sorted by name. */
  list(): readonly AnyOp[] {
    return [...this.ops.values()];
  }

  /** The op of this name (`rig.setPose`). */
  get(name: string): AnyOp | undefined {
    return this.ops.get(name);
  }

  /** The op behind an MCP tool name (`rig_set_pose`). */
  byMcpName(tool: string): AnyOp | undefined {
    return this.tools.get(tool);
  }

  /**
   * Runs an op and returns its parsed output.
   * @throws OpError for every failure (see {@link OpErrorCode}).
   */
  async execute(name: string, input: unknown, options: RunOptions): Promise<unknown> {
    return (await this.run(name, input, options)).output;
  }

  /** Runs an op and returns an envelope; never throws (a failure is `{ok: false, error}`). */
  async call(name: string, input: unknown, options: RunOptions): Promise<OpCallResult> {
    try {
      const ran = await this.run(name, input, options);
      const store = ran.document?.store;
      return {
        ok: true,
        op: name,
        output: ran.output,
        ...(ran.document === undefined || store === undefined
          ? {}
          : {
              doc: {
                id: ran.document.id,
                version: store.version,
                undoEntry: ran.entryId ?? null,
                canUndo: store.canUndo,
                canRedo: store.canRedo,
              },
            }),
        ...(ran.warnings.length === 0 ? {} : { warnings: ran.warnings }),
      };
    } catch (e) {
      return { ok: false, op: name, error: toOpError(e).toJSON() };
    }
  }

  private async run(name: string, raw: unknown, options: RunOptions): Promise<Ran> {
    try {
      return await this.runUnmapped(name, raw, options);
    } catch (e) {
      throw toOpError(e);
    }
  }

  private async runUnmapped(name: string, raw: unknown, options: RunOptions): Promise<Ran> {
    const op = this.ops.get(name);
    if (op === undefined) {
      const available = [...this.ops.keys()];
      throw new OpError('UNKNOWN_OP', `no op named ${JSON.stringify(name)}`, {
        name,
        available,
      });
    }
    const input = parseInput(op, raw);
    const { host } = options;
    const document = op.targetsDocument ? resolveDocument(host, input.doc) : undefined;
    const guard = options.validate ?? true;
    const log = options.log ?? silentLogger;
    const ctx = new RunContext({
      op: op.name,
      safety: op.safety,
      host,
      log,
      document,
      label: `${options.labelPrefix ?? DEFAULT_LABEL_PREFIX}${op.name}`,
      guard,
    });

    if (op.transactional && document !== undefined) {
      const tx = document.store.begin(ctx.label);
      ctx.current = tx;
      try {
        const result = op.handler(ctx, input as never);
        if (isThenable(result)) {
          swallowRejection(result);
          throw new OpError('INTERNAL', `${op.name}: a ${op.safety} handler must be synchronous`);
        }
        const output = parseOutput(op, result);
        const { entryId, warnings } = commitChange(op.name, document.store, tx, guard, log);
        return { output, document, entryId, warnings };
      } finally {
        if (tx.isOpen) tx.cancel();
        ctx.current = undefined;
      }
    }

    let result = op.handler(ctx, input as never);
    if (isThenable(result)) {
      if (op.safety !== 'io') {
        swallowRejection(result);
        throw new OpError('INTERNAL', `${op.name}: a ${op.safety} handler must be synchronous`);
      }
      result = await result;
    }
    return {
      output: parseOutput(op, result),
      document,
      entryId: ctx.committedEntry,
      warnings: ctx.warnings,
    };
  }
}

/** Builds a registry from op definitions. */
export function createRegistry(ops: readonly AnyOp[]): OpRegistry {
  return new OpRegistry(ops);
}

/** Parsed input as the registry passes it on; `doc` is present when the op targets a document. */
type ParsedInput = Readonly<Record<string, unknown>> & { readonly doc?: unknown };

/**
 * Parses an op input: a JSON object; for `destructive` ops `confirm` is taken out first and must
 * be `true` (after the rest parsed, so input errors are reported before the confirmation).
 */
function parseInput(op: AnyOp, raw: unknown): ParsedInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OpError('BAD_INPUT', `input for ${op.name} must be a JSON object`, {
      issues: [{ path: '', message: 'expected an object' }],
    });
  }
  let rest = raw as Record<string, unknown>;
  let confirm: unknown;
  if (op.safety === 'destructive') {
    ({ confirm, ...rest } = rest);
  }
  const parsed = op.input.safeParse(rest);
  if (!parsed.success) throw inputError(parsed.error, op.name);
  if (op.safety === 'destructive' && confirm !== true) {
    throw new OpError(
      'CONFIRM_REQUIRED',
      `${op.name} is destructive: call it again with "confirm": true to proceed`,
      { op: op.name },
    );
  }
  return parsed.data;
}

/** The output, parsed by the op's schema; a mismatch is a handler bug (`INTERNAL`). */
function parseOutput(op: AnyOp, result: unknown): unknown {
  const parsed = op.output.safeParse(result);
  if (!parsed.success) {
    throw new OpError('INTERNAL', `${op.name} returned an output that fails its schema`, {
      reason: 'bad-output',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

/** The hosted document of a `doc` input. */
function resolveDocument(host: OpHost, ref: unknown): HostedDocument {
  const id = String(ref);
  const found = host.get(id as DocId);
  if (found !== undefined) return found;
  const open = host.list().map((d) => d.id);
  throw new OpError(
    'NOT_FOUND',
    `document ${id} is not open` +
      (open.length === 0 ? '; open it with doc_open' : `; open documents: ${open.join(', ')}`),
    { kind: 'doc', ref: id, available: open.slice(0, MAX_AVAILABLE) },
  );
}
