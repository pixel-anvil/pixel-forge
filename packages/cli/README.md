# @pixel-forge/cli

The pf binary: serve, mcp, check, convert, render, export, lint, override import, pack/unpack.

**Depends on:** `server`, `ops` (and the npm packages `commander` and `zod`)

**Status:** T5.6a done: the `pf` shell, `pf mcp`, `pf check`, the registry-driven subcommands and the single-file bundle. Not built yet (T5.6b and later): the hand-named commands (`render`, `export`, `lint`, `override *`, `pack`, `unpack`, `godot install`) and `pf serve`.

## Build and run

`pnpm build` runs `tsc -b` (the library in `dist/`, `exports` unchanged) and then `tsup`, which writes **`bundle/pf.mjs`**: one ESM file with the workspace packages, the MCP SDK, zod and commander inlined (about 1.9 MB). It needs nothing next to it, so it runs from any directory. The `bin` entry of `package.json` is `pf` -> `bundle/pf.mjs`. The version is `version` of this `package.json`, read at build time (`tsup.config.mjs`); unbundled code reports `0.0.0-dev`.

```sh
pnpm build
node packages/cli/bundle/pf.mjs --version
ln -s "$PWD/packages/cli/bundle/pf.mjs" ~/.local/bin/pf      # any folder on PATH; then: pf --version
```

Do not use `pnpm link`: pnpm 12 has no `--global` form, and `pnpm link .` edits `package.json`, the lockfile and `pnpm-workspace.yaml`.

`pnpm test` builds first. The bundle tests start `bundle/pf.mjs` as a real process and build it when it is missing.

## Commands

Exit codes everywhere: **0** ok, **1** an op, step or expectation failed, **2** usage error (bad flag, missing flag, unreadable or invalid script).

| Command                                    | What it does                                                    |
| ------------------------------------------ | --------------------------------------------------------------- |
| `pf --version`, `pf version`               | Print the version.                                              |
| `pf mcp`                                   | MCP server over stdio (FR-AI-10).                               |
| `pf check --script steps.json --out <dir>` | Run a script headlessly (FR-HARN-01).                           |
| `pf <group> <verb> ...`                    | One subcommand per registry op (from `cliMetadata`); see below. |

Flags shared by every command that opens documents: `--root <dir>` (repeatable; the workspace roots, default `PF_WORKSPACE_ROOTS`, else the working directory) and `--home <dir>` (the base folder for lockfiles and `server.json`; default `PF_HOME`, else `~/.pixel-forge`; tests pass a temp folder).

### `pf mcp`

`pf mcp [--root <dir>]... [--trace [file]]`. stdout carries the protocol and nothing else. `--trace` writes one JSON line per tool call to the file, or to **stderr** when no file is given; never to stdout. SIGINT and SIGTERM close the server (the running call finishes, the documents close, the lockfiles are released) and exit 0. A second signal, or a close that fails, exits 1 at once. When the client closes stdin the process exits 0 by itself.

### `pf check`

`pf check --script steps.json --out <dir> [--root <dir>]...` runs the steps in order against one `DocumentHost`, then writes `<dir>/report.json` and the PNGs of image outputs. stdout gets one line of JSON (`{ok, report, steps, passed, failed, skipped}`); failed steps are described on stderr. Lint findings never change the exit code. The host is disposed on every path, so lockfiles are released.

**Script format** (zod schema `Script` in `src/check-script.ts`; T5.9's scenario scripts depend on it):

```json
{
  "steps": [
    {
      "id": "open",
      "op": "doc.open",
      "input": { "path": "hero.pxf" },
      "expect": { "output": { "name": "hero" } }
    },
    { "op": "doc.summary", "input": { "doc": "${open.output.doc}" } },
    {
      "op": "rig.bake",
      "input": { "doc": "${open.output.doc}", "animation": { "group": "default" }, "mode": "new" },
      "expect": { "ok": false, "code": "CONFIRM_REQUIRED" },
      "continueOnError": true
    }
  ]
}
```

- A step is `{ id?, op, input?, expect?, continueOnError? }`. `op` is an op name (`doc.open`), `input` its input (default `{}`; destructive ops take `"confirm": true` in it). `id` is `[A-Za-z_][A-Za-z0-9_-]*`, unique. Unknown keys are an error (exit 2).
- **References.** A **whole-string** value `"${stepId.output.path.to.value}"` anywhere in `input` (or in `expect.output`) is replaced by that value from the output of an earlier step, **keeping its JSON type** (number, object, array). Path segments are keys, or indexes for arrays (`layers.0.id`); `"${stepId.output}"` is the whole output. A string that only contains `${...}` is left as it is. Only steps with an `id` can be referenced. The step must come earlier (checked before anything runs: exit 2). At run time a reference to a step that failed, or to a missing path, fails the step.
- **`expect`** is `{ ok?, code?, output? }`. A step with no `expect` must succeed. `ok` is the expected outcome (default true; false when only `code` is given). `code` is the expected `OpError` code (implies `ok: false`). `output` is a **deep partial match**: every key given must be present and equal, extra keys are ignored, arrays must have the same length and match element by element. A step whose expectations hold has status `passed`, even if the op failed on purpose.
- **Failure.** The first failed step stops the run unless that step has `"continueOnError": true`; the steps after it are reported as `skipped`.
- **Paths.** `path`, `file` and `outlineFile` inputs that are relative resolve against the **script's folder**. The workspace roots are the script's folder, `--out` and any `--root`, so a file elsewhere is refused with `NOT_ALLOWED`.
- **Images.** Every step whose output has an `image` has its PNG decoded and written to `<out>/<NN>-<id or op>.png` (`NN` is the 1-based step number, two digits).

**`report.json`**:

```text
{ version: 1, ok, script, totalMs, counts: {passed, failed, skipped},
  steps: [ { index, id?, op, status: "passed"|"failed"|"skipped", ok: boolean|null, ms,
             output?, error?, doc?, image?: {file, width, height}, problems?: string[] } ],
  lint:  [ { doc, path?, count, findings } | { doc, path?, error } ] }
```

`output` is the op output with `image.data` replaced by `image.file`; `problems` lists unmet expectations or an unresolved reference; `lint` is `lint.run` over every document still open after the last step (also after a failure). The sample script is `test/fixtures/sample.steps.json`.

### Registry subcommands

`addRegistryCommands(program, ctx)` turns every entry of `cliMetadata(registry)` into a subcommand (`pf rig set-pose`, `pf render frame`, `pf lint`, `pf doc create`, ...). `pf <command> --help` lists the flags, one per top-level input field (`--duration-ms` for `durationMs`).

- **Values.** `string` flags take text (a choice list is enforced), `integer` and `number` flags are checked, `boolean` flags take no value (`--visible`) or `=true|false`, `json` flags take JSON, and a word that is not valid JSON is a string (`--frame 2`, `--frame frm_abc`, `--animation '{"group":"run"}'`). A bad value or a missing required flag exits 2.
- **Documents.** `--doc <path>` replaces the `doc` id: the file is opened first and its id passed to the op. Relative paths (and `path`, `file`, `outlineFile` values) resolve against the working directory; they must be inside the workspace roots.
- **Writing.** Mutating ops (`mutate`, `destructive`, and `io.import`) change the file only with `--save` (`doc.save` after the op). Without it the op runs on the opened copy and the output says `"saved": false, "note": "nothing was written ..."`. `pf doc create` takes `--save <path>` instead. Read ops have no `--save`.
- **Destructive ops** take the registry's own `--confirm`; without it the op fails with `CONFIRM_REQUIRED` (exit 1).
- **Output.** One line of compact JSON on stdout: `{ok, op, output, doc?, warnings?, saved?, note?}`. An op whose output has an image requires `--out <file>`: the PNG is written there and `output.image` carries `file` instead of `data`.
- **Failure.** An op failure prints its `OpErrorJson` (`{code, message, details}`) on stderr and exits 1.

The one-shot commands keep nothing between runs: `doc open`, `doc undo` and `doc redo` are only useful inside `pf check` and `pf mcp`.

T5.6b adds friendlier hand-named commands on top. The wiring is reusable: `addOpCommand(parent, ctx, spec)` registers one op, `runOpCommand` runs it, `optionFor` builds a flag, and `openHost`, `rootOption`, `homeOption`, `resolvePathInputs` and `imageOf`/`writeImage` are exported for the same purpose. A command may not use the names `mcp`, `check` or `version`, and an op input field may not be called `root`, `home`, `save` or `out`.

## Library

`dist/index.js` exports `runCli(argv, env?)` (the whole CLI in process; `env` replaces the streams, cwd, environment variables and signal source), `createProgram`, `runCheck`, `runMcp` and the pieces above. The bundle's entry is `src/bin.ts`.

## Tests

`test/bundle.test.ts` and `test/mcp.test.ts` start the real bundle (from a temp folder, with a temp `--home`); the other tests run `runCli` in process, which is what coverage measures (`cli` is held to 85% lines). Fixtures: the synthetic hero and `test/fixtures/sample.steps.json`.
