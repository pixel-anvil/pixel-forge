// The MCP tools over an in-process client: every listed tool is called successfully at least once,
// each mutating call adds exactly one undo entry labelled "AI: <op>". The scenario table is checked
// against tools/list, so a new tool without a scenario fails the suite.
import { CONVENTIONS } from '@pixel-forge/ops';
import { describe, expect, it } from 'vitest';
import { mcpFixture } from './mcp-helpers.js';
import { SCENARIOS, prepare } from './mcp-scenarios.js';

describe('tools/list', () => {
  it('lists every tool without outputSchema and routes by the op in _meta', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
    for (const tool of tools) {
      expect(tool).not.toHaveProperty('outputSchema');
      expect(tool.inputSchema.type).toBe('object');
      expect(tool._meta?.['pixel-forge/op'], tool.name).toEqual(expect.any(String));
      expect(tool.description, tool.name).not.toContain(CONVENTIONS);
      expect(tool.description, tool.name).not.toContain('Edit: one undo step.');
      expect(tool.annotations, tool.name).not.toHaveProperty('title');
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain(
        '"additionalProperties":false',
      );
    }
    expect(f.handle.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('keeps every description within 800 characters', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    const long = tools.filter((t) => (t.description ?? '').length > 800);
    expect(long.map((t) => `${t.name}: ${String(t.description?.length)}`)).toEqual([]);
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    // MCP-04: 75,775 bytes after B0.3 (was 83,005); T5.16 `rig_fit_template` and B0.1 `rig_fit_pose` raised the limit 76,300 -> 82,000 (list: 81,159). E3.3 `rig_apply_preset` raised it 82,000 -> 84,000 (list: 83,499). TG.1 adds no tool to the default list (83,506 bytes). E5.2 `palette_edit`, `palette_ramp`, `palette_sort` raised it 84,000 -> 89,000 (list: 88,627). E5.4 `palette_remap` raised it 89,000 -> 92,000 (list: 91,059). E5.3 `palette_generate` (2,840 bytes) raised it 92,000 -> 95,000 (list: 93,899). E5.5 `skin_set` (about 2.2 KB; list: 96,138) raised it 95,000 -> 98,000; E4.5 `image_to_sprite` and `convert_apply` (group `convert`, about 7.3 KB together) raised it 98,000 -> 104,000 (list: 103,391); E6.1 added the `gif` format, the `group` field and about 440 bytes of text to `import_file` (list: 103,832; limit unchanged at 104,000, 168 bytes of room); E6.2 `.gif` paths for `export` (list: 103,932, 68 bytes of room); E9.2 `rig_copy_pose` and `render_compare` (group `rig`, about 5.5 KB together) raised it 104,000 -> 112,000 (list: 109,452); `core` alone is held under 45,000 in mcp-groups.test.ts.
    expect(bytes).toBeLessThan(112_000);
  });

  it('states the shared conventions once, in the server instructions', async () => {
    const f = await mcpFixture();
    const instructions = f.client.getInstructions() ?? '';
    expect(instructions).toContain('origin top-left, y down, angles deg clockwise, integer px');
    expect(instructions).toContain('"confirm": true');
  });

  it('keeps required fields, enums and the confirm field in the listed schemas', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    const frame = tools.find((t) => t.name === 'rig_bake');
    expect(frame?.inputSchema.required).toEqual(expect.arrayContaining(['doc']));
    expect(frame?.inputSchema.properties).toHaveProperty('confirm');
    expect(frame?.description).toContain('confirm');
    expect(frame?.annotations?.destructiveHint).toBe(true);
    expect(JSON.stringify(tools)).toContain('"enum"');
  });
});

describe('every tool', () => {
  it('has a scenario, and no scenario names a tool that is gone', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(Object.keys(SCENARIOS).sort()).toEqual(names);
  });

  it.each(Object.keys(SCENARIOS))('%s succeeds and records what it should', async (tool) => {
    const scenario = SCENARIOS[tool];
    if (scenario === undefined) throw new Error(tool);
    const f = await mcpFixture();
    const doc = await prepare(f, scenario.base);
    const memo: Record<string, unknown> = {};
    await scenario.setup?.(f, doc, memo);
    const before = scenario.base === 'none' ? [] : f.labels(doc);
    const result = await f.call(tool, scenario.args({ doc, root: f.root, memo }));
    expect(result.isError, result.text).toBe(false);
    expect(result.json.ok).toBe(true);
    const op = (await f.client.listTools()).tools.find((t) => t.name === tool)?._meta?.[
      'pixel-forge/op'
    ];
    if (scenario.base === 'none') {
      // a call that makes or opens its own document: the new document has no entries
      for (const d of f.host.list()) expect(f.labels(d.id)).toEqual([]);
      return;
    }
    const after = f.labels(doc);
    if (scenario.entry === 'one') {
      expect(after).toEqual([...before, `AI: ${String(op)}`]);
      expect((result.json.doc as { undoEntry: number | null }).undoEntry).not.toBeNull();
    } else if (tool === 'undo') {
      expect(after).toEqual(before.slice(0, -1));
    } else if (tool === 'redo') {
      expect(after).toEqual([...before, 'AI: frame.add']);
    } else {
      expect(after, scenario.entry.none).toEqual(before);
    }
  });
});
