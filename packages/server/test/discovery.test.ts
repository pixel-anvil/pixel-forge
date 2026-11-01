import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  discoverServer,
  parseServerInfo,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
} from '../src/index.js';
import { deadPid, tempDir } from './helpers.js';

const info = (pid: number) => ({ pid, port: 51234, token: 'abc123', protocolVersion: 1 });

describe('server.json discovery', () => {
  it('writes {pid, port, token, protocolVersion} privately and reads it back', async () => {
    const base = tempDir();
    await writeServerInfo(base, info(process.pid));
    expect(JSON.parse(readFileSync(serverInfoPath(base), 'utf8'))).toEqual(info(process.pid));
    expect(statSync(serverInfoPath(base)).mode & 0o077).toBe(0); // the token is not world-readable
    expect(await readServerInfo(base)).toEqual(info(process.pid));
    expect(await discoverServer(base)).toEqual(info(process.pid));
    await writeServerInfo(base, { ...info(process.pid), port: 1 }); // replaces
    expect((await readServerInfo(base))?.port).toBe(1);
  });

  it('finds nothing when the file is missing, and creates the base folder when writing', async () => {
    const base = tempDir();
    expect(await discoverServer(base)).toBeUndefined();
    expect(await removeServerInfo(base)).toBe(false);
    await writeServerInfo(`${base}/new/dir`, info(process.pid));
    expect(existsSync(`${base}/new/dir/server.json`)).toBe(true);
  });

  it('detects a stale entry by pid and removes it', async () => {
    const base = tempDir();
    await writeServerInfo(base, info(await deadPid()));
    expect((await readServerInfo(base))?.token).toBe('abc123'); // raw read does not judge
    expect(await discoverServer(base, { removeStale: false })).toBeUndefined();
    expect(existsSync(serverInfoPath(base))).toBe(true);
    expect(await discoverServer(base)).toBeUndefined();
    expect(existsSync(serverInfoPath(base))).toBe(false);
  });

  it('treats an invalid file as stale', async () => {
    const base = tempDir();
    writeFileSync(serverInfoPath(base), '{"pid":1,"port":99999,"token":"t","protocolVersion":1}');
    expect(await readServerInfo(base)).toBeUndefined();
    expect(await discoverServer(base)).toBeUndefined();
    expect(existsSync(serverInfoPath(base))).toBe(false);
    for (const bad of ['', 'x', '1', '{"pid":1,"port":2,"token":"","protocolVersion":1}']) {
      expect(parseServerInfo(bad)).toBeUndefined();
    }
  });

  it('removes only its own entry when given a pid', async () => {
    const base = tempDir();
    await writeServerInfo(base, info(process.pid));
    expect(await removeServerInfo(base, { pid: process.pid + 1 })).toBe(false);
    expect(existsSync(serverInfoPath(base))).toBe(true);
    expect(await removeServerInfo(base, { pid: process.pid })).toBe(true);
    expect(existsSync(serverInfoPath(base))).toBe(false);
  });

  it('maps a failed write to IO_FAILED', async () => {
    const base = tempDir();
    writeFileSync(`${base}/file`, 'x');
    await expect(writeServerInfo(`${base}/file`, info(1))).rejects.toMatchObject({
      code: 'IO_FAILED',
    });
  });
});
