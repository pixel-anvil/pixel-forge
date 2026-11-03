// Tool groups: the group list, its parser, and the rule that every built-in op has exactly one group.
import { describe, expect, it } from 'vitest';
import {
  TOOL_GROUPS,
  TOOL_GROUP_INFO,
  isToolGroup,
  mcpTools,
  parseToolGroups,
  registry,
} from '../src/index.js';

describe('tool groups', () => {
  it('describes every group and nothing else', () => {
    expect(Object.keys(TOOL_GROUP_INFO).sort()).toEqual([...TOOL_GROUPS].sort());
    for (const text of Object.values(TOOL_GROUP_INFO)) expect(text.length).toBeLessThan(120);
  });

  it('gives every built-in op exactly one known group, and every group an op', () => {
    const seen = new Map<string, number>();
    for (const op of registry.list()) {
      expect(isToolGroup(op.group), `${op.name}: ${op.group}`).toBe(true);
      seen.set(op.group, (seen.get(op.group) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([...TOOL_GROUPS].sort());
  });

  it('carries the group on every MCP tool definition, one group per tool name', () => {
    const tools = mcpTools(registry);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool._meta['pixel-forge/group'], tool.name).toBe(registry.get(tool.title)?.group);
    }
  });

  it('parses group lists', () => {
    expect(parseToolGroups('rig,core')).toEqual(['core', 'rig']);
    expect(parseToolGroups(' core , core ')).toEqual(['core']);
    expect(parseToolGroups('all')).toEqual([...TOOL_GROUPS]);
    expect(() => parseToolGroups('core,nope')).toThrow(
      /unknown tool group "nope".*valid: all, core/,
    );
    expect(() => parseToolGroups(' , ')).toThrow(/no tool group/);
  });
});
