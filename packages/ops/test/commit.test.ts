// The shared commit sequence: validate guard (scoped, never cached for a rejected state), listener
// failures after a commit, and no unhandled rejections from handlers that wrongly return promises.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { documentHash } from '@pixel-forge/core';
import { MemoryFileSystem, createDocumentFromAseprite, fixedClock } from '@pixel-forge/io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ALL_OPS, DocRef, createMemoryHost, createRegistry, defineOp } from '../src/index.js';
import type { OpLogger, OpHost, RunOptions } from '../src/index.js';
import { HERO_ID, need, openHero, rejection } from './helpers.js';

const docInput = z.strictObject({ doc: DocRef });

/** Writes one pixel of the first stored image (an index; a write above the palette is invalid). */
const poke = defineOp({
  name: 'test.poke',
  safety: 'mutate',
  summary: 'Write palette index `value` at (0, 0) of the first image.',
  input: z.strictObject({ doc: DocRef, value: z.int() }),
  output: z.strictObject({ ok: z.boolean() }),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q', value: 1 } }],
  handler: (ctx, input) => {
    const id = need(ctx.tx.imageIds()[0]);
    ctx.tx.writeImage(id, (img) => {
      (img as unknown as { set(x: number, y: number, v: number): void }).set(0, 0, input.value);
    });
    return { ok: true };
  },
});
const rename = defineOp({
  name: 'test.rename',
  safety: 'mutate',
  summary: 'Rename the document.',
  input: z.strictObject({ doc: DocRef, name: z.string() }),
  output: z.strictObject({ ok: z.boolean() }),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q', name: 'n' } }],
  handler: (ctx, input) => {
    ctx.tx.update((d) => {
      d.meta.name = input.name;
    });
    return { ok: true };
  },
});
const rejecting = defineOp({
  name: 'test.rejecting',
  safety: 'mutate',
  summary: 'Broken: returns a rejecting promise.',
  input: docInput,
  output: z.unknown(),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q' } }],
  handler: () => Promise.reject(new Error('late failure')),
});
const rejectingTransact = defineOp({
  name: 'test.rejectingTransact',
  safety: 'io',
  summary: 'Broken: the transact callback returns a rejecting promise.',
  input: docInput,
  output: z.unknown(),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q' } }],
  handler: (ctx) => {
    void ctx.transact(() => Promise.reject(new Error('late failure')));
    return null;
  },
});
const ioRename = defineOp({
  name: 'test.ioRename',
  safety: 'io',
  summary: 'Renames the document through ctx.transact.',
  input: z.strictObject({ doc: DocRef, name: z.string() }),
  output: z.strictObject({ ok: z.boolean() }),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q', name: 'n' } }],
  handler: (ctx, input) => {
    ctx.transact((tx) => {
      tx.update((d) => {
        d.meta.name = input.name;
      });
    });
    return Promise.resolve({ ok: true });
  },
});
const reg = createRegistry([...ALL_OPS, poke, rename, rejecting, rejectingTransact, ioRename]);

const INDEXED = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/aseprite/indexed_palette.aseprite', import.meta.url)),
  ),
);

/** A host with one indexed document (8x8 image, 16-colour palette, indices up to 14). */
async function indexedHost(): Promise<{
  host: OpHost;
  run: RunOptions;
  store: ReturnType<typeof createDocumentFromAseprite>['store'];
  doc: string;
}> {
  const host = createMemoryHost({
    fs: new MemoryFileSystem(),
    clock: fixedClock('2026-11-01T00:00:00Z'),
  });
  const { store } = createDocumentFromAseprite(INDEXED);
  await host.adopt({ store });
  return { host, run: { host }, store, doc: store.doc.meta.id };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validate guard', () => {
  it('rejects an invalid pixel-only edit every time it is retried', async () => {
    const { run, store, doc } = await indexedHost();
    const v0 = store.version;
    const hash = documentHash(store);
    for (let i = 0; i < 3; i++) {
      const e = await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
      expect(e.code).toBe('INTERNAL');
      expect(e.details.reason).toBe('invalid-document');
      expect(JSON.stringify(e.details.findings)).toContain('INDEX_OUT_OF_RANGE');
    }
    expect(documentHash(store)).toBe(hash);
    expect(store.version).toBe(v0);
    // a valid pixel edit still passes, and an invalid one is rejected after it
    await reg.execute('test.poke', { doc, value: 3 }, run);
    expect(store.version).toBe(v0 + 1);
    const again = await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    expect(again.details.reason).toBe('invalid-document');
    expect(store.version).toBe(v0 + 1);
  });

  it('does not let a rejected state leak into later doc-only calls', async () => {
    const { run, store, doc } = await indexedHost();
    const v0 = store.version;
    await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    await reg.execute('test.rename', { doc, name: 'a' }, run);
    await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    expect(store.version).toBe(v0 + 1);
    expect(store.doc.meta.name).toBe('a');
  });

  it('keeps guarding after undo and redo of a pixel-only change', async () => {
    const { run, store, doc } = await indexedHost();
    const v0 = store.version;
    await reg.execute('test.poke', { doc, value: 3 }, run);
    await reg.execute('test.rename', { doc, name: 'b' }, run);
    store.undo();
    store.undo();
    expect(store.version).toBe(v0 + 4);
    const e1 = await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    expect(e1.details.reason).toBe('invalid-document');
    store.redo();
    const e2 = await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    expect(e2.details.reason).toBe('invalid-document');
    await reg.execute('test.poke', { doc, value: 4 }, run);
  });

  it('does not block ops on errors the committed state already had', async () => {
    const { run, store, doc } = await indexedHost();
    const v0 = store.version;
    await reg.execute('test.poke', { doc, value: 200 }, { ...run, validate: false });
    // doc-only edit: fine, the pixel error was there before
    await reg.execute('test.rename', { doc, name: 'c' }, run);
    // writing the same invalid value again adds no error: allowed (a no-op)
    await reg.execute('test.poke', { doc, value: 200 }, run);
    expect(store.version).toBe(v0 + 2);
    // fixing it is fine; breaking it again is rejected now that it was fixed
    await reg.execute('test.poke', { doc, value: 2 }, run);
    expect(store.version).toBe(v0 + 3);
    const e = await rejection(reg.execute('test.poke', { doc, value: 200 }, run));
    expect(e.details.reason).toBe('invalid-document');
  });

  it('scans pixels only for images the call changed', async () => {
    const { run, store, doc } = await indexedHost();
    const image = need(store.image(need(store.imageIds()[0])));
    const scan = vi.spyOn(Object.getPrototypeOf(image) as { toIndices(): unknown }, 'toIndices');
    await reg.execute('test.rename', { doc, name: 'd' }, run);
    expect(scan).not.toHaveBeenCalled();
    await reg.execute('test.poke', { doc, value: 2 }, run);
    expect(scan).toHaveBeenCalled();
  });
});

describe('change listener failures', () => {
  const warnLog = (): { log: OpLogger; warn: ReturnType<typeof vi.fn> } => {
    const warn = vi.fn();
    return { log: { debug: vi.fn(), info: vi.fn(), warn }, warn };
  };

  it('reports success with a warning when a listener throws after a mutate commit', async () => {
    const { hero, run } = await openHero(reg);
    hero.store.subscribe(() => {
      throw new Error('listener boom');
    });
    const { log, warn } = warnLog();
    const r = await reg.call('test.rename', { doc: HERO_ID, name: 'z' }, { ...run, log });
    expect(r).toMatchObject({
      ok: true,
      output: { ok: true },
      doc: { version: 1, canUndo: true },
      warnings: [expect.stringContaining('listener boom') as string],
    });
    if (!r.ok || r.doc === undefined) throw new Error('expected success');
    expect(r.doc.undoEntry).not.toBeNull();
    expect(hero.store.doc.meta.name).toBe('z');
    expect(hero.store.version).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // execute() succeeds too
    await reg.execute('test.rename', { doc: HERO_ID, name: 'y' }, { ...run, log });
    expect(hero.store.doc.meta.name).toBe('y');
  });

  it('lists every failing listener', async () => {
    const { hero, run } = await openHero(reg);
    for (const m of ['first', 'second']) {
      hero.store.subscribe(() => {
        throw new Error(m);
      });
    }
    const r = await reg.call('test.rename', { doc: HERO_ID, name: 'z' }, run);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error('expected success');
    expect(r.warnings).toHaveLength(2);
  });

  it('does the same for ctx.transact in io ops', async () => {
    const { hero, run } = await openHero(reg);
    hero.store.subscribe(() => {
      throw new Error('io boom');
    });
    const r = await reg.call('test.ioRename', { doc: HERO_ID, name: 'q' }, run);
    expect(r).toMatchObject({
      ok: true,
      doc: { version: 1 },
      warnings: [expect.stringContaining('io boom') as string],
    });
    expect(hero.store.doc.meta.name).toBe('q');
  });

  it('omits warnings when nothing went wrong', async () => {
    const { run } = await openHero(reg);
    const r = await reg.call('test.rename', { doc: HERO_ID, name: 'z' }, run);
    expect(r).not.toHaveProperty('warnings');
  });
});

describe('handlers that return promises', () => {
  it('raise INTERNAL without an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { hero, run } = await openHero(reg);
      const hash = documentHash(hero.store);
      for (const op of ['test.rejecting', 'test.rejectingTransact']) {
        const e = await rejection(reg.execute(op, { doc: HERO_ID }, run));
        expect(e.code, op).toBe('INTERNAL');
        expect(e.message, op).toContain('synchronous');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(documentHash(hero.store)).toBe(hash);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(seen).toEqual([]);
  });
});
