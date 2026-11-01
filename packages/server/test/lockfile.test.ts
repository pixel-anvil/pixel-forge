import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, isProcessAlive, lockFilePath, parseLockRecord } from '../src/index.js';
import { deadPid, spawnChild, tempDir, workspace } from './helpers.js';

const DOC = '/work/a.pxf';

function plant(base: string, path: string, content: string): string {
  const file = lockFilePath(base, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

async function outcome(p: Promise<unknown>): Promise<{ code?: string; pid?: unknown }> {
  try {
    await p;
    return {};
  } catch (e) {
    const err = e as { code: string; details: { pid?: unknown } };
    return { code: err.code, pid: err.details.pid };
  }
}

describe('lock file naming and records', () => {
  it('is <baseDir>/locks/<sha1(path)>.lock holding {pid, host}', async () => {
    const base = tempDir();
    const sha = createHash('sha1').update(DOC).digest('hex');
    expect(lockFilePath(base, DOC)).toBe(join(base, 'locks', `${sha}.lock`));
    const lock = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    expect(JSON.parse(readFileSync(lock.lockFile, 'utf8'))).toEqual({
      pid: process.pid,
      host: hostname(),
    });
    expect(readdirSync(join(base, 'locks'))).toEqual([`${sha}.lock`]);
    await lock.release();
    expect(readdirSync(join(base, 'locks'))).toEqual([]);
  });

  it('parses only valid records', () => {
    expect(parseLockRecord('{"pid":4,"host":"h"}')).toEqual({ pid: 4, host: 'h' });
    for (const bad of [
      '',
      'nope',
      '[]',
      '{"pid":0,"host":"h"}',
      '{"pid":1.5,"host":"h"}',
      '{"pid":3}',
    ]) {
      expect(parseLockRecord(bad)).toBeUndefined();
    }
  });

  it('knows live and dead pids', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(await deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });
});

describe('acquireLock', () => {
  it('refuses a live owner with its pid, and takes the lock again after release', async () => {
    const base = tempDir();
    const first = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    expect(await outcome(acquireLock({ baseDir: base, path: DOC }))).toEqual({
      code: 'DOC_LOCKED',
      pid: process.pid,
    });
    await first.release();
    await first.release(); // idempotent
    const again = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    await again.release();
  });

  it('reclaims a lock whose owner on this host is dead', async () => {
    const base = tempDir();
    const dead = await deadPid();
    const file = plant(base, DOC, JSON.stringify({ pid: dead, host: hostname() }));
    const lock = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, host: hostname() });
    await lock.release();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dirname(file))).toEqual([]); // no .tmp or .stale leftovers
  });

  it('reclaims a corrupt lockfile', async () => {
    const base = tempDir();
    plant(base, DOC, '{"pid":');
    const lock = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    await lock.release();
  });

  it('never reclaims a lock of another host, even with a dead pid', async () => {
    const base = tempDir();
    const file = plant(base, DOC, JSON.stringify({ pid: 4242, host: 'elsewhere' }));
    const err = await acquireLock({
      baseDir: base,
      path: DOC,
      hostname: 'here',
      isAlive: () => false,
    }).catch((e: unknown) => e as { code: string; details: Record<string, unknown> });
    expect(err).toMatchObject({
      code: 'DOC_LOCKED',
      details: { pid: 4242, host: 'elsewhere', lockFile: file },
    });
    expect(existsSync(file)).toBe(true);
  });

  it('lets exactly one of many concurrent reclaimers win', async () => {
    const base = tempDir();
    plant(base, DOC, JSON.stringify({ pid: await deadPid(), host: hostname() }));
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        acquireLock({ baseDir: base, path: DOC, releaseOnExit: false }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'DOC_LOCKED' });
    }
    await won[0]?.value.release();
  });

  it('does not delete a lock that is no longer its own on release', async () => {
    const base = tempDir();
    const lock = await acquireLock({ baseDir: base, path: DOC, releaseOnExit: false });
    writeFileSync(lock.lockFile, JSON.stringify({ pid: 1, host: 'other' }));
    await lock.release();
    expect(existsSync(lock.lockFile)).toBe(true);
  });

  it('maps an unusable lock folder to IO_FAILED', async () => {
    const base = tempDir();
    writeFileSync(join(base, 'locks'), 'a file where the folder should be');
    expect((await outcome(acquireLock({ baseDir: base, path: DOC }))).code).toBe('IO_FAILED');
  });
});

describe('two real processes', () => {
  it('gives the second process DOC_LOCKED with the owner pid, and frees the lock when the owner exits', async () => {
    const { base, root, hero } = workspace();
    const owner = await spawnChild('host', base, root, hero);
    expect(await owner.go()).toEqual({ ok: true, pid: owner.pid });
    const second = await spawnChild('host', base, root, hero);
    const refused = await second.go();
    expect(refused).toMatchObject({ ok: false, code: 'DOC_LOCKED', details: { pid: owner.pid } });
    await second.finish();
    expect(readdirSync(join(base, 'locks'))).toHaveLength(1);

    await owner.finish(); // exits without releasing: the exit sweep removes the lock
    expect(readdirSync(join(base, 'locks'))).toEqual([]);
    const third = await spawnChild('host', base, root, hero);
    expect(await third.go()).toMatchObject({ ok: true });
    await third.finish();
  });

  it('reclaims the lock of a crashed owner, and only one of several simultaneous processes wins', async () => {
    const { base, root } = workspace();
    const path = join(root, 'target.pxf');
    plant(base, path, JSON.stringify({ pid: await deadPid(), host: hostname() }));
    const children = await Promise.all(
      Array.from({ length: 6 }, () => spawnChild('lock', base, root, path)),
    );
    const reports = await Promise.all(children.map((c) => c.go()));
    const winners = reports.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    for (const r of reports) {
      if (!r.ok) expect(r).toMatchObject({ code: 'DOC_LOCKED', details: { pid: winner?.pid } });
    }
    await Promise.all(children.map((c) => c.finish()));
    expect(readdirSync(join(base, 'locks'))).toEqual([]);
  });
});
