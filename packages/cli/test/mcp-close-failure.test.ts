// A close that fails must still end `pf mcp`: the signal handler exits 1 and says why.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as Server from '@pixel-forge/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveEnv, runMcp } from '../src/index.js';
import { tempDir } from './helpers.js';

vi.mock('@pixel-forge/server', async (importOriginal) => {
  const original = await importOriginal<typeof Server>();
  return {
    ...original,
    serveStdio: vi.fn(() => {
      const closed = new Promise<void>(() => undefined); // never resolves: only the signal ends it
      return Promise.resolve({
        closed,
        close: () => Promise.reject(new Error('disk on fire')),
      });
    }),
  };
});

describe('runMcp when closing fails', () => {
  it('writes the reason to stderr and exits 1', async () => {
    const signals = new EventEmitter();
    const exited = new Promise<number>((resolve) => {
      const stderr = new PassThrough();
      let err = '';
      stderr.on('data', (c: Buffer) => (err += c.toString()));
      void runMcp(
        resolveEnv({
          cwd: tempDir(),
          env: { PF_HOME: tempDir() },
          stderr,
          signals,
          exit: (code) => {
            expect(err).toContain('closing failed: disk on fire');
            resolve(code);
          },
        }),
        {},
      );
    });
    await vi.waitFor(() => {
      expect(signals.listenerCount('SIGTERM')).toBe(1);
    });
    signals.emit('SIGTERM');
    expect(await exited).toBe(1);
  });
});
