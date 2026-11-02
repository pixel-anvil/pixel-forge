import type { Readable, Writable } from 'node:stream';

/** The signals `pf mcp` listens for. */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

/** Where signals come from: `process` in the binary, an `EventEmitter` in tests. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Everything the CLI touches outside its own arguments, so tests can run it in process. Every
 * field defaults to the real process (see {@link resolveEnv}).
 */
export interface CliEnv {
  /** Standard output: results (JSON) and, for `pf mcp`, the protocol and nothing else. */
  readonly stdout: Writable;
  /** Standard error: diagnostics, errors and traces. */
  readonly stderr: Writable;
  /** Standard input (the MCP client's messages). */
  readonly stdin: Readable;
  /** Working directory: base of relative paths and the default workspace root. */
  readonly cwd: string;
  /** Environment variables (`PF_WORKSPACE_ROOTS`, `PF_HOME`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Source of SIGINT and SIGTERM. */
  readonly signals: SignalSource;
  /** Ends the process at once; called by `pf mcp` after a signal. */
  readonly exit: (code: number) => void;
}

/** Fills the gaps of a partial environment with the real process. */
export function resolveEnv(partial: Partial<CliEnv> = {}): CliEnv {
  return {
    stdout: partial.stdout ?? process.stdout,
    stderr: partial.stderr ?? process.stderr,
    stdin: partial.stdin ?? process.stdin,
    cwd: partial.cwd ?? process.cwd(),
    env: partial.env ?? process.env,
    signals: partial.signals ?? process,
    exit: partial.exit ?? ((code) => process.exit(code)),
  };
}

/** Thrown for a mistake in how the command was used; the shell reports it and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Writes `value` as one line of compact JSON. */
export function writeJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}
