// `pf mcp`: as a real process (the bundle) and in process with fake signals.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { lockFilePath } from '@pixel-forge/server';
import { execa } from 'execa';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveEnv, runCli, runMcp } from '../src/index.js';
import type { ShutdownSignal } from '../src/index.js';
import { ensureBundle, later, tempDir, workspace } from './helpers.js';

interface Message {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
};
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, name: string, args: object): object => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** Collects newline-delimited JSON from a stream and lets a test wait for a response id. */
function lineReader(stream: NodeJS.ReadableStream): {
  lines: string[];
  response(id: number): Promise<Message>;
} {
  const lines: string[] = [];
  const waiting = new Map<number, (m: Message) => void>();
  const seen = new Map<number, Message>();
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line) as Message;
      if (msg.id === undefined) continue;
      const waiter = waiting.get(msg.id);
      if (waiter === undefined) seen.set(msg.id, msg);
      else waiter(msg);
    }
  });
  return {
    lines,
    response: (id) =>
      new Promise((resolve) => {
        const early = seen.get(id);
        if (early === undefined) waiting.set(id, resolve);
        else resolve(early);
      }),
  };
}

const text = (m: Message): { ok?: boolean } =>
  JSON.parse(((m.result?.content as { text: string }[])[0] as { text: string }).text) as {
    ok?: boolean;
  };

let bundle = '';
beforeAll(() => {
  bundle = ensureBundle();
});

describe('pf mcp as a real process', () => {
  it('serves a tool call, traces to a file, and a SIGTERM closes it and releases the lock', async () => {
    const w = workspace();
    const trace = join(w.work, 'trace.jsonl');
    const proc = execa(
      'node',
      [bundle, 'mcp', '--root', w.work, '--home', w.home, '--trace', trace],
      { cwd: tempDir(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', reject: false },
    );
    later(async () => {
      proc.kill('SIGKILL');
      await proc;
    });
    const out = lineReader(proc.stdout);
    const send = (m: object): void => {
      proc.stdin.write(`${JSON.stringify(m)}\n`);
    };

    send(initialize);
    const init = await out.response(1);
    expect(init.result).toMatchObject({ serverInfo: { name: 'pixel-forge' } });
    send(initialized);
    send(call(2, 'doc_open', { path: w.hero }));
    expect(text(await out.response(2)).ok).toBe(true);
    const lock = lockFilePath(w.home, w.hero);
    expect(existsSync(lock)).toBe(true);

    proc.kill('SIGTERM');
    const result = await proc;
    expect(result.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);

    // stdout: protocol only
    expect(out.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of out.lines) expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0');
    // the trace went to the file, not to stdout or stderr
    const traced = readFileSync(trace, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { tool: string; ok: boolean });
    expect(traced.map((t) => [t.tool, t.ok])).toEqual([['doc_open', true]]);
    expect(result.stderr).toBe('');
  });

  it('exits 0 and releases the lock when stdin closes; --trace without a file uses stderr', async () => {
    const w = workspace();
    const proc = execa('node', [bundle, 'mcp', '--root', w.work, '--home', w.home, '--trace'], {
      cwd: tempDir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });
    later(async () => {
      proc.kill('SIGKILL');
      await proc;
    });
    const out = lineReader(proc.stdout);
    proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n`);
    await out.response(1);
    proc.stdin.write(`${JSON.stringify(call(2, 'doc_open', { path: w.hero }))}\n`);
    await out.response(2);
    proc.stdin.end();
    const result = await proc;
    expect(result.exitCode).toBe(0);
    expect(existsSync(lockFilePath(w.home, w.hero))).toBe(false);
    expect(
      result.stderr
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { tool: string }),
    ).toMatchObject([{ tool: 'doc_open' }]);
    for (const line of out.lines) expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0');
  });
});

/** Starts `pf mcp` with `args` and `env`, asks `tools/list`, and stops it. */
async function listTools(args: string[], env: Record<string, string>): Promise<string[]> {
  const w = workspace();
  const proc = execa('node', [bundle, 'mcp', '--root', w.work, '--home', w.home, ...args], {
    cwd: tempDir(),
    env,
    extendEnv: false,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
  });
  later(async () => {
    proc.kill('SIGKILL');
    await proc;
  });
  const out = lineReader(proc.stdout);
  proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n`);
  await out.response(1);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const reply = await out.response(2);
  proc.stdin.end();
  await proc;
  return (reply.result?.tools as { name: string }[]).map((t) => t.name);
}

describe('pf mcp --tools / PF_TOOLS (real process)', () => {
  const nodeEnv = { PATH: process.env.PATH ?? '' };

  it('lists every group by default, only the chosen groups with --tools or PF_TOOLS', async () => {
    const all = await listTools([], nodeEnv);
    expect(all).toContain('rig_set_pose');
    expect(all).not.toContain('find_tool');

    const core = await listTools(['--tools', 'core'], nodeEnv);
    expect(core).toContain('doc_open');
    expect(core).toContain('find_tool');
    expect(core).toContain('tool_groups');
    expect(core.some((n) => n.startsWith('rig_'))).toBe(false);

    const fromEnv = await listTools([], { ...nodeEnv, PF_TOOLS: 'core' });
    expect(fromEnv).toEqual(core);
    // the flag wins over the variable
    const flagWins = await listTools(['--tools', 'core,rig,palette'], {
      ...nodeEnv,
      PF_TOOLS: 'core',
    });
    expect(flagWins).toEqual(all);
  });
});

describe('resolveTools', () => {
  it('prefers the flag, then PF_TOOLS, blank means all, and a bad group is a usage error', async () => {
    const run = async (argv: string[], env: Record<string, string>): Promise<[number, string]> => {
      const stderr = new PassThrough();
      let text = '';
      stderr.on('data', (c: Buffer) => (text += c.toString()));
      const code = await runCli(argv, {
        stderr,
        env,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      });
      return [code, text];
    };
    const [flagCode, flagText] = await run(['mcp', '--tools', 'core,nope'], {});
    expect(flagCode).toBe(2);
    expect(flagText).toContain('--tools: unknown tool group "nope"');
    const [envCode, envText] = await run(['mcp'], { PF_TOOLS: 'bogus' });
    expect(envCode).toBe(2);
    expect(envText).toContain('PF_TOOLS: unknown tool group "bogus"');
  });
});

/** A signal source tests can fire. */
class FakeSignals extends EventEmitter {
  fire(signal: ShutdownSignal): void {
    this.emit(signal);
  }
}

describe('runMcp (in process)', () => {
  async function start(): Promise<{
    signals: FakeSignals;
    exit: ReturnType<typeof vi.fn>;
    finished: Promise<number>;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    lines: ReturnType<typeof lineReader>;
    work: string;
    hero: string;
  }> {
    const w = workspace();
    const signals = new FakeSignals();
    const exit = vi.fn();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines = lineReader(stdout);
    const env = resolveEnv({
      stdin,
      stdout,
      stderr,
      cwd: w.work,
      env: { PF_HOME: w.home },
      signals,
      exit,
    });
    const finished = runMcp(env, { root: [w.work] });
    stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n`);
    await lines.response(1);
    return { signals, exit, finished, stdin, stdout, stderr, lines, work: w.work, hero: w.hero };
  }

  it('closes on SIGINT and exits 0; a second signal exits 1 at once', async () => {
    const s = await start();
    s.signals.fire('SIGINT');
    await s.finished;
    expect(s.exit).toHaveBeenCalledWith(0);
    expect(s.signals.listenerCount('SIGINT')).toBe(0);
    expect(s.signals.listenerCount('SIGTERM')).toBe(0);

    const t = await start();
    t.signals.fire('SIGTERM');
    t.signals.fire('SIGTERM');
    expect(t.exit).toHaveBeenCalledWith(1);
    await t.finished;
  });
});
