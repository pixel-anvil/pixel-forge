# @pixel-forge/server

DocumentHost, lockfiles and discovery, WS sync, HTTP, MCP transports, providers, keychain and workspace roots.

**Depends on:** `ops`, `io` (only for the Node `FileSystem` and `Clock` of `@pixel-forge/io/node`), and the npm package `@modelcontextprotocol/sdk` (1.x)

**Status:** T5.4 done (DocumentHost, lockfiles, `server.json` helpers, workspace roots). T5.5 done (MCP stdio server). HTTP, WS sync, providers and keychain are later cards. `pf mcp` (the `--root`, `--home` and `--trace` flags, SIGINT/SIGTERM) is in `packages/cli` (T5.6a).

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

## MCP server

`createMcpServer({host, registry, trace?, baseDir?, now?, serverInfo?})` returns a handle `{server, forwardedTo, tools, closed, close()}`; `server` is the SDK's low-level `Server`, ready to `connect` to any transport (tests use `InMemoryTransport`). `serveStdio({host, registry, trace?, stdin?, stdout?})` creates it and connects it to stdin/stdout; `closed` resolves when stdin ends or `close()` is called. Closing the connection on any transport disposes the host (documents closed, lockfiles released). Signal handling is the CLI's: call `handle.close()` on SIGINT and SIGTERM.

```ts
const host = createDocumentHost({ roots: resolveWorkspaceRoots({ roots: flags }) });
const mcp = await serveStdio({
  host,
  registry,
  trace: (line) => process.stderr.write(`${line}\n`),
});
await mcp.closed; // stdin ended (the client left): the host is already disposed
```

- **Tools.** `tools/list` is `mcpTools(registry)` without `outputSchema` (about 75 KB for 34 tools). A call is routed by `_meta['pixel-forge/op']` through `registry.call`, so it is one transaction and one undo entry labelled `AI: <op name>` (none when it changes nothing). Calls run one at a time. The result text is the compact JSON envelope `{ok, op, output, doc?, warnings?}` (no `structuredContent`). An output with a top-level `image` also yields an `image` content block (`image/png`, long edge at most 1568) and only `image.data` is dropped from the text.
- **Errors.** An op failure, an unknown tool and a forwarded call are tool results with `isError: true` whose text is the `OpErrorJson` `{code, message, details}`. Nothing here throws a protocol error for a tool call.
- **Forwarding.** At startup `discoverServer(baseDir)` looks for a running `pf serve`; if its `protocolVersion` equals `SERVER_PROTOCOL_VERSION`, every tool call returns `NOT_IMPLEMENTED` (resources too) until M2 (KNOWN_ISSUES SRV-02, `handle.forwardedTo`). Otherwise the documents are hosted in this process. `baseDir` defaults to the host's, else `~/.pixel-forge`.
- **Trace.** stdout belongs to the protocol; the server never writes to it. `trace` is a sink `(line) => void`; it gets one JSON line per tool call, `{at, tool, op, doc?, ms, ok, code?, undoEntry?}`, never tool input or image data. The CLI points it at stderr or a file. A throwing sink is ignored; a failing `dispose()` is reported to it as `{event: 'dispose-failed'}`.
- **Resources** (read-only JSON): `pf://docs`, `pf://doc/{id}/summary` (the `doc.summary` output), `/palette` (colour mode, lock, palettes with hex colours), `/rig` (the `rig` section of the summary), `/animations/{group}/{direction}` and `/animations/{group}` (frames: duration, markers, events, root motion; a mirror shows its source's frames). An unknown document, animation or URI is an MCP error `-32002` (`RESOURCE_NOT_FOUND`); `resources/list` names the open documents. See KNOWN_ISSUES MCP-03 for what the rig resource lacks.
- Why the low-level `Server`: tool schemas are already JSON Schema from the registry (KNOWN_ISSUES MCP-01).

## Tests

`test/mcp-*.test.ts`: an in-process SDK `Client` over `InMemoryTransport` on a real `DocumentHost` in a temp workspace. `mcp-scenarios.ts` holds one scenario per tool and `mcp-tools.test.ts` fails when `tools/list` has a tool without one (add it when you add an op, `docs/ai/PLAYBOOKS.md`). The real-process test (`mcp-stdio.test.ts`, `test/fixtures/mcp-child.mjs`) speaks raw JSON-RPC to a spawned server, checks that stdout is protocol only and that closing stdin releases the lock.

### Ownership tests

Two-process tests run `test/fixtures/child.mjs` against the built `dist/` (`pnpm build` first; `pnpm test` at the root builds through `typecheck`).
