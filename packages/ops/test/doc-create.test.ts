// doc.create: a new empty document, hosted but not saved.
import { validate } from '@pixel-forge/core';
import { MemoryFileSystem, fixedClock, steppedClock } from '@pixel-forge/io';
import type { Clock } from '@pixel-forge/io';
import { describe, expect, it } from 'vitest';
import { createMemoryHost, docCreate, registry } from '../src/index.js';
import { need, rejection } from './helpers.js';

const newHost = (clock: Clock = fixedClock('2026-11-01T00:00:00Z')) =>
  createMemoryHost({ fs: new MemoryFileSystem(), clock, roots: ['/work'] });

describe('doc.create', () => {
  it('rejects bad input', async () => {
    const host = newHost();
    const bad = await rejection(registry.execute('doc.create', { width: 0, height: 8 }, { host }));
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.details.issues).toEqual([{ path: 'width', message: expect.any(String) as string }]);
  });

  it('runs its example: an empty, valid, unsaved document with the origin at the feet', async () => {
    const host = newHost();
    const out = (await registry.execute('doc.create', need(docCreate.examples[0]).input, {
      host,
    })) as { doc: string; canvas: object; origin: object };
    expect(out).toMatchObject({ name: 'hero', canvas: { w: 48, h: 48 }, origin: { x: 24, y: 47 } });
    const hosted = need(host.list()[0]);
    expect(hosted).toMatchObject({ id: out.doc, path: undefined, savedVersion: undefined });
    expect(hosted.store.doc.meta).toMatchObject({ colorMode: 'rgba', pixelsPerUnit: 16 });
    expect(validate(hosted.store).filter((f) => f.severity === 'error')).toEqual([]);
    const summary = await registry.execute('doc.summary', { doc: out.doc }, { host });
    expect(summary).toMatchObject({ path: null, dirty: true });
  });

  it('derives distinct ids from the clock port and never collides', async () => {
    const host = newHost(fixedClock('2026-11-01T00:00:00Z')); // the same instant every time
    const run = { host };
    const make = async (h = run): Promise<string> =>
      ((await registry.execute('doc.create', { width: 8, height: 8 }, h)) as { doc: string }).doc;
    const a = await make();
    const b = await make();
    expect(a).not.toBe(b);
    const c = await make({ host: newHost(steppedClock('2026-11-01T00:00:01Z')) });
    const d = await make({ host: newHost(fixedClock('2026-11-01T00:00:00Z')) });
    expect(c).not.toBe(d); // another instant, another seed
    expect(d).toBe(a); // same clock, same first id: deterministic
  });

  it('honours idSeed, origin and pixelsPerUnit, and reports a seed clash', async () => {
    const host = newHost();
    const run = { host };
    const input = { width: 8, height: 8, idSeed: 5, origin: { x: 1, y: 2 }, pixelsPerUnit: 32 };
    await registry.execute('doc.create', input, run);
    expect(need(host.list()[0]).store.doc.meta).toMatchObject({
      origin: { x: 1, y: 2 },
      pixelsPerUnit: 32,
      ids: { seed: 5 },
    });
    const clash = await rejection(registry.execute('doc.create', input, run));
    expect(clash).toMatchObject({ code: 'CONFLICT', details: { reason: 'id-seed-taken' } });
  });
});
