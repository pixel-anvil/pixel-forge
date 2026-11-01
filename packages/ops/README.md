# @pixel-forge/ops

Op registry, definitions, handlers, error types and generators (MCP tool JSON, CLI, docs).

**Depends on:** `core`, `lint`, `io`, `rig`, `convert`, plus `schema` (reference and value schemas; added to the dependency-cruiser table in T5.1) and `zod`. No Node built-ins (eslint and dependency-cruiser enforce it): files go through the host's `FileSystem` port.

**Status:** T5.1: `defineOp`, the registry, `OpContext`, `OpError`, safety classes, `confirm`, reference resolution, the `OpHost` interface with an in-memory host, the generators, and the exemplar ops `doc.open`, `doc.summary`, `rig.setPose`. Adding an op: `docs/ai/PLAYBOOKS.md`, "Add an op". Reference of every op: `docs/contracts/OPERATIONS.md` (generated).

## Use

```ts
import { createMemoryHost, registry } from '@pixel-forge/ops';
import { MemoryFileSystem, fixedClock } from '@pixel-forge/io';

const host = createMemoryHost({ fs, clock, roots: ['/work'] }); // server (T5.4) has the real host
const run = { host }; // also: labelPrefix (default 'AI: '), log, validate (default true)
const { doc } = (await registry.execute('doc.open', { path: '/work/hero.pxf' }, run)) as {
  doc: string;
};
await registry.execute(
  'rig.setPose',
  { doc, animation: { group: 'default' }, frame: 0, bones: { upper_arm_r: { angle: -45 } } },
  run,
);
const r = await registry.call('doc.summary', { doc }, run); // envelope, never throws
// r = { ok: true, op, output, doc: { id, version, undoEntry, canUndo, canRedo }, warnings? } | { ok: false, op, error: { code, message, details } }
```

## Ops

`defineOp({ name, safety, summary, description?, input, output, examples, transaction?, mcp?, cli?, handler })` checks the definition when the module loads (name grammar `area.verbNoun`, one-line summary of at most 200 characters, object input, a `doc` field on mutate/destructive ops, no `confirm` field, at least one example whose input (and output, if given) parse) and derives `mcpName` (`rig_set_pose`), `cliCommand` (`['rig', 'set-pose']`), `targetsDocument` (the input has `doc`) and `transactional`.

| Safety        | Handler | Transaction                                                                      |
| ------------- | ------- | -------------------------------------------------------------------------------- |
| `read`        | sync    | none; `ctx.view` is the live store                                               |
| `mutate`      | sync    | the registry opens one (`ctx.tx`), commits after the output check: one undo step |
| `destructive` | sync    | like `mutate`; the registry adds `confirm` and refuses with `CONFIRM_REQUIRED`   |
| `io`          | async   | none, or one via `ctx.transact(fn)` (at most once per call)                      |

`transaction: false` (mutate/destructive only) skips the transaction for the history ops (`doc.undo`/`doc.redo` call `ctx.document.store.undo()`).

## Registry

`createRegistry(ops)` (duplicate names, MCP names or CLI commands throw). `registry` is the built-in one (`ALL_OPS`). `execute(name, input, run)` resolves to the parsed output or rejects with an `OpError`; `call(...)` returns an envelope. Per call:

1. `UNKNOWN_OP` if no op has that name; the input must be a JSON object (`BAD_INPUT`); destructive ops: `confirm` is taken out, the rest parsed, then `confirm !== true` is `CONFIRM_REQUIRED`.
2. A `doc` field is resolved to the hosted document (`NOT_FOUND`, `kind: 'doc'`, with the open ids and a hint to call `doc_open`).
3. Transactional ops (the commit sequence lives once, in `commit.ts`, shared with `ctx.transact`): `store.begin('<labelPrefix><op>')`, handler, output parsed by the op's schema (else `INTERNAL`, `reason: 'bad-output'`), **validate guard**, `commit()`. Any error cancels the transaction, so a failed call leaves no trace (same hash, same version, no history entry). If a change listener of the store throws, the change is already committed: the call succeeds and `warnings` (also sent to `log.warn`) names the failure; it is never reported as `INTERNAL`. A call that changes nothing records nothing (`undoEntry: null`, core no-op detection), so a call adds at most one undo entry.
4. The validate guard (`run.validate`, default on) refuses a change that raises the per-code count of `validate()` errors (`INTERNAL`, `reason: 'invalid-document'`, first findings in `details`). The "before" counts are memoised per store version (never for a rejected state, so retries, pixel-only edits, undo and redo cannot see stale counts), and the pixel content checks of `validate()` (`options.images`) run only for images the call changed (all images when the palette or colour mode changed). Pre-existing errors of an opened file do not block ops.
5. Handlers that return a promise where they must be synchronous are `INTERNAL` (the transaction is cancelled).

## Context (`OpContext`)

`op`, `safety`, `host`, `renderer` (the host's single `RigRenderer`, KNOWN_ISSUES CORE-03), `log` (`debug`/`info`/`warn`, default silent), `hasDocument`, `document` (`HostedDocument`: `id`, `store`, `path`, `file`, `savedVersion`), `view` (the open transaction, else the live store), `doc` (`view.doc`), `tx` (transactional ops only), `transact(fn)` (io ops only, once; same label, same validate guard; call it last: a change it committed stays if the handler fails afterwards), `renderFrame(anim, frame, opts)` (`renderFrame` with the host renderer). Misuse throws `INTERNAL`.

## Errors

`OpError {code, message, details}` with `toJSON()`; codes in `OP_ERROR_CODES` (additive): `BAD_INPUT`, `UNKNOWN_OP`, `NOT_FOUND`, `AMBIGUOUS`, `CONFIRM_REQUIRED`, `REFUSED`, `INVALID_VALUE`, `NOT_ALLOWED`, `DOC_LOCKED`, `CONFLICT`, `BAD_FILE`, `IO_FAILED`, `NOT_IMPLEMENTED`, `INTERNAL`. `toOpError(e)` maps lower-package errors (KNOWN_ISSUES CORE-02):

- `CoreError` `BAD_ARGUMENT`: `details.reason` `unknown-*` -> `NOT_FOUND` with `details.kind` (`animation`, `frame`, `bone`, `view`, `part`, `variant`, `override`), any other reason -> `REFUSED`; `BAD_VALUE` -> `INVALID_VALUE`; `IMAGE_MISSING` -> `BAD_FILE`; `PATCH_CONFLICT` -> `CONFLICT`; `ID_EXHAUSTED` -> `REFUSED`; transaction misuse and `NO_RIG_RENDERER` -> `INTERNAL`. The core `details` are kept (JSON-safe values only).
- `IoError`: `FS_FAILED` -> `IO_FAILED`; `BAD_PXF`, `INVALID_DOCUMENT`, `UNSUPPORTED_VERSION`, `MIGRATION_*` -> `BAD_FILE`; `BAD_INPUT`, `CELL_OUT_OF_RANGE` -> `BAD_INPUT`; `SIZE_MISMATCH`, `DUPLICATE_ANIMATION`, `TOO_LARGE` -> `REFUSED`; `EXISTS` -> `CONFLICT`; `RIG_REQUIRED` -> `INTERNAL`. `AseError` -> `BAD_FILE`.
- `RigError`: `UNKNOWN_*` -> `NOT_FOUND`, `BAD_VALUE`/`BAD_QUANTUM` -> `INVALID_VALUE`, `BAD_ARGUMENT`/`CYCLE` -> `REFUSED` (with `reason`), `IMAGE_MISSING`/`DUPLICATE_BONE` -> `BAD_FILE`. `JointCheckError` -> `INVALID_VALUE`. `ZodError` -> `BAD_INPUT` (`details.issues: [{path: 'a.b', message}]`).
- Anything else -> `INTERNAL` (`details.cause.error`: the class name). Every mapped error has `details.cause: {error, code}`.

## References

Schemas for inputs: `DocRef`, `AnimRef` (`{group, direction?}` or `{id}`), `FrameRef` (index or id), `LayerRef`, `BoneRef`, `PartRef`, `ViewRef`, `VariantRef` (strings). Resolvers over `ctx.doc`: `resolveAnimation`, `resolveAuthoredAnimation` (mirror -> `REFUSED` `mirror-animation` with the source label), `resolveFrame` (`NOT_FOUND` with `count`), `resolveLayer` (id, name or `group/name` path), `resolveBone`, `resolvePart` (part id, part-layer id or part-layer name), `resolveView`, `resolveVariant(part, ref, viewId?)` (a name is looked up in `viewId`'s variants first: names repeat across views), `viewForAnimation`, `requireRig` (`REFUSED` `no-rig`), plus `walkLayers`, `partName`, `animationLabel`. Rule: **an id match wins, then the name**; no match is `NOT_FOUND` with `details.available` (at most `MAX_AVAILABLE` = 50), several are `AMBIGUOUS` with `details.candidates` (ids).

## Host

`OpHost`: `fs`, `clock`, `renderer`, `resolvePath(path)` (normalise; workspace roots -> `NOT_ALLOWED`), `get(id)`, `byPath(path)`, `list()`, `adopt({store, path?, file?})` (registers a document; `CONFLICT` for a duplicate id or path; the server host takes the lockfile here and raises `DOC_LOCKED`), `close(id)`. Documents are addressed by their own `meta.id`. `createMemoryHost({fs, clock, roots?, renderer?})` is the in-process implementation without lockfiles; `normalizePath` folds `.`/`..`.

## Generators

`mcpTools(registry)` (MCP `Tool` objects: `name`, `title`, `description` = summary + description + safety note + conventions + first example, `inputSchema` with `confirm` for destructive ops, `outputSchema` when the output is an object, `annotations` `readOnlyHint`/`destructiveHint`/`openWorldHint: false`, `_meta` with the op name and safety), `cliMetadata(registry)` (per command: words, summary, safety, one option per top-level input field with `kind` `string`/`integer`/`number`/`boolean`/`json` and string-enum `choices`), `operationsMarkdown(registry)`, `generatedFiles(registry)`. JSON Schemas come from `toJsonSchema` (zod `toJSONSchema`, draft 2020-12, `io: 'input'` for inputs; no `$schema`, no safe-integer bounds, no reserved-name lookahead in name patterns: zod stays the authority). Ops hidden with `mcp.hidden` / `cli.hidden` are left out of that transport.

`packages/ops/scripts/gen-ops.mjs` (run by `pnpm gen`; `pnpm gen:check` in `pnpm verify` fails on a stale copy) builds the package incrementally and writes `packages/ops/generated/mcp-tools.json`, `packages/ops/generated/cli.json` (prettier-formatted) and `docs/contracts/OPERATIONS.md`. The committed copies are review snapshots of the contract; the MCP server (T5.5) and the CLI (T5.6a) build from the registry at run time.

## Built-in ops

| Op            | Safety | Notes                                                                                                                                                                                                                                                                                            |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doc.open`    | io     | `readPxf` through `host.fs`, `adopt`; the same path again returns the same id (`alreadyOpen`); `warnings` from the reader.                                                                                                                                                                       |
| `doc.summary` | read   | canvas, palette, skins, layers (`path`, kind, visibility), rig (bones with parent names, parts by part-layer name with variant names, views), animations (label, frames, total duration, mirror source, override count), `version`, `dirty`, undo/redo.                                          |
| `rig.setPose` | mutate | bone keys by bone name/id and part keys by part name/id; channels merge into the stored key, `null` removes it; `changed` lists `bones.<name>` / `parts.<name>`, sorted. Refusals: mirror animation, no rig, an `interp`-only key without a stored channel (`empty-key`), the same entity twice. |
