/** Package identifier, used by the scaffold smoke test. */
export const serverPackage = '@pixel-forge/server' as const;

export { createDocumentHost } from './document-host.js';
export type { DocumentHost, DocumentHostOptions } from './document-host.js';
export {
  acquireLock,
  defaultBaseDir,
  isProcessAlive,
  lockFilePath,
  parseLockRecord,
} from './lockfile.js';
export type { AcquireLockOptions, LockHandle, LockRecord } from './lockfile.js';
export {
  SERVER_PROTOCOL_VERSION,
  discoverServer,
  parseServerInfo,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
} from './discovery.js';
export type { DiscoverOptions, ServerInfo } from './discovery.js';
export { WORKSPACE_ROOTS_ENV, canonicalPath, isInside, resolveWorkspaceRoots } from './roots.js';
export type { WorkspaceRootsOptions } from './roots.js';
export { INSTRUCTIONS, createMcpServer, instructionsFor, serveStdio } from './mcp-server.js';
export { FIND_TOOL_TOOL, META_TOOLS, TOOL_GROUPS_TOOL } from './mcp-groups.js';
export type {
  McpHost,
  McpServerHandle,
  McpServerOptions,
  ServeStdioOptions,
  TraceSink,
} from './mcp-server.js';
export {
  RESOURCE_NOT_FOUND,
  RESOURCE_TEMPLATES,
  listResources,
  readResource,
} from './mcp-resources.js';
export type {
  ResourceContents,
  ResourceContext,
  ResourceEntry,
  ResourceTemplateEntry,
} from './mcp-resources.js';
export { errorResult, listedTools, opOfTool, toToolResult } from './mcp-tools.js';
export type { ListedTool, ToolContent, ToolResult } from './mcp-tools.js';
