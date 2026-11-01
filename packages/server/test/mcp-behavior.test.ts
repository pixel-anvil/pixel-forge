// How the MCP server answers: result shape, images, destructive tools, errors, forwarding, workspace
// roots, trace, ordering and shutdown. Over an in-process client on a real DocumentHost.
import { existsSync } from 'node:fs';
import { OpRegistry, registry } from '@pixel-forge/ops';
import { describe, expect, it } from 'vitest';
import { SERVER_PROTOCOL_VERSION, lockFilePath, writeServerInfo } from '../src/index.js';
import { deadPid } from './helpers.js';
import { HERO_ID, mcpFixture } from './mcp-helpers.js';
import { SCENARIOS, prepare } from './mcp-scenarios.js';

const frame0 = { group: 'default' };

/** Width and height from the IHDR chunk of a PNG, after checking the signature. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('results', () => {
  it('are compact JSON in one text block, with the envelope of the ops contract', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const raw = await f.client.callTool({ name: 'doc_summary', arguments: { doc: HERO_ID } });
    expect(raw).not.toHaveProperty('structuredContent');
    expect(raw.isError).toBeUndefined();
    const content = raw.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    const text = content[0]?.text ?? '';
    expect(text).not.toMatch(/\n| {2}/);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      op: 'doc.summary',
      output: { doc: HERO_ID },
      doc: { id: HERO_ID, undoEntry: null },
    });
  });

  it('echo the undo state of a mutating call', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const r = await f.call('frame_add', { doc: HERO_ID, animation: frame0, frame: 0 });
    expect(r.json).toMatchObject({
      ok: true,
      op: 'frame.add',
      doc: { id: HERO_ID, undoEntry: expect.any(Number) as number, canUndo: true, canRedo: false },
    });
    const undone = await f.call('undo', { doc: HERO_ID });
    expect(undone.json.output).toEqual({ undone: true, label: 'AI: frame.add' });
    expect(f.labels(HERO_ID)).toEqual([]);
  });

  it('give the server its name, version and usage hint', async () => {
    const f = await mcpFixture({
      serverOptions: { serverInfo: { name: 'pixel-forge', version: '1.2.3' } },
    });
    expect(f.client.getServerVersion()).toMatchObject({ name: 'pixel-forge', version: '1.2.3' });
    expect(f.client.getInstructions()).toContain('doc_open');
    expect(f.client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
  });
});

describe('images', () => {
  it.each([
    ['render_frame', { animation: frame0, frame: 0, scale: 8, bones: true, pivots: true }],
    ['render_contact_sheet', { bones: true }],
  ])('%s returns an image content block and no data in the text', async (tool, args) => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const r = await f.call(tool, { doc: HERO_ID, ...args });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    const image = r.images[0];
    expect(image?.mimeType).toBe('image/png');
    const size = pngSize(image?.data ?? '');
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1568);
    expect(Math.max(size.width, size.height)).toBeGreaterThan(8);
    const shown = (r.json.output as { image: Record<string, unknown> }).image;
    expect(shown).not.toHaveProperty('data');
    expect(shown).toMatchObject({ mimeType: 'image/png', width: size.width, height: size.height });
    expect(r.text).not.toContain(image?.data ?? '?');
    expect(r.text.length).toBeLessThan(4000);
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image']);
  });

  it('are only sent by tools whose output has an image', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    expect((await f.call('doc_summary', { doc: HERO_ID })).images).toEqual([]);
  });
});

describe('destructive tools', () => {
  it('are refused without confirm: true and leave the document unchanged', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    const destructive = tools.filter((t) => t._meta?.['pixel-forge/safety'] === 'destructive');
    expect(destructive.length).toBeGreaterThan(0);
    for (const tool of destructive) {
      const scenario = SCENARIOS[tool.name];
      expect(scenario, tool.name).toBeDefined();
      if (scenario === undefined) continue;
      const g = await mcpFixture();
      const doc = await prepare(g, scenario.base);
      const memo: Record<string, unknown> = {};
      await scenario.setup?.(g, doc, memo);
      const args = scenario.args({ doc, root: g.root, memo });
      delete args.confirm;
      const store = g.doc(doc).store;
      const labels = g.labels(doc);
      const version = store.version;
      for (const withConfirm of [{}, { confirm: false }, { confirm: 'yes' }]) {
        const r = await g.call(tool.name, { ...args, ...withConfirm });
        expect(r.isError, tool.name).toBe(true);
        expect(r.json.code).toBe('CONFIRM_REQUIRED');
        expect(r.json.details).toMatchObject({ op: expect.any(String) as string });
        expect(g.labels(doc)).toEqual(labels);
        expect(store.version).toBe(version);
      }
      const ok = await g.call(tool.name, { ...args, confirm: true });
      expect(ok.isError, ok.text).toBe(false);
    }
  });

  it('say which tools need it in the description and the annotations', async () => {
    const f = await mcpFixture();
    const bake = (await f.client.listTools()).tools.find((t) => t.name === 'rig_bake');
    expect(bake?.description).toContain('"confirm": true');
    expect(bake?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(JSON.stringify(bake?.inputSchema)).toContain('confirm');
  });
});

describe('errors', () => {
  it('are tool results with isError and the OpError JSON, and the server keeps serving', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const missing = await f.call('frame_delete', { doc: HERO_ID, animation: frame0, frame: 99 });
    expect(missing.isError).toBe(true);
    expect(Object.keys(missing.json).sort()).toEqual(['code', 'details', 'message']);
    expect(missing.json).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'frame' } });
    const bad = await f.call('frame_delete', { doc: HERO_ID, frame: 'x' });
    expect(bad).toMatchObject({ isError: true, json: { code: 'BAD_INPUT' } });
    const noDoc = await f.call('doc_summary', { doc: 'doc_nope' });
    expect(noDoc.json).toMatchObject({ code: 'NOT_FOUND', details: { kind: 'doc' } });
    expect(f.labels(HERO_ID)).toEqual([]);
    expect((await f.call('doc_summary', { doc: HERO_ID })).isError).toBe(false);
  });

  it('treat missing arguments as an empty object', async () => {
    const f = await mcpFixture();
    const raw = await f.client.callTool({ name: 'doc_summary' });
    expect(raw.isError).toBe(true);
    expect(JSON.parse((raw.content as { text: string }[])[0]?.text ?? '')).toMatchObject({
      code: 'BAD_INPUT',
    });
  });

  it('answer an unknown tool with an UNKNOWN_OP result, not a protocol error', async () => {
    const f = await mcpFixture();
    const r = await f.call('no_such_tool', {});
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ code: 'UNKNOWN_OP', details: { name: 'no_such_tool' } });
    expect((r.json.details as { available: string[] }).available).toContain('doc_open');
  });

  it('turn a throwing registry into an INTERNAL result instead of a crash', async () => {
    class Boom extends OpRegistry {
      override call(): never {
        throw new Error('boom');
      }
    }
    const f = await mcpFixture({ registry: new Boom(registry.list()) });
    const r = await f.call('doc_summary', { doc: HERO_ID });
    expect(r).toMatchObject({ isError: true, json: { code: 'INTERNAL' } });
    expect((await f.call('doc_summary', { doc: HERO_ID })).isError).toBe(true);
    expect(f.traces.map((t) => JSON.parse(t) as { code: string })[0]?.code).toBe('INTERNAL');
  });
});

describe('workspace roots', () => {
  it('refuse paths outside the roots, with and without ..', async () => {
    const f = await mcpFixture();
    for (const path of ['/etc/hosts', `${f.root}/../outside.pxf`, `${f.base}/x.pxf`]) {
      const r = await f.call('doc_open', { path });
      expect(r, path).toMatchObject({ isError: true, json: { code: 'NOT_ALLOWED' } });
    }
    const save = await f.call('doc_open', { path: f.hero });
    expect(save.isError).toBe(false);
    const out = await f.call('export', { doc: HERO_ID, path: `${f.base}/hero.png`, scale: 1 });
    expect(out).toMatchObject({ isError: true, json: { code: 'NOT_ALLOWED' } });
    expect(existsSync(`${f.base}/hero.png`)).toBe(false);
    const rel = await f.call('doc_open', { path: 'hero.pxf' });
    expect(rel.json.code).toBe('BAD_INPUT');
  });
});

describe('forwarding', () => {
  it('answers NOT_IMPLEMENTED when a compatible pf serve is running', async () => {
    const f = await mcpFixture({
      prepare: ({ base }) =>
        writeServerInfo(base, {
          pid: process.pid,
          port: 4321,
          token: 'secret-token',
          protocolVersion: SERVER_PROTOCOL_VERSION,
        }),
    });
    expect(f.handle.forwardedTo).toMatchObject({ pid: process.pid, port: 4321 });
    const r = await f.call('doc_open', { path: f.hero });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      code: 'NOT_IMPLEMENTED',
      details: { reason: 'forwarding', pid: process.pid },
    });
    expect(r.text).not.toContain('secret-token');
    expect(f.host.list()).toEqual([]);
    expect((await f.client.listTools()).tools.length).toBeGreaterThan(30);
    const unknown = await f.call('no_such_tool', {});
    expect(unknown.json.code).toBe('UNKNOWN_OP');
  });

  it('hosts the documents itself for a stale entry or another protocol version', async () => {
    const stale = await mcpFixture({
      prepare: async ({ base }) =>
        writeServerInfo(base, {
          pid: await deadPid(),
          port: 4321,
          token: 't',
          protocolVersion: SERVER_PROTOCOL_VERSION,
        }),
    });
    expect(stale.handle.forwardedTo).toBeUndefined();
    expect((await stale.call('doc_open', { path: stale.hero })).isError).toBe(false);
    const other = await mcpFixture({
      prepare: ({ base }) =>
        writeServerInfo(base, {
          pid: process.pid,
          port: 4321,
          token: 't',
          protocolVersion: SERVER_PROTOCOL_VERSION + 1,
        }),
    });
    expect(other.handle.forwardedTo).toBeUndefined();
    expect((await other.call('doc_open', { path: other.hero })).isError).toBe(false);
  });

  it('uses the baseDir option over the host base folder', async () => {
    const elsewhere = await mcpFixture();
    const f = await mcpFixture({
      serverOptions: { baseDir: elsewhere.base },
      prepare: ({ base }) =>
        writeServerInfo(base, {
          pid: process.pid,
          port: 4321,
          token: 't',
          protocolVersion: SERVER_PROTOCOL_VERSION,
        }),
    });
    expect(f.handle.forwardedTo).toBeUndefined(); // the entry is in the host's folder, not baseDir
  });
});

describe('trace', () => {
  it('writes one JSON line per call with tool, op, duration and outcome, and no input', async () => {
    let t = 0;
    const f = await mcpFixture({ serverOptions: { now: () => (t += 5) } });
    await f.call('doc_open', { path: f.hero });
    await f.call('pixels_write_grid', {
      doc: HERO_ID,
      animation: frame0,
      frame: 0,
      x: 26,
      y: 4,
      rows: ['21'],
      legend: { '1': '#e8be96', '2': '#1e1e28' },
    });
    await f.call('render_frame', { doc: HERO_ID, animation: frame0, frame: 0 });
    await f.call('frame_delete', { doc: HERO_ID, animation: frame0, frame: 9 });
    await f.call('no_such_tool', {});
    const lines = f.traces.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.tool, l.op, l.ok, l.code])).toEqual([
      ['doc_open', 'doc.open', true, undefined],
      ['pixels_write_grid', 'pixels.writeGrid', true, undefined],
      ['render_frame', 'render.frame', true, undefined],
      ['frame_delete', 'frame.delete', false, 'NOT_FOUND'],
      ['no_such_tool', null, false, 'UNKNOWN_OP'],
    ]);
    expect(lines[1]).toMatchObject({
      doc: HERO_ID,
      ms: 5,
      undoEntry: expect.any(Number) as number,
    });
    expect(lines[0]).toHaveProperty('at');
    for (const line of f.traces) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('e8be96');
      expect(line).not.toContain('iVBOR'); // base64 of a PNG
    }
  });

  it('is off by default and a throwing sink does not break the call', async () => {
    const quiet = await mcpFixture({ trace: false });
    expect((await quiet.call('doc_open', { path: quiet.hero })).isError).toBe(false);
    const loud = await mcpFixture({
      serverOptions: {
        trace: () => {
          throw new Error('sink');
        },
      },
    });
    expect((await loud.call('doc_open', { path: loud.hero })).isError).toBe(false);
  });
});

describe('ordering and shutdown', () => {
  it('runs concurrent calls one at a time: five parallel edits are five undo entries', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() => f.call('frame_add', { doc: HERO_ID, animation: frame0, frame: 0 })),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(f.labels(HERO_ID)).toEqual(Array(5).fill('AI: frame.add'));
    const parallelOpen = await Promise.all([
      f.call('doc_open', { path: f.hero }),
      f.call('doc_open', { path: f.hero }),
    ]);
    expect(
      parallelOpen.map((r) => (r.json.output as { alreadyOpen: boolean }).alreadyOpen),
    ).toEqual([true, true]);
  });

  it('disposes the host when the client goes away: documents closed, lock released', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const lock = lockFilePath(f.base, f.hero);
    expect(existsSync(lock)).toBe(true);
    await f.client.close();
    await f.handle.closed;
    expect(f.host.list()).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  it('closes on request, once, and keeps no lock', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    await f.handle.close();
    await f.handle.close();
    expect(existsSync(lockFilePath(f.base, f.hero))).toBe(false);
    await f.handle.closed;
  });

  it('waits for a running call before disposing', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const pending = f.call('render_contact_sheet', { doc: HERO_ID });
    const closing = f.handle.close();
    await closing;
    await expect(pending).resolves.toBeDefined();
    expect(f.host.list()).toEqual([]);
  });

  it('reports a failing dispose to the trace and still closes', async () => {
    const f = await mcpFixture();
    const real = f.host;
    const broken = {
      ...real,
      dispose: (): Promise<void> => Promise.reject(new Error('disk gone')),
    };
    const g = await mcpFixture({ serverOptions: { host: broken } });
    await g.handle.close();
    await g.handle.closed;
    expect(g.traces.some((l) => l.includes('dispose-failed') && l.includes('disk gone'))).toBe(
      true,
    );
  });
});
