/**
 * The MCP server (spec 6.5, FR-AI-10..15): the registry's ops as MCP tools, the open documents as
 * resources, on the official SDK's low-level `Server` (tool schemas are already JSON Schema).
 *
 * - **Tools.** `tools/list` is `mcpTools(registry)` without `outputSchema`; `tools/call` routes by
 *   the `_meta['pixel-forge/op']` of the definition through `registry.call`, so every call is one
 *   transaction, one undo entry labelled `AI: <op name>` (none when it changes nothing). Calls run
 *   one at a time, in arrival order. An op failure, an unknown tool and a forwarded call are tool
 *   results with `isError: true` and the `OpError` JSON as text; nothing here throws a protocol error.
 * - **Tool groups** (TG.1). `options.tools` lists only some groups (default all, nothing changes);
 *   see `mcp-groups.ts`. A call to a tool of a hidden group fails with `REFUSED` naming the group.
 * - **Forwarding.** At startup {@link discoverServer} looks for a running `pf serve`. If one speaks
 *   {@link SERVER_PROTOCOL_VERSION}, calls return `NOT_IMPLEMENTED` until M2; otherwise the documents
 *   are hosted in this process.
 * - **stdout belongs to the protocol.** Nothing here writes to it. The optional trace sink receives
 *   one JSON line per tool call and is the caller's to point at stderr or a file.
 * - **Shutdown.** Closing the transport (a client that goes away closes stdin) disposes the host,
 *   which closes the documents and releases the lockfiles. Signals are the CLI's (`pf mcp`).
 * @packageDocumentation
 */
/* eslint-disable @typescript-eslint/no-deprecated -- `Server` is deprecated in favour of `McpServer`, which wants a zod schema per tool; ours are JSON Schema generated from the registry (ADR-003), the advanced use case the SDK keeps `Server` for. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CONVENTIONS, OpError, TOOL_GROUPS, mcpTools, toOpError } from '@pixel-forge/ops';
import type {
  McpToolDefinition,
  OpErrorJson,
  OpHost,
  OpRegistry,
  ToolGroup,
} from '@pixel-forge/ops';
import type { Readable, Writable } from 'node:stream';
import { SERVER_PROTOCOL_VERSION, discoverServer } from './discovery.js';
import type { ServerInfo } from './discovery.js';
import { defaultBaseDir } from './lockfile.js';
import {
  FIND_TOOL_TOOL,
  META_TOOLS,
  TOOL_GROUPS_TOOL,
  createGroupState,
  groupInstructions,
  groupOf,
  hiddenToolError,
  runFindTool,
  runToolGroups,
} from './mcp-groups.js';
import { RESOURCE_TEMPLATES, listResources, readResource } from './mcp-resources.js';
import { errorResult, listedTools, opOfTool, toToolResult } from './mcp-tools.js';
import type { ListedTool, ToolResult } from './mcp-tools.js';

/** The host an MCP server runs against: a `DocumentHost`, or any {@link OpHost} (tests). */
export type McpHost = OpHost & {
  /** The base folder for discovery, when the host has one (`DocumentHost` does). */
  readonly baseDir?: string;
  /** Closes the documents and releases the locks; called when the transport closes. */
  dispose?(): Promise<void>;
};

/** Receives one trace record per tool call, as one line of JSON (no trailing newline). */
export type TraceSink = (line: string) => void;

/** Options of {@link createMcpServer}. */
export interface McpServerOptions {
  /** The documents the tools work on. Its `dispose()`, if any, runs when the transport closes. */
  readonly host: McpHost;
  /** The ops to serve (normally the built-in `registry`). */
  readonly registry: OpRegistry;
  /**
   * Trace sink; default none. One JSON line per tool call: `{at, tool, op, ms, ok, ...}` with
   * `undoEntry` and `doc` on success and `code` on failure. It never contains tool input or image
   * data. A sink that throws is ignored.
   */
  readonly trace?: TraceSink;
  /**
   * Base folder for `server.json` discovery; default the host's `baseDir`, else `~/.pixel-forge`.
   * Tests inject a temporary folder.
   */
  readonly baseDir?: string;
  /** Millisecond timer for the trace; default `performance.now`. */
  readonly now?: () => number;
  /**
   * The tool groups `tools/list` shows at startup; default every group (nothing changes for a
   * client). With fewer, the server also lists `tool_groups` and `find_tool`, sends
   * `notifications/tools/list_changed` when `tool_groups` switches a group, and a call to a hidden
   * tool fails with a message that names its group.
   */
  readonly tools?: readonly ToolGroup[];
  /** Server name and version reported to clients; default `pixel-forge` `0.0.0`. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

/** A running MCP server. */
export interface McpServerHandle {
  /** The SDK server: `connect` it to any transport. */
  readonly server: Server;
  /** The `pf serve` this server forwards to (calls return `NOT_IMPLEMENTED`), or `undefined`. */
  readonly forwardedTo: ServerInfo | undefined;
  /** The tool definitions served (`mcpTools(registry)`, with `outputSchema`). */
  readonly tools: readonly McpToolDefinition[];
  /** Resolves when the connection has closed and the host has been disposed. */
  readonly closed: Promise<void>;
  /**
   * Waits for running calls, closes the transport and disposes the host (closing the documents and
   * releasing the locks). Safe to call more than once and after the peer has gone.
   */
  close(): Promise<void>;
}

/** Sent once at initialize: what every tool shares, so tool descriptions do not repeat it. */
export const INSTRUCTIONS =
  `${CONVENTIONS} ` +
  'pixel-forge edits .pxf pixel-art documents with rigs and animations. Start with doc_open (or doc_create) and doc_summary; ' +
  'the names in the summary are what the other tools take. Edits apply directly, one undo step each, labelled "AI: <op>": use undo to revert. ' +
  'Clients prefix tool names (mcp__pf__undo): tools here are named without the prefix. ' +
  'Destructive tools need "confirm": true. Check results with render_frame / render_contact_sheet (vision) and lint / rig_joint_check (precision). ' +
  'Files are limited to the workspace roots. Resources: pf://docs and pf://doc/{id}/summary|palette|rig|animations/{group}/{direction}.';

/** The instructions for a server that starts with the groups `initial` (see {@link INSTRUCTIONS}). */
export function instructionsFor(initial: readonly ToolGroup[] = TOOL_GROUPS): string {
  return `${INSTRUCTIONS} ${groupInstructions(initial)}`;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Creates the MCP server. Looks for a running `pf serve` (see the module comment) and wires the
 * tool and resource handlers; the result is not connected yet.
 *
 * Closing the connection (for any transport) disposes `options.host`.
 */
export async function createMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const { host, registry, trace } = options;
  const now = options.now ?? ((): number => performance.now());
  const baseDir = options.baseDir ?? host.baseDir ?? defaultBaseDir();
  const found = await discoverServer(baseDir);
  const forwardedTo = found?.protocolVersion === SERVER_PROTOCOL_VERSION ? found : undefined;

  const definitions = mcpTools(registry);
  const byTool = new Map(definitions.map((d) => [d.name, d]));
  const initial = TOOL_GROUPS.filter((g) => (options.tools ?? TOOL_GROUPS).includes(g));
  const groups = createGroupState(initial);
  const listedAll = listedTools(definitions);
  // `listedTools` keeps the order of `definitions`, so the two arrays line up.
  const entries = listedAll.map((tool, i) => ({
    tool,
    group: groupOf(definitions[i] ?? fail('tool list out of step')),
  }));
  const visible = (): ListedTool[] => entries.filter((e) => groups.has(e.group)).map((e) => e.tool);
  // Only a server that hides something has `tool_groups` and `find_tool`: the default list is unchanged.
  const restricted = initial.length < TOOL_GROUPS.length;
  const clash = definitions.find((d) => [TOOL_GROUPS_TOOL, FIND_TOOL_TOOL].includes(d.name));
  if (clash !== undefined) throw new Error(`the op tool name ${clash.name} is reserved`);

  const server = new Server(options.serverInfo ?? { name: 'pixel-forge', version: '0.0.0' }, {
    capabilities: { tools: restricted ? { listChanged: true } : {}, resources: {} },
    instructions: instructionsFor(initial),
  });

  const emit = (record: Record<string, unknown>): void => {
    if (trace === undefined) return;
    try {
      trace(JSON.stringify(record));
    } catch {
      // a broken sink must not break the protocol
    }
  };

  // One call at a time, in arrival order: io ops are async and must not interleave on a document.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const result = tail.then(f);
    tail = result.catch(() => undefined);
    return result;
  };

  const callTool = async (name: string, args: unknown): Promise<ToolResult> => {
    const started = now();
    const at = host.clock.now().toISOString();
    const definition = byTool.get(name);
    const op = definition === undefined ? null : opOfTool(definition);
    const meta = restricted && (name === TOOL_GROUPS_TOOL || name === FIND_TOOL_TOOL);
    const doc =
      typeof args === 'object' && args !== null && 'doc' in args && typeof args.doc === 'string'
        ? args.doc
        : undefined;
    let result: ToolResult;
    let code: string | undefined;
    let undoEntry: number | null | undefined;
    const traceRecord = (): Record<string, unknown> => ({
      at,
      tool: name,
      op,
      ...(doc === undefined ? {} : { doc }),
      ms: Math.round((now() - started) * 100) / 100,
      ok: code === undefined,
      ...(code === undefined ? {} : { code }),
      ...(undoEntry === undefined ? {} : { undoEntry }),
    });
    try {
      if (meta) {
        if (name === FIND_TOOL_TOOL) {
          result = runFindTool(args, groups, definitions);
        } else {
          const outcome = runToolGroups(args, groups, definitions);
          result = outcome.result;
          // Many clients ignore this; `--tools` and the `added` list in the result are the fallback.
          if (outcome.changed) server.sendToolListChanged().catch(() => undefined);
        }
        if (result.isError === true) code = 'BAD_INPUT';
        emit(traceRecord());
        return result;
      }
      if (definition === undefined || op === null) {
        throw new OpError('UNKNOWN_OP', `no tool named ${JSON.stringify(name)}`, {
          name,
          available: visible().map((t) => t.name),
        });
      }
      if (!groups.has(groupOf(definition))) {
        throw hiddenToolError(name, groupOf(definition), groups.enabled());
      }
      if (forwardedTo !== undefined) {
        throw new OpError(
          'NOT_IMPLEMENTED',
          `a pf serve process (pid ${String(forwardedTo.pid)}) is running; forwarding calls to it arrives with M2. Stop it to edit documents from this server`,
          { reason: 'forwarding', pid: forwardedTo.pid },
        );
      }
      const called = await registry.call(op, args ?? {}, { host });
      result = toToolResult(called);
      if (called.ok) undoEntry = called.doc?.undoEntry;
      else code = called.error.code;
    } catch (e) {
      const error: OpErrorJson = toOpError(e).toJSON();
      result = errorResult(error);
      code = error.code;
    }
    emit(traceRecord());
    return result;
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...visible(), ...(restricted ? META_TOOLS : [])],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    serial(() => callTool(request.params.name, request.params.arguments)),
  );

  const resources = { host, registry, forwarding: forwardedTo !== undefined };
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await serial(() => Promise.resolve(listResources(resources))),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [...RESOURCE_TEMPLATES],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    serial(() => readResource(resources, request.params.uri)),
  );

  let disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposed ??= serial(async () => {
      try {
        await host.dispose?.();
      } catch (e) {
        emit({ at: host.clock.now().toISOString(), event: 'dispose-failed', message: String(e) });
      }
    });
    return disposed;
  };

  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  server.onclose = () => {
    void dispose().then(markClosed);
  };

  return {
    server,
    forwardedTo,
    tools: definitions,
    closed,
    async close() {
      await tail; // let a running call send its answer first
      await new Promise<void>((resolve) => setImmediate(resolve));
      await server.close().catch(() => undefined);
      await dispose();
      markClosed();
    },
  };
}

/** Options of {@link serveStdio}. */
export interface ServeStdioOptions extends McpServerOptions {
  /** Input stream; default `process.stdin`. */
  readonly stdin?: Readable;
  /** Output stream (protocol only); default `process.stdout`. */
  readonly stdout?: Writable;
}

/**
 * Serves MCP over stdio (what `pf mcp` runs): creates the server and connects it to the input and
 * output streams. The returned handle's `closed` resolves when stdin ends (the client went away)
 * or `close()` is called; either way the host has been disposed by then. Signal handling is the
 * caller's: call `handle.close()` on SIGINT and SIGTERM.
 */
export async function serveStdio(options: ServeStdioOptions): Promise<McpServerHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const handle = await createMcpServer(options);
  const stop = (): void => {
    void handle.close();
  };
  // StdioServerTransport does not notice the end of its input.
  stdin.once('end', stop);
  stdin.once('close', stop);
  stdout.once('error', stop);
  await handle.server.connect(new StdioServerTransport(stdin, stdout));
  return handle;
}
