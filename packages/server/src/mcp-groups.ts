/**
 * Tool groups on the MCP server (TG.1): which groups `tools/list` shows, the two small server tools
 * that go with a restricted list (`tool_groups`, `find_tool`), and the error of a call to a hidden
 * tool. The ops themselves carry their group (`OpSpec.group`); this file only filters and explains.
 *
 * - With every group enabled (the default) nothing here shows: no extra tool, no extra capability.
 * - With fewer groups, `tools/list` holds the enabled groups plus `tool_groups` and `find_tool`.
 *   `tool_groups` switches groups at run time and the server sends `notifications/tools/list_changed`;
 *   a client that ignores the notification still has `--tools` / `PF_TOOLS` at startup.
 * - There is no `call_tool` wrapper on purpose: it would hide the real schemas and annotations.
 * @packageDocumentation
 */
import { OpError, TOOL_GROUPS, TOOL_GROUP_INFO, isToolGroup } from '@pixel-forge/ops';
import type { McpToolDefinition, ToolGroup } from '@pixel-forge/ops';
import { errorResult } from './mcp-tools.js';
import type { ToolResult } from './mcp-tools.js';

/** Name of the server tool that shows and switches the listed groups. */
export const TOOL_GROUPS_TOOL = 'tool_groups';
/** Name of the server tool that searches tool names and descriptions. */
export const FIND_TOOL_TOOL = 'find_tool';

/** A server tool as listed: no `_meta` (there is no op behind it). */
export interface MetaTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object' } & Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}

const groupArray = (what: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: 'string', enum: [...TOOL_GROUPS] },
  description: what,
});

/** The two server tools, listed whenever some group is hidden. */
export const META_TOOLS: readonly MetaTool[] = [
  {
    name: TOOL_GROUPS_TOOL,
    description:
      'Show or change which tool groups are listed. No arguments: list the groups. After a change the server sends tools/list_changed; list the tools again.',
    inputSchema: {
      type: 'object',
      properties: {
        enable: groupArray('Groups to list.'),
        disable: groupArray('Groups to hide.'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: FIND_TOOL_TOOL,
    description:
      'Search all tools, listed or hidden, by name and description. Returns tool, group and whether its group is listed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "rotate arm pose".' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 8.' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

/** The group of a tool definition. */
export const groupOf = (tool: Pick<McpToolDefinition, '_meta'>): ToolGroup =>
  tool._meta['pixel-forge/group'];

/** `core (docs, ...), rig (...)`: the group line of the server instructions. */
export function groupInstructions(initial: readonly ToolGroup[]): string {
  const all = TOOL_GROUPS.map((g) => `${g} = ${TOOL_GROUP_INFO[g]}`).join('; ');
  const base = `Tool groups: ${all}.`;
  if (initial.length === TOOL_GROUPS.length) return base;
  return (
    `${base} This server started with: ${initial.join(', ') || 'no group'}. Tools of other groups are hidden and fail when called: ` +
    `use ${TOOL_GROUPS_TOOL} {"enable":["<group>"]} (then list the tools again) or ${FIND_TOOL_TOOL}.`
  );
}

/** The mutable set of listed groups of one server. */
export interface GroupState {
  /** The groups `tools/list` shows now, in {@link TOOL_GROUPS} order. */
  enabled(): ToolGroup[];
  /** True when `group` is listed. */
  has(group: ToolGroup): boolean;
  /** Enables and disables groups; returns the groups whose state changed. */
  change(enable: readonly ToolGroup[], disable: readonly ToolGroup[]): ToolGroup[];
}

/** Starts the group state with `initial` enabled. */
export function createGroupState(initial: readonly ToolGroup[]): GroupState {
  const on = new Set<ToolGroup>(initial);
  return {
    enabled: () => TOOL_GROUPS.filter((g) => on.has(g)),
    has: (g) => on.has(g),
    change(enable, disable) {
      const changed = new Set<ToolGroup>();
      for (const g of enable) {
        if (!on.has(g)) {
          on.add(g);
          changed.add(g);
        }
      }
      for (const g of disable) {
        if (on.has(g)) {
          on.delete(g);
          changed.add(g);
        }
      }
      return TOOL_GROUPS.filter((g) => changed.has(g));
    },
  };
}

/** The refusal of a call to a tool whose group is not listed: names the group and the way out. */
export function hiddenToolError(
  tool: string,
  group: ToolGroup,
  enabled: readonly ToolGroup[],
): OpError {
  return new OpError(
    'REFUSED',
    `tool ${JSON.stringify(tool)} is in group "${group}", which is not listed on this server. ` +
      `Enable it with ${TOOL_GROUPS_TOOL} {"enable":["${group}"]} and list the tools again, or start the server with --tools including ${group}.`,
    { reason: 'tool-group-hidden', tool, group, enabled: [...enabled] },
  );
}

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const badInput = (message: string): ToolResult =>
  errorResult(new OpError('BAD_INPUT', message, {}).toJSON());

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function groupList(args: Record<string, unknown>, key: string): ToolGroup[] | string {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${key} must be an array of group names`;
  const out: ToolGroup[] = [];
  for (const item of value) {
    if (!isToolGroup(item)) {
      return `${key}: unknown tool group ${JSON.stringify(item)}; valid: ${TOOL_GROUPS.join(', ')}`;
    }
    out.push(item);
  }
  return out;
}

/** What {@link runToolGroups} did. */
export interface ToolGroupsOutcome {
  readonly result: ToolResult;
  /** True when the listed tools changed, so the server sends `tools/list_changed`. */
  readonly changed: boolean;
}

/**
 * Runs the `tool_groups` tool: validates the arguments, switches the groups and reports the state.
 * `added` names the tools that appeared, for a client that does not refresh its list.
 */
export function runToolGroups(
  args: unknown,
  state: GroupState,
  definitions: readonly McpToolDefinition[],
): ToolGroupsOutcome {
  const input = args === undefined ? {} : args;
  if (!isRecord(input)) return { result: badInput('arguments must be an object'), changed: false };
  const enable = groupList(input, 'enable');
  if (typeof enable === 'string') return { result: badInput(enable), changed: false };
  const disable = groupList(input, 'disable');
  if (typeof disable === 'string') return { result: badInput(disable), changed: false };
  if (enable.some((g) => disable.includes(g))) {
    return { result: badInput('a group cannot be in enable and disable'), changed: false };
  }
  const changed = state.change(enable, disable);
  const count = (g: ToolGroup): number => definitions.filter((d) => groupOf(d) === g).length;
  const added = definitions
    .filter((d) => changed.includes(groupOf(d)) && state.has(groupOf(d)))
    .map((d) => d.name);
  return {
    changed: changed.length > 0,
    result: textResult({
      ok: true,
      enabled: state.enabled(),
      groups: Object.fromEntries(
        TOOL_GROUPS.map((g) => [g, { tools: count(g), listed: state.has(g) }]),
      ),
      ...(added.length > 0 ? { added } : {}),
      ...(changed.length > 0
        ? {
            note: 'tools/list changed and list_changed was sent. If the client does not show the change, restart the server with --tools or PF_TOOLS.',
          }
        : {}),
    }),
  };
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Runs the `find_tool` tool: tools whose name or description contains the words of the query, best
 * first (a word in the name counts 3, in the text 1). Searches every group.
 */
export function runFindTool(
  args: unknown,
  state: GroupState,
  definitions: readonly McpToolDefinition[],
): ToolResult {
  if (!isRecord(args) || typeof args.query !== 'string' || words(args.query).length === 0) {
    return badInput('query must be a non-empty string');
  }
  const limit =
    typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.trunc(args.limit))) : 8;
  const query = words(args.query);
  const scored = definitions
    .map((d) => {
      const name = ` ${words(`${d.name} ${d.title}`).join(' ')} `;
      const text = ` ${words(d.description).join(' ')} `;
      let score = 0;
      for (const w of query) {
        if (name.includes(w)) score += 3;
        else if (text.includes(w)) score += 1;
      }
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name))
    .slice(0, limit);
  return textResult({
    ok: true,
    matches: scored.map(({ d }) => ({
      tool: d.name,
      group: groupOf(d),
      listed: state.has(groupOf(d)),
      summary: d.description.split('\n\n')[0] ?? '',
    })),
  });
}
