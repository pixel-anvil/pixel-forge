import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseToolGroups, registry } from '@pixel-forge/ops';
import type { ToolGroup } from '@pixel-forge/ops';
import { serveStdio } from '@pixel-forge/server';
import type { TraceSink } from '@pixel-forge/server';
import { UsageError } from './env.js';
import type { CliEnv, ShutdownSignal } from './env.js';
import { openHost } from './host.js';
import type { HostFlags } from './host.js';
import { VERSION } from './version.js';

/** Flags of `pf mcp`. */
export interface McpFlags extends HostFlags {
  /** `--trace`: `true` writes to stderr, a string is a file to append to. */
  readonly trace?: string | boolean;
  /** `--tools core,rig`: the tool groups to list; default `PF_TOOLS`, else every group. */
  readonly tools?: string;
}

/** The environment variable that sets the listed tool groups when `--tools` is absent. */
export const TOOLS_ENV = 'PF_TOOLS';

/**
 * The groups to list: `--tools`, else `PF_TOOLS`, else `undefined` (all). A blank value counts as
 * absent. Throws {@link UsageError} (exit 2) for an unknown group.
 */
export function resolveTools(
  env: CliEnv,
  flag: string | undefined,
): readonly ToolGroup[] | undefined {
  const fromFlag = flag !== undefined && flag.trim() !== '';
  const text = fromFlag ? flag : env.env[TOOLS_ENV];
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return parseToolGroups(text);
  } catch (e) {
    const where = fromFlag ? '--tools' : TOOLS_ENV;
    throw new UsageError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const SIGNALS: readonly ShutdownSignal[] = ['SIGINT', 'SIGTERM'];

function traceSink(env: CliEnv, trace: string | boolean | undefined): TraceSink | undefined {
  if (trace === undefined || trace === false) return undefined;
  if (trace === true) return (line) => env.stderr.write(`${line}\n`);
  const file = resolve(env.cwd, trace);
  return (line) => {
    appendFileSync(file, `${line}\n`);
  };
}

/**
 * `pf mcp`: serves MCP over stdin and stdout until the client goes away or a signal arrives.
 *
 * - `--tools core,rig` (or `PF_TOOLS`) lists only those tool groups; the default is every group.
 * - stdout carries the protocol only; the trace goes to stderr or a file, never stdout.
 * - SIGINT and SIGTERM close the server (waits for the running call, disposes the host, releases
 *   the lockfiles) and then exit 0. A second signal, or a close that fails, exits 1 at once.
 *
 * Resolves with the exit code when the connection ended without a signal (stdin closed).
 */
export async function runMcp(env: CliEnv, flags: McpFlags): Promise<number> {
  const tools = resolveTools(env, flags.tools);
  const host = openHost(env, flags);
  const trace = traceSink(env, flags.trace);
  const handle = await serveStdio({
    host,
    registry,
    stdin: env.stdin,
    stdout: env.stdout,
    serverInfo: { name: 'pixel-forge', version: VERSION },
    ...(tools === undefined ? {} : { tools }),
    ...(trace === undefined ? {} : { trace }),
  });

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      env.exit(1);
      return;
    }
    stopping = true;
    handle.close().then(
      () => {
        env.exit(0);
      },
      (error: unknown) => {
        env.stderr.write(
          `pf mcp: closing failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        env.exit(1);
      },
    );
  };
  for (const signal of SIGNALS) env.signals.on(signal, onSignal);
  try {
    await handle.closed;
  } finally {
    for (const signal of SIGNALS) env.signals.off(signal, onSignal);
  }
  return 0;
}
