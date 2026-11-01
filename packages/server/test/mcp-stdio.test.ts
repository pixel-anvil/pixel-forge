// MCP over stdio: in-process through stream pairs, and as a real subprocess (the style of the T5.4
// two-process tests): stdout carries only protocol, and closing stdin releases the lockfile.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { registry } from '@pixel-forge/ops';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { createDocumentHost, lockFilePath, serveStdio } from '../src/index.js';
import { later, workspace } from './helpers.js';
import { HERO_ID } from './mcp-helpers.js';

const CHILD = fileURLToPath(new URL('./fixtures/mcp-child.mjs', import.meta.url));

interface Message {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  method?: string;
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
const call = (id: number, name: string, args: object) => ({
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

const text = (m: Message): { ok?: boolean; output?: Record<string, unknown> } =>
  JSON.parse(((m.result?.content as { text: string }[])[0] as { text: string }).text) as {
    ok?: boolean;
  };

describe('serveStdio (in process)', () => {
  it('talks newline-delimited JSON-RPC over the given streams and disposes the host on EOF', async () => {
    const { base, root, hero } = workspace();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = createDocumentHost({ baseDir: base, roots: [root], releaseOnExit: false });
    const out = lineReader(stdout);
    const handle = await serveStdio({ host, registry, stdin, stdout });
    later(() => handle.close());

    stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n`);
    const init = await out.response(1);
    expect(init.result).toMatchObject({ serverInfo: { name: 'pixel-forge' } });
    stdin.write(`${JSON.stringify(call(2, 'doc_open', { path: hero }))}\n`);
    expect(text(await out.response(2)).ok).toBe(true);
    expect(existsSync(lockFilePath(base, hero))).toBe(true);
    expect(host.list()).toHaveLength(1);

    stdin.end(); // the client went away
    await handle.closed;
    expect(host.list()).toEqual([]);
    expect(existsSync(lockFilePath(base, hero))).toBe(false);
    expect(out.lines.every((l) => (JSON.parse(l) as Message).jsonrpc === '2.0')).toBe(true);
  });

  it('closes when its output fails', async () => {
    const { base, root } = workspace();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = createDocumentHost({ baseDir: base, roots: [root], releaseOnExit: false });
    const handle = await serveStdio({ host, registry, stdin, stdout });
    stdout.emit('error', new Error('EPIPE'));
    await handle.closed;
  });
});

describe('pf mcp as a real process', () => {
  it('keeps stdout to protocol, traces to stderr, and releases the lock when stdin closes', async () => {
    const { base, root, hero } = workspace();
    const proc = execa('node', [CHILD, base, root], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });
    later(async () => {
      proc.kill();
      await proc;
    });
    const out = lineReader(proc.stdout);
    const send = (m: object): void => {
      proc.stdin.write(`${JSON.stringify(m)}\n`);
    };

    send(initialize);
    await out.response(1);
    send(initialized);
    send(call(2, 'doc_open', { path: hero }));
    const opened = text(await out.response(2));
    expect(opened).toMatchObject({ ok: true, output: { doc: HERO_ID } });
    send(call(3, 'doc_summary', { doc: HERO_ID }));
    expect(text(await out.response(3)).ok).toBe(true);
    send(call(4, 'doc_open', { path: '/etc/hosts' }));
    const refused = await out.response(4);
    expect(refused.result).toMatchObject({ isError: true });

    const lock = lockFilePath(base, hero);
    expect(existsSync(lock)).toBe(true); // held by the child while it runs

    proc.stdin.end();
    const result = await proc;
    expect(result.exitCode).toBe(0);

    // stdout: nothing but JSON-RPC responses, one per line
    expect(out.lines.length).toBeGreaterThanOrEqual(4);
    for (const line of out.lines) {
      expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0');
    }
    // stderr: the trace, one JSON line per tool call, with no protocol on it
    const trace = result.stderr
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { tool: string; ok: boolean });
    expect(trace.map((t) => [t.tool, t.ok])).toEqual([
      ['doc_open', true],
      ['doc_summary', true],
      ['doc_open', false],
    ]);
    // closing disposed the host: the lock is gone although the exit sweep was turned off
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(base, 'locks')).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });
});
