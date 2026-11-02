// MCP resources (FR-AI-15): each URI, the listings, and the errors for unknown documents,
// animations and URIs.
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { RESOURCE_NOT_FOUND, SERVER_PROTOCOL_VERSION, writeServerInfo } from '../src/index.js';
import { HERO_ID, mcpFixture } from './mcp-helpers.js';
import type { McpFixture } from './mcp-helpers.js';

const frame0 = { group: 'default' };

/** Reads a resource and parses its single JSON block. */
async function read(f: McpFixture, uri: string): Promise<Record<string, unknown>> {
  const r = await f.client.readResource({ uri });
  expect(r.contents).toHaveLength(1);
  const block = r.contents[0];
  expect(block).toMatchObject({ uri, mimeType: 'application/json' });
  return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
}

async function rejected(p: Promise<unknown>): Promise<McpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(McpError);
    return e as McpError;
  }
  throw new Error('expected a rejection');
}

describe('resources', () => {
  it('lists the templates', async () => {
    const f = await mcpFixture();
    const { resourceTemplates } = await f.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      'pf://doc/{id}/summary',
      'pf://doc/{id}/palette',
      'pf://doc/{id}/rig',
      'pf://doc/{id}/animations/{group}/{direction}',
      'pf://doc/{id}/animations/{group}',
    ]);
  });

  it('pf://docs lists the open documents (empty at first)', async () => {
    const f = await mcpFixture();
    expect(await read(f, 'pf://docs')).toEqual({ documents: [] });
    await f.call('doc_open', { path: f.hero });
    const docs = (await read(f, 'pf://docs')).documents as Record<string, unknown>[];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      doc: HERO_ID,
      path: f.hero,
      dirty: false,
      rig: true,
      canvas: { w: expect.any(Number) as number, h: expect.any(Number) as number },
    });
    await f.call('frame_add', { doc: HERO_ID, animation: frame0, frame: 0 });
    const again = (await read(f, 'pf://docs')).documents as { dirty: boolean; version: number }[];
    expect(again[0]?.dirty).toBe(true);
  });

  it('pf://doc/{id}/summary is the doc_summary output', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const viaTool = (await f.call('doc_summary', { doc: HERO_ID })).json.output;
    expect(await read(f, `pf://doc/${HERO_ID}/summary`)).toEqual(viaTool);
  });

  it('pf://doc/{id}/rig is the rig section: bones, parts and views by name', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const rig = (await read(f, `pf://doc/${HERO_ID}/rig`)).rig as {
      bones: { name: string; parent: string | null }[];
      parts: { name: string }[];
      views: { name: string }[];
    };
    expect(rig.bones.map((b) => b.name)).toContain('upper_arm_r');
    expect(rig.parts.map((p) => p.name)).toContain('head');
    expect(rig.views.map((v) => v.name)).toContain('side');
    const flat = await f.call('doc_create', { name: 'flat', width: 16, height: 16 });
    const id = (flat.json.output as { doc: string }).doc;
    expect(await read(f, `pf://doc/${id}/rig`)).toEqual({ doc: id, rig: null });
  });

  it('pf://doc/{id}/palette lists the palettes with colours as hex', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const none = await read(f, `pf://doc/${HERO_ID}/palette`);
    expect(none).toMatchObject({ doc: HERO_ID, colorMode: 'rgba', palettes: [], active: null });
    f.doc(HERO_ID).store.transact('palette', (tx) => {
      const id = tx.newId('palette');
      tx.update((d) => {
        d.palettes.push({
          id,
          name: 'test',
          colors: [
            [0, 0, 0, 0],
            [255, 128, 0, 255],
            [1, 2, 3, 128],
          ],
          ramps: [{ name: 'warm', indices: [1, 2] }],
        });
        d.activePaletteId = id;
      });
    });
    const some = await read(f, `pf://doc/${HERO_ID}/palette`);
    expect(some.palettes).toEqual([
      {
        id: expect.any(String) as string,
        name: 'test',
        colors: ['#00000000', '#ff8000', '#01020380'],
        ramps: [{ name: 'warm', indices: [1, 2] }],
      },
    ]);
    expect(some.active).toBe((some.palettes as { id: string }[])[0]?.id);
  });

  it('animation resources: directed, undirected and mirrored', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    await f.call('anim_create', { doc: HERO_ID, group: 'run', direction: 'side', frames: 3 });
    await f.call('frame_set_meta', {
      doc: HERO_ID,
      animation: { group: 'run', direction: 'side' },
      frame: 1,
      durationMs: 250,
      events: ['step'],
      markers: { hand_r: { x: 3, y: 4 } },
    });
    const run = await read(f, `pf://doc/${HERO_ID}/animations/run/side`);
    expect(run).toMatchObject({
      doc: HERO_ID,
      label: 'run/side',
      group: 'run',
      direction: 'side',
      mirrorOf: null,
    });
    const frames = run.frames as {
      index: number;
      durationMs: number;
      events: string[];
      markers: object;
    }[];
    expect(frames.map((fr) => fr.index)).toEqual([0, 1, 2]);
    expect(frames[1]).toMatchObject({ durationMs: 250, events: ['step'] });
    expect(frames[1]?.markers).toEqual({ hand_r: { x: 3, y: 4 } });

    const idle = await read(f, `pf://doc/${HERO_ID}/animations/default`);
    expect(idle).toMatchObject({ label: 'default', direction: null });
    expect((idle.frames as unknown[]).length).toBeGreaterThan(0);

    await f.call('rig_mirror_animation', { doc: HERO_ID, source: frame0, direction: 'left' });
    const mirror = await read(f, `pf://doc/${HERO_ID}/animations/default/left`);
    expect(mirror).toMatchObject({ label: 'default/left', mirrorOf: 'default' });
    expect(mirror.frames).toEqual(idle.frames);
  });

  it('resources/list names the open documents and their animations', async () => {
    const f = await mcpFixture();
    expect((await f.client.listResources()).resources.map((r) => r.uri)).toEqual(['pf://docs']);
    await f.call('doc_open', { path: f.hero });
    const uris = (await f.client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        'pf://docs',
        `pf://doc/${HERO_ID}/summary`,
        `pf://doc/${HERO_ID}/palette`,
        `pf://doc/${HERO_ID}/rig`,
        `pf://doc/${HERO_ID}/animations/default`,
      ]),
    );
    for (const uri of uris) await read(f, uri); // every listed URI can be read
  });

  it('answers unknown documents, animations and URIs with MCP errors', async () => {
    const f = await mcpFixture();
    await f.call('doc_open', { path: f.hero });
    const noDoc = await rejected(f.client.readResource({ uri: 'pf://doc/doc_nope/summary' }));
    expect(noDoc.code).toBe(RESOURCE_NOT_FOUND);
    expect(noDoc.data).toMatchObject({ uri: 'pf://doc/doc_nope/summary', available: [HERO_ID] });
    const noAnim = await rejected(
      f.client.readResource({ uri: `pf://doc/${HERO_ID}/animations/nope/side` }),
    );
    expect(noAnim.code).toBe(RESOURCE_NOT_FOUND);
    expect((noAnim.data as { available: string[] }).available).toContain('default');
    const wrongDir = await rejected(
      f.client.readResource({ uri: `pf://doc/${HERO_ID}/animations/default/left` }),
    );
    expect(wrongDir.code).toBe(RESOURCE_NOT_FOUND);
    for (const uri of [
      'pf://nothing',
      'https://example.com/docs',
      `pf://doc/${HERO_ID}`,
      `pf://doc/${HERO_ID}/palettes`,
      `pf://doc/${HERO_ID}/summary/extra`,
      `pf://doc/${HERO_ID}/animations`,
      `pf://doc/${HERO_ID}/animations/a/b/c`,
      'pf://doc//summary',
      'pf://docs/extra',
    ]) {
      expect((await rejected(f.client.readResource({ uri }))).code, uri).toBe(RESOURCE_NOT_FOUND);
    }
    const malformed = await rejected(f.client.readResource({ uri: 'pf://doc/%E0%A4%A/summary' }));
    expect(malformed.code).toBe(-32602);
  });

  it('are not available while calls are forwarded to pf serve', async () => {
    const f = await mcpFixture({
      prepare: ({ base }) =>
        writeServerInfo(base, {
          pid: process.pid,
          port: 4321,
          token: 't',
          protocolVersion: SERVER_PROTOCOL_VERSION,
        }),
    });
    expect((await f.client.listResources()).resources.map((r) => r.uri)).toEqual(['pf://docs']);
    const err = await rejected(f.client.readResource({ uri: 'pf://docs' }));
    expect(err.data).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    const unknown = await rejected(f.client.readResource({ uri: 'pf://nope' }));
    expect(unknown.code).toBe(RESOURCE_NOT_FOUND);
  });
});
