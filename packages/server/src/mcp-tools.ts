/**
 * The tool half of the MCP server: the `tools/list` payload and the translation of an op result
 * ({@link OpCallResult}) into an MCP `CallToolResult`.
 *
 * - `tools/list` is `mcpTools(registry)` without `outputSchema` (it is most of the bytes, and the
 *   text of an image tool is not its full output, so it could not match it).
 * - A success is compact JSON in a text block, the `{ok, op, output, doc?, warnings?}` envelope of
 *   `docs/contracts/OPERATIONS.md`; an output with a top-level `image` also yields an `image`
 *   content block, and only `image.data` is dropped from the text.
 * - A failure is `isError: true` whose text is the `{code, message, details}` of the `OpError`.
 * @packageDocumentation
 */
import type { McpToolDefinition, OpCallResult, OpErrorJson } from '@pixel-forge/ops';

/** A tool as `tools/list` returns it: a {@link McpToolDefinition} without `outputSchema`. */
export type ListedTool = Omit<McpToolDefinition, 'outputSchema' | 'inputSchema'> & {
  readonly inputSchema: { readonly type: 'object' } & Readonly<Record<string, unknown>>;
};

/** The route of the op behind a tool: the `_meta['pixel-forge/op']` of its definition. */
export function opOfTool(tool: Pick<McpToolDefinition, '_meta'>): string {
  return tool._meta['pixel-forge/op'];
}

/**
 * The `tools/list` entries: every definition of `mcpTools(registry)` with `outputSchema` removed
 * (ADR-003 keeps it in `generated/mcp-tools.json` for the contract; the wire does not need it).
 */
export function listedTools(definitions: readonly McpToolDefinition[]): ListedTool[] {
  return definitions.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: { ...def.inputSchema, type: 'object' as const },
    annotations: def.annotations,
    _meta: def._meta,
  }));
}

/** A content block of a tool result. */
export type ToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** What a `tools/call` returns. */
export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: true;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A top-level `image` of an op output that carries PNG (or other) bytes. */
function imageOf(output: unknown): { data: string; mimeType: string } | undefined {
  if (!isRecord(output) || !isRecord(output.image)) return undefined;
  const { data, mimeType } = output.image;
  return typeof data === 'string' && typeof mimeType === 'string' ? { data, mimeType } : undefined;
}

/** `output` without `image.data` (mimeType, width and height stay). */
function withoutImageData(output: Record<string, unknown>): Record<string, unknown> {
  const image = { ...(output.image as Record<string, unknown>) };
  delete image.data;
  return { ...output, image };
}

/** The error result for an {@link OpErrorJson}: `isError` with the error object as text. */
export function errorResult(error: OpErrorJson): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
}

/** Translates the result of `registry.call` into a `CallToolResult`. */
export function toToolResult(result: OpCallResult): ToolResult {
  if (!result.ok) return errorResult(result.error);
  const image = imageOf(result.output);
  const output =
    image === undefined
      ? result.output
      : withoutImageData(result.output as Record<string, unknown>);
  const text = JSON.stringify({ ...result, output });
  const content: ToolContent[] = [{ type: 'text', text }];
  if (image !== undefined)
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  return { content };
}
