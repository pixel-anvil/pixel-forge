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
