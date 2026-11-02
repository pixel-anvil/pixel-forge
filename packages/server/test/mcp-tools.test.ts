// The MCP tools over an in-process client: every listed tool is called successfully at least once,
// each mutating call adds exactly one undo entry labelled "AI: <op>". The scenario table is checked
// against tools/list, so a new tool without a scenario fails the suite.
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
      expect(tool.description, tool.name).toContain('origin top-left');
    }
    expect(f.handle.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('keeps every description within 800 characters', async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    const long = tools.filter((t) => (t.description ?? '').length > 800);
    expect(long.map((t) => `${t.name}: ${String(t.description?.length)}`)).toEqual([]);
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    expect(bytes).toBeLessThan(80_000); // the report states the exact figure
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
