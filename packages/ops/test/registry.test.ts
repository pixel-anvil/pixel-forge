// The registry: input parsing, document resolution, one transaction per call, confirm, error mapping.
import { CoreError, documentHash } from '@pixel-forge/core';
import { DocId } from '@pixel-forge/schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_OPS,
  DocRef,
  OpError,
  createRegistry,
  defineOp,
  resolveAuthoredAnimation,
} from '../src/index.js';
import type { AnyOp, OpContext } from '../src/index.js';
import { HERO_ID, heroHost, need, openHero, rejection } from './helpers.js';

const docInput = z.strictObject({ doc: DocRef });
const ex = [{ title: 'on the hero', input: { doc: 'doc_g1ed5q' } }] as const;

/** Sets the duration of frame 0 of the first animation. */
const setDuration = defineOp({
  name: 'test.setDuration',
  safety: 'mutate',
  group: 'core',
  summary: 'Set the duration of frame 0.',
  input: z.strictObject({ doc: DocRef, ms: z.int() }),
  output: z.strictObject({ ok: z.boolean() }),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q', ms: 120 } }],
  handler: (ctx, input) => {
    ctx.tx.update((d) => {
      const a = d.animations[0];
      const f = a !== undefined && 'frames' in a ? a.frames[0] : undefined;
      if (f !== undefined) f.durationMs = input.ms;
    });
    return { ok: true };
  },
});

const mutateThen = (name: string, after: (ctx: OpContext) => unknown): AnyOp =>
  defineOp({
    name,
    safety: 'mutate',
    group: 'core',
    summary: 'Test op.',
    input: docInput,
    output: z.unknown(),
    examples: ex,
    handler: (ctx) => {
      ctx.tx.update((d) => {
        d.meta.name = 'changed';
      });
      return after(ctx);
    },
  });

const throwing = mutateThen('test.throws', () => {
  throw new CoreError('BAD_ARGUMENT', 'no such frame', { reason: 'unknown-frame' });
});
const asyncMutate = defineOp({
  name: 'test.asyncMutate',
  safety: 'mutate',
  group: 'core',
  summary: 'Broken: async.',
  input: docInput,
  output: z.strictObject({ n: z.int() }),
  examples: ex,
  // @ts-expect-error a mutate handler must be synchronous
  handler: async (ctx: OpContext) => {
    ctx.tx.update((d) => {
      d.meta.name = 'async';
    });
    return Promise.resolve({ n: 1 });
  },
});
const badOutput = defineOp({
  name: 'test.badOutput',
  safety: 'mutate',
  group: 'core',
  summary: 'Broken: output.',
  input: docInput,
  output: z.strictObject({ n: z.int() }),
  examples: ex,
  handler: (ctx) => {
    ctx.tx.update((d) => {
      d.meta.name = 'bad';
    });
    return { n: 'one' } as unknown as { n: number };
  },
});
const breaksDoc = mutateThen('test.breaksDoc', (ctx) => {
  ctx.tx.update((d) => {
    const a = d.animations[0];
    if (a !== undefined && 'frames' in a) a.frames.push({ ...need(a.frames[0]) });
  });
  return null;
});
const wipe = defineOp({
  name: 'test.wipe',
  safety: 'destructive',
  group: 'core',
  summary: 'Destructive test op.',
  input: docInput,
  output: z.strictObject({ wiped: z.boolean() }),
  examples: ex,
  handler: (ctx) => {
    ctx.tx.update((d) => {
      d.meta.name = 'wiped';
    });
    return { wiped: true };
  },
});
const undo = defineOp({
  name: 'test.undo',
  safety: 'mutate',
  group: 'core',
  summary: 'Undo without a transaction.',
  input: docInput,
  output: z.strictObject({ undone: z.boolean() }),
  examples: ex,
  transaction: false,
  handler: (ctx) => ({ undone: ctx.document.store.undo() !== undefined }),
});
const ioRename = defineOp({
  name: 'test.ioRename',
  safety: 'io',
  group: 'core',
  summary: 'Reads a file, then renames the document once.',
  input: z.strictObject({ doc: DocRef, path: z.string(), twice: z.boolean().optional() }),
  output: z.strictObject({ bytes: z.int() }),
  examples: [{ title: 'x', input: { doc: 'doc_g1ed5q', path: '/work/hero.pxf' } }],
  handler: async (ctx, input) => {
    const bytes = await ctx.host.fs.readFile(ctx.host.resolvePath(input.path));
    ctx.transact((tx) => {
      tx.update((d) => {
        d.meta.name = `bytes${String(bytes.length)}`;
      });
    });
    if (input.twice === true) ctx.transact(() => undefined);
    return { bytes: bytes.length };
  },
});
const hostRead = defineOp({
  name: 'test.hostRead',
  safety: 'read',
  group: 'core',
  summary: 'A host-level read.',
  input: z.strictObject({ field: z.enum(['docs', 'tx', 'document', 'transact', 'view']) }),
  output: z.unknown(),
  examples: [{ title: 'x', input: { field: 'docs' } }],
  handler: (ctx, input) => {
    switch (input.field) {
      case 'docs':
        return { docs: ctx.host.list().map((d) => d.id), hasDocument: ctx.hasDocument };
      case 'tx':
        return ctx.tx;
      case 'document':
        return ctx.document;
      case 'view':
        return ctx.view;
      case 'transact':
        return ctx.transact(() => 1);
    }
  },
});
const readFrame = defineOp({
  name: 'test.readFrame',
  safety: 'read',
  group: 'core',
  summary: 'Reads through ctx.view and ctx.renderFrame.',
  input: docInput,
  output: z.strictObject({ w: z.int(), frames: z.int() }),
  examples: ex,
  handler: (ctx) => {
    const { animation } = resolveAuthoredAnimation(ctx.doc, { group: 'default' });
    const img = ctx.renderFrame({ group: 'default' }, 0, { exportOnly: true });
    ctx.log.info('rendered', { w: img.width });
    return { w: img.width, frames: animation.frames.length };
  },
});

const reg = createRegistry([
  ...ALL_OPS,
  setDuration,
  throwing,
  asyncMutate,
  badOutput,
  breaksDoc,
  wipe,
  undo,
  ioRename,
  hostRead,
  readFrame,
]);

describe('OpRegistry', () => {
  it('lists ops sorted by name and finds them by op or MCP name', () => {
    const names = reg.list().map((o) => o.name);
    expect(names).toEqual([...names].sort());
    expect(reg.get('rig.setPose')?.mcpName).toBe('rig_set_pose');
    expect(reg.byMcpName('rig_set_pose')?.name).toBe('rig.setPose');
    expect(reg.get('nope')).toBeUndefined();
  });

  it('rejects duplicate names, MCP names and CLI commands', () => {
    expect(() => createRegistry([setDuration, setDuration])).toThrow(/duplicate op/);
    const sameTool = defineOp({
      ...setDuration,
      name: 'test.other',
      mcp: { name: 'test_set_duration' },
    });
    expect(() => createRegistry([setDuration, sameTool])).toThrow(/MCP tool name/);
    const sameCli = defineOp({
      ...setDuration,
      name: 'test.other',
      cli: { command: ['test', 'set-duration'] },
    });
    expect(() => createRegistry([setDuration, sameCli])).toThrow(/CLI command/);
  });

  it('runs a mutate op as one transaction labelled with the prefix', async () => {
    const { hero, run } = await openHero(reg);
    await reg.execute('test.setDuration', { doc: HERO_ID, ms: 120 }, run);
    await reg.execute(
      'test.setDuration',
      { doc: HERO_ID, ms: 130 },
      { ...run, labelPrefix: 'CLI: ' },
    );
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual([
      'AI: test.setDuration',
      'CLI: test.setDuration',
    ]);
  });

  it('leaves no trace when a handler throws, and maps core refusals', async () => {
    const { hero, run } = await openHero(reg);
    const hash = documentHash(hero.store);
    const version = hero.store.version;
    const err = await rejection(reg.execute('test.throws', { doc: HERO_ID }, run));
    expect(err).toMatchObject({
      code: 'NOT_FOUND',
      details: {
        reason: 'unknown-frame',
        kind: 'frame',
        cause: { error: 'CoreError', code: 'BAD_ARGUMENT' },
      },
    });
    for (const [op, reason] of [
      ['test.asyncMutate', undefined],
      ['test.badOutput', 'bad-output'],
      ['test.breaksDoc', 'invalid-document'],
    ] as const) {
      const e = await rejection(reg.execute(op, { doc: HERO_ID }, run));
      expect(e.code, op).toBe('INTERNAL');
      if (reason !== undefined) expect(e.details.reason).toBe(reason);
    }
    expect(documentHash(hero.store)).toBe(hash);
    expect(hero.store.version).toBe(version);
    expect(hero.store.canUndo).toBe(false);
  });

  it('can skip the validate guard', async () => {
    const { hero, run } = await openHero(reg);
    await reg.execute('test.breaksDoc', { doc: HERO_ID }, { ...run, validate: false });
    expect(hero.store.canUndo).toBe(true);
  });

  it('returns envelopes from call()', async () => {
    const { run } = await openHero(reg);
    expect(await reg.call('nope.nope', {}, run)).toMatchObject({
      ok: false,
      op: 'nope.nope',
      error: { code: 'UNKNOWN_OP', details: { name: 'nope.nope' } },
    });
    expect(await reg.call('doc.summary', [], run)).toMatchObject({
      ok: false,
      error: { code: 'BAD_INPUT', details: { issues: [{ path: '' }] } },
    });
    expect(await reg.call('doc.summary', { doc: 'doc_zzz' }, run)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', details: { kind: 'doc', ref: 'doc_zzz', available: [HERO_ID] } },
    });
    const read = await reg.call('doc.summary', { doc: HERO_ID }, run);
    expect(read).toMatchObject({ ok: true, doc: { id: HERO_ID, undoEntry: null, canUndo: false } });
    const hostLevel = await reg.call('test.hostRead', { field: 'docs' }, run);
    expect(hostLevel).toEqual({
      ok: true,
      op: 'test.hostRead',
      output: { docs: [HERO_ID], hasDocument: false },
    });
  });

  it('suggests doc_open when no document is open', async () => {
    const { host } = heroHost();
    const err = await rejection(reg.execute('doc.summary', { doc: HERO_ID }, { host }));
    expect(err.message).toMatch(/doc_open/);
  });

  it('refuses a destructive op without confirm: true, after checking the input', async () => {
    const { hero, run } = await openHero(reg);
    expect((await rejection(reg.execute('test.wipe', { doc: HERO_ID }, run))).code).toBe(
      'CONFIRM_REQUIRED',
    );
    expect(
      (await rejection(reg.execute('test.wipe', { doc: HERO_ID, confirm: false }, run))).code,
    ).toBe('CONFIRM_REQUIRED');
    expect(
      (await rejection(reg.execute('test.wipe', { doc: 'nope', confirm: true }, run))).code,
    ).toBe('BAD_INPUT');
    expect(hero.store.canUndo).toBe(false);
    expect(await reg.execute('test.wipe', { doc: HERO_ID, confirm: true }, run)).toEqual({
      wiped: true,
    });
    expect(hero.store.doc.meta.name).toBe('wiped');
    // confirm is not an input field of other ops
    expect(
      (await rejection(reg.execute('doc.summary', { doc: HERO_ID, confirm: true }, run))).code,
    ).toBe('BAD_INPUT');
  });

  it('runs transaction: false ops without opening a transaction', async () => {
    const { hero, run } = await openHero(reg);
    await reg.execute('test.setDuration', { doc: HERO_ID, ms: 150 }, run);
    const result = await reg.call('test.undo', { doc: HERO_ID }, run);
    expect(result).toMatchObject({
      ok: true,
      output: { undone: true },
      doc: { canUndo: false, canRedo: true },
    });
    expect(hero.store.canRedo).toBe(true);
  });

  it('lets an io op change its document once through ctx.transact', async () => {
    const { hero, run } = await openHero(reg);
    const result = await reg.call('test.ioRename', { doc: HERO_ID, path: '/work/hero.pxf' }, run);
    expect(result).toMatchObject({ ok: true, doc: { undoEntry: 1 } });
    expect(hero.store.doc.meta.name).toMatch(/^bytes\d+$/);
    expect(hero.store.historyInfo().entries.map((e) => e.label)).toEqual(['AI: test.ioRename']);
    const twice = await rejection(
      reg.execute('test.ioRename', { doc: HERO_ID, path: '/work/hero.pxf', twice: true }, run),
    );
    expect(twice.code).toBe('INTERNAL');
    expect(twice.message).toMatch(/once/);
  });

  it('guards context members by safety class', async () => {
    const { run } = await openHero(reg);
    for (const field of ['tx', 'document', 'view', 'transact']) {
      const e = await rejection(reg.execute('test.hostRead', { field }, run));
      expect(e.code, field).toBe('INTERNAL');
    }
  });

  it('gives read ops the view, the renderer and the logger', async () => {
    const { run } = await openHero(reg);
    const logged: string[] = [];
    const log = {
      debug: () => undefined,
      info: (m: string) => logged.push(m),
      warn: () => undefined,
    };
    expect(await reg.execute('test.readFrame', { doc: HERO_ID }, { ...run, log })).toEqual({
      w: 48,
      frames: 1,
    });
    expect(logged).toEqual(['rendered']);
  });

  it('maps unexpected errors to INTERNAL and OpErrors pass through', async () => {
    const boom = defineOp({
      name: 'test.boom',
      safety: 'read',
      group: 'core',
      summary: 'Throws.',
      input: z.strictObject({ kind: z.enum(['error', 'op', 'string']) }),
      output: z.unknown(),
      examples: [{ title: 'x', input: { kind: 'error' } }],
      handler: (_ctx, input) => {
        if (input.kind === 'op') throw new OpError('REFUSED', 'no', { reason: 'test' });
        if (input.kind === 'string') throw 'raw'; // eslint-disable-line @typescript-eslint/only-throw-error
        throw new TypeError('oops');
      },
    });
    const r = createRegistry([boom]);
    const { host } = heroHost();
    expect(await rejection(r.execute('test.boom', { kind: 'error' }, { host }))).toMatchObject({
      code: 'INTERNAL',
      message: 'internal error: oops',
      details: { cause: { error: 'TypeError' } },
    });
    expect(await rejection(r.execute('test.boom', { kind: 'op' }, { host }))).toMatchObject({
      code: 'REFUSED',
      details: { reason: 'test' },
    });
    expect(await rejection(r.execute('test.boom', { kind: 'string' }, { host }))).toMatchObject({
      code: 'INTERNAL',
      details: { cause: { error: 'string' } },
    });
  });

  it('parses doc ids with the schema', () => {
    expect(DocId.safeParse(HERO_ID).success).toBe(true);
  });
});
