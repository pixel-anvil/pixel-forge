# @pixel-forge/server

DocumentHost, lockfiles and discovery, WS sync, HTTP, MCP transports, providers, keychain and workspace roots.

**Depends on:** `ops`, `io` (only for the Node `FileSystem` and `Clock` of `@pixel-forge/io/node`)

**Status:** T5.4 done (DocumentHost, lockfiles, `server.json` helpers, workspace roots). Transports, sync, providers and keychain are later cards.

## DocumentHost

`createDocumentHost(options)` returns an `OpHost` (the contract the ops run against). It wraps `createMemoryHost` and adds ownership and path safety. `fs` and `clock` default to `nodeFileSystem()` and `systemClock` from `@pixel-forge/io/node`.

```ts
const host = createDocumentHost({ roots: resolveWorkspaceRoots({ roots: flags }) });
await registry.execute('doc.open', { path }, { host });
// on shutdown
await host.dispose();
```

- **Base folder.** `baseDir` (default `~/.pixel-forge`) holds `locks/` and `server.json`. Tests inject a temp folder and never touch the real home.
- **Workspace roots** (NFR-06). `resolvePath` folds `..`, follows every symlink (also dangling ones and links after `..`) and checks the **physical** path against the roots, which are themselves resolved. It returns the canonical path, so two names of one file are one document. Outside every root: `NOT_ALLOWED`; relative with roots configured: `BAD_INPUT`. `resolveWorkspaceRoots` picks explicit roots, else `PF_WORKSPACE_ROOTS` (separated like `PATH`), else the working directory. Windows paths are not supported yet. A link swapped between `resolvePath` and the file access is not detected.
- **Ownership** (spec 6.5). `adopt` with a path takes `<baseDir>/locks/<sha1(path)>.lock` containing `{pid, host}`; `rebind` takes the new path's lock first, then releases the old one, and a `DOC_LOCKED` leaves the document untouched; `close` and `dispose` release; an unsaved document holds no lock. A clash is `OpError('DOC_LOCKED')` with `details.pid` (plus `host`, `path`, `lockFile`). Lockfiles are never stored next to the document. Adopt, rebind and close run one at a time.
- **Creation** writes a private temp file and hard-links it to the lock name: an exclusive create that never shows a partial record.
- **Stale locks.** A lock whose pid is dead on this host (or a corrupt file) is reclaimed: renamed aside (one of several concurrent reclaimers wins the rename), verified to be the record judged stale, deleted, then everyone races on the exclusive create again. A lock written by **another hostname** is never reclaimed automatically, because its pid says nothing here; delete the file named in `details.lockFile` if its owner is gone. A recycled pid reads as alive (safe direction).
- **Release** is best effort: an explicit `release()`, and a synchronous sweep on normal process `exit` (`releaseOnExit: false` turns it off). Signals are the caller's to handle (call `dispose()` before exiting). A crash leaves the file, and the stale check covers it.

## Discovery

`writeServerInfo`, `readServerInfo`, `discoverServer`, `removeServerInfo` manage `<baseDir>/server.json` `{pid, port, token, protocolVersion}` (mode 0600, written by rename). `discoverServer` returns the running server, or `undefined` and deletes a stale (dead pid) or invalid entry. Nothing listens yet.

## Tests

Two-process tests run `test/fixtures/child.mjs` against the built `dist/` (`pnpm build` first; `pnpm test` at the root builds through `typecheck`).
