// Tool groups on the MCP server (TG.1): every tool has one group, a restricted list holds only the
// chosen groups plus the two server tools, a hidden tool fails with its group named, tool_groups
// switches groups and sends list_changed, find_tool searches every group.
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_GROUPS, TOOL_GROUP_INFO, mcpTools, registry } from '@pixel-forge/ops';
import { describe, expect, it } from 'vitest';
import { FIND_TOOL_TOOL, TOOL_GROUPS_TOOL, instructionsFor } from '../src/index.js';
import { HERO_ID, mcpFixture } from './mcp-helpers.js';

const names = async (f: Awaited<ReturnType<typeof mcpFixture>>): Promise<string[]> =>
  (await f.client.listTools()).tools.map((t) => t.name);

const groupOfTool = (tool: string): string | undefined =>
  mcpTools(registry).find((t) => t.name === tool)?._meta['pixel-forge/group'];

describe('every tool has exactly one group', () => {
  it('puts each registered tool in one known group, and every group holds a tool', () => {
    const tools = mcpTools(registry);
    const byGroup = new Map<string, string[]>();
    for (const tool of tools) {
      const group = tool._meta['pixel-forge/group'];
      expect(TOOL_GROUPS as readonly string[], tool.name).toContain(group);
      byGroup.set(group, [...(byGroup.get(group) ?? []), tool.name]);
    }
    // a partition: the groups together hold each tool once
    expect([...byGroup.values()].flat().sort()).toEqual(tools.map((t) => t.name).sort());
    expect([...byGroup.keys()].sort()).toEqual([...TOOL_GROUPS].sort());
  });
});

describe('default (all groups)', () => {
  it('lists every tool, no server tools, no list_changed capability', async () => {
    const f = await mcpFixture();
    const listed = await names(f);
    expect(listed).toEqual(mcpTools(registry).map((t) => t.name));
    expect(listed).not.toContain(TOOL_GROUPS_TOOL);
    expect(listed).not.toContain(FIND_TOOL_TOOL);
    expect(f.client.getServerCapabilities()?.tools).toEqual({});
    // asking for every group by hand is the same as the default
    const g = await mcpFixture({ serverOptions: { tools: [...TOOL_GROUPS] } });
    expect(await names(g)).toEqual(listed);
  });

  it('names the groups and what they hold in the instructions', async () => {
    const f = await mcpFixture();
    const text = f.client.getInstructions() ?? '';
    expect(text).toBe(instructionsFor());
    for (const g of TOOL_GROUPS) expect(text).toContain(`${g} = ${TOOL_GROUP_INFO[g]}`);
    expect(text).not.toContain(TOOL_GROUPS_TOOL);
  });

  it('does not know tool_groups or find_tool', async () => {
    const f = await mcpFixture();
    const r = await f.call(TOOL_GROUPS_TOOL);
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe('UNKNOWN_OP');
  });
});

describe('--tools core', () => {
  const core = { serverOptions: { tools: ['core'] as const } };

  it('lists the core tools and the two server tools, nothing of rig', async () => {
    const f = await mcpFixture(core);
    const listed = await names(f);
    const expected = mcpTools(registry)
      .filter((t) => t._meta['pixel-forge/group'] === 'core')
      .map((t) => t.name);
    expect(listed).toEqual([...expected, TOOL_GROUPS_TOOL, FIND_TOOL_TOOL]);
    expect(listed).not.toContain('rig_set_pose');
    expect(f.client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    expect(f.client.getInstructions()).toContain('started with: core');
  });

  it('fails a call to a hidden tool with a message that names the group', async () => {
    const f = await mcpFixture(core);
    const r = await f.call('rig_set_pose', { doc: f.hero });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe('REFUSED');
    expect(String(r.json.message)).toContain('group "rig"');
    expect(String(r.json.message)).toContain(TOOL_GROUPS_TOOL);
    expect(r.json.details).toMatchObject({ reason: 'tool-group-hidden', group: 'rig' });
    // and a tool that does not exist is still unknown
    const unknown = await f.call('no_such_tool');
    expect(unknown.json.code).toBe('UNKNOWN_OP');
    expect(unknown.json.details).not.toHaveProperty(
      'available',
      expect.arrayContaining(['rig_set_pose']),
    );
  });

  it('runs a core tool as usual', async () => {
    const f = await mcpFixture(core);
    const r = await f.call('doc_open', { path: f.hero });
    expect(r.isError).toBe(false);
  });

  it('tool_groups shows the state without changing anything', async () => {
    const f = await mcpFixture(core);
    const r = await f.call(TOOL_GROUPS_TOOL);
    expect(r.isError).toBe(false);
    expect(r.json.enabled).toEqual(['core']);
    expect(r.json.groups).toMatchObject({ core: { listed: true }, rig: { listed: false } });
    expect(r.json).not.toHaveProperty('added');
  });

  it('tool_groups enables rig, sends list_changed, and the tools appear and work', async () => {
    const f = await mcpFixture(core);
    let notices = 0;
    f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notices += 1;
    });
    const open = await f.call('doc_open', { path: f.hero });
    expect(open.isError).toBe(false);

    const r = await f.call(TOOL_GROUPS_TOOL, { enable: ['rig'] });
    expect(r.isError).toBe(false);
    expect(r.json.enabled).toEqual(['core', 'rig']);
    expect(r.json.added).toContain('rig_set_pose');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notices).toBe(1);

    const listed = await names(f);
    expect(listed).toContain('rig_set_pose');
    expect(listed).toContain(TOOL_GROUPS_TOOL);
    const read = await f.call('rig_read_pose', {
      doc: HERO_ID,
      animation: { group: 'default' },
      frame: 0,
    });
    expect(read.isError, read.text).toBe(false);

    // enabling again changes nothing and sends nothing
    const again = await f.call(TOOL_GROUPS_TOOL, { enable: ['rig'] });
    expect(again.json).not.toHaveProperty('added');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notices).toBe(1);
  });

  it('tool_groups can hide a group again, and a hidden tool fails again', async () => {
    const g = await mcpFixture(core);
    await g.call(TOOL_GROUPS_TOOL, { enable: ['rig'] });
    await g.call(TOOL_GROUPS_TOOL, { disable: ['rig'] });
    expect(await names(g)).not.toContain('rig_set_pose');
    expect((await g.call('rig_set_pose', {})).json.code).toBe('REFUSED');
  });

  it('tool_groups rejects bad arguments with BAD_INPUT', async () => {
    const f = await mcpFixture(core);
    for (const args of [
      { enable: ['nope'] },
      { enable: 'rig' },
      { enable: ['rig'], disable: ['rig'] },
    ]) {
      const r = await f.call(TOOL_GROUPS_TOOL, args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.code).toBe('BAD_INPUT');
    }
  });

  it('find_tool searches hidden tools too and returns their group', async () => {
    const f = await mcpFixture(core);
    const r = await f.call(FIND_TOOL_TOOL, { query: 'joint check' });
    expect(r.isError).toBe(false);
    const matches = r.json.matches as { tool: string; group: string; listed: boolean }[];
    expect(matches[0]).toMatchObject({ tool: 'rig_joint_check', group: 'rig', listed: false });
    for (const m of matches) expect(m.group).toBe(groupOfTool(m.tool));
    const one = await f.call(FIND_TOOL_TOOL, { query: 'undo', limit: 1 });
    expect((one.json.matches as unknown[]).length).toBe(1);
    expect(((one.json.matches as { listed: boolean }[])[0] as { listed: boolean }).listed).toBe(
      true,
    );
    expect((await f.call(FIND_TOOL_TOOL, { query: '  ' })).json.code).toBe('BAD_INPUT');
    expect((await f.call(FIND_TOOL_TOOL, { query: 'zzzzqqqq' })).json.matches).toEqual([]);
  });

  it('traces the server tools without an op', async () => {
    const f = await mcpFixture(core);
    await f.call(FIND_TOOL_TOOL, { query: 'undo' });
    const record = JSON.parse(f.traces.at(-1) ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({ tool: FIND_TOOL_TOOL, op: null, ok: true });
  });
});

describe('size of tools/list per group set', () => {
  it('core alone is under 45 KB', async () => {
    const f = await mcpFixture({ serverOptions: { tools: ['core'] } });
    const { tools } = await f.client.listTools();
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    // TG.1: measured 43,189 bytes with the two server tools (core alone 42,190; all groups 83,506).
    // E4.5: 43,497 (the `convert` name in the tool_groups enum adds 308 bytes).
    expect(bytes).toBeLessThan(45_000);
  });

  it('keeps the convert tools out of core and the convert group under 10 KB (E4.5)', async () => {
    const core = await mcpFixture({ serverOptions: { tools: ['core'] } });
    const names = (await core.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('image_to_sprite');
    expect(names).not.toContain('convert_apply');
    const only = await mcpFixture({ serverOptions: { tools: ['convert'] } });
    const { tools } = await only.client.listTools();
    expect(tools.map((t) => t.name).slice(0, 2)).toEqual(['convert_apply', 'image_to_sprite']);
    expect(Buffer.byteLength(JSON.stringify({ tools }))).toBeLessThan(10_000);
  });
});
