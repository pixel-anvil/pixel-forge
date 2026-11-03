/**
 * Tool groups (TG.1): every op belongs to exactly one group. A transport can list only some groups
 * (`pf mcp --tools core,rig`) to keep the tool list small. The group is a required field of
 * {@link OpSpec}, so an op without one does not compile and `defineOp` refuses it at load time.
 * To add a group: append its name to {@link TOOL_GROUPS} and describe it in {@link TOOL_GROUP_INFO}
 * (the compiler insists on both); the server instructions and the tests pick it up from there.
 * @packageDocumentation
 */

/** Every group name, in the order the server instructions list them. */
export const TOOL_GROUPS = ['core', 'rig', 'palette', 'convert'] as const;

/** A tool group name. */
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * What each group holds, as one short line for the server instructions. A new group needs an entry
 * here (the record is exhaustive over {@link ToolGroup}).
 */
export const TOOL_GROUP_INFO: Readonly<Record<ToolGroup, string>> = {
  core: 'documents, frames, animations, layers, cels, import/export, renders, pixel grids, lint, undo',
  rig: 'bones, poses, presets, templates, parts and overrides',
  palette: 'palette editing, sorting, colour ramps, remaps, generation and skins',
  convert: 'turn a PNG image or a layer into pixel art (crop, grid, downscale, palette, dither)',
};

/** True when `value` is a group name. */
export function isToolGroup(value: unknown): value is ToolGroup {
  return typeof value === 'string' && (TOOL_GROUPS as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated group list (`"core,rig"`, the value of `--tools` and `PF_TOOLS`).
 * `all` stands for every group. Blanks and duplicates are ignored; the result follows
 * {@link TOOL_GROUPS} order.
 * @throws Error naming the unknown word and the valid ones, or when the list is empty.
 */
export function parseToolGroups(text: string): ToolGroup[] {
  const words = text
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '');
  if (words.length === 0) {
    throw new Error(`no tool group given; use "all" or a list of: ${TOOL_GROUPS.join(', ')}`);
  }
  const chosen = new Set<ToolGroup>();
  for (const word of words) {
    if (word === 'all') {
      for (const g of TOOL_GROUPS) chosen.add(g);
    } else if (isToolGroup(word)) {
      chosen.add(word);
    } else {
      throw new Error(
        `unknown tool group ${JSON.stringify(word)}; valid: all, ${TOOL_GROUPS.join(', ')}`,
      );
    }
  }
  return TOOL_GROUPS.filter((g) => chosen.has(g));
}
