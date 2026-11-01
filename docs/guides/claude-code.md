# Using pixel-forge from Claude Code

pixel-forge exposes its operations to Claude Code as an MCP server, `pf mcp`. This guide covers installing the `pf` binary, connecting it, how edits behave, and what to do when a call fails. Tool names below are the ones in `packages/ops/generated/mcp-tools.json`.

## Install

```sh
pnpm build
ln -s "$PWD/packages/cli/bundle/pf.mjs" ~/.local/bin/pf   # any folder on PATH
pf --version
```

`pnpm build` writes `packages/cli/bundle/pf.mjs`, a single file that runs from any directory.

**Do not use `pnpm link`.** pnpm 12 has no `--global` form, and `pnpm link .` edits `package.json`, the lockfile and `pnpm-workspace.yaml`.

## Connect the server

Add a project `.mcp.json` at the root of the folder you work in:

```json
{
  "mcpServers": {
    "pf": {
      "command": "pf",
      "args": ["mcp", "--root", "."]
    }
  }
}
```

The same setup from the command line:

```sh
claude mcp add -s project pf -- pf mcp --root .
```

A project server stays `Pending approval` in `claude mcp list` until you run `claude` in that folder and approve it.

Flags of `pf mcp` (`pf mcp --help` lists them):

- `--root <dir>`: a workspace root. Repeatable. The agent can only open and save files inside the roots. Without it, the working directory is the only root. A relative root resolves against the folder Claude Code starts `pf mcp` in, but document paths in tool calls must be **absolute**: `doc_open` with `hero.pxf` fails with `BAD_INPUT`.
- `--trace [file]`: writes one JSON line per tool call to the file, or to stderr when no file is given. Stdout is reserved for the protocol.
- `--home <dir>`: the folder for lockfiles and `server.json`. Defaults to `~/.pixel-forge`.

Example with a trace file: `"args": ["mcp", "--root", ".", "--trace", "pf-trace.jsonl"]`.

## How edits behave

- Every mutating call is one undo step, labelled `AI: <op name>` (for example `AI: rig.setPose`). The `undo` and `redo` tools step through that history.
- A call that changes nothing adds no undo step.
- Destructive tools need `"confirm": true`. Today that is `rig_bake` only; without it the call fails with `CONFIRM_REQUIRED`.
- Nothing reaches disk until `doc_save`. Open and edit freely, then save.

## Vision versus precision

- Use the render tools for gesture and readability: `render_frame` for one frame, and `render_contact_sheet` to compare the frames of an animation side by side (`bones` and `pivots` draw the skeleton).
- Use `lint` and `rig_joint_check` for exact pixels: off-palette colours, 1 px gaps and joint gaps. `rig_joint_check` passes when `summary.gapCount` is 0.

Do not judge a 1 px gap by eye.

## Example prompts

- **Rig a character:** "Open `hero.pxf` and import `hero_parts.aseprite`. Apply the humanoid-side template with `rig_apply_template`, bind the layers with `rig_bind_parts`, set the pivots with `rig_set_pivot`, then run `rig_joint_check` and fix any gaps."
- **Six-frame run:** "Create a `run` animation with `anim_create`, pose its frames with `rig_set_pose` for a side-view run at 12 fps, render a `render_contact_sheet` and tell me what looks wrong, then run `lint`."
- **Fix 3 px on frame 2:** "Read the area around the eye on frame 2 with `pixels_read_grid`, then paint the three pixels with `pixels_write_grid` using a legend. Check with `render_frame`, then `doc_save`."
- **Bake for export:** "Bake the `idle` animation as a new animation with `rig_bake` (with `confirm: true`), then render a contact sheet."

## Troubleshooting

- **`DOC_LOCKED`:** another process owns the document, and `details.pid` is its process id. If that process is a running `pf` session, close it and retry. If the pid is dead on this machine, the stale lock is reclaimed on the next open. If the lock was written on another host, delete the lockfile named in `details.lockFile` once its owner is gone.
- **`NOT_ALLOWED`:** the path is outside every workspace root. Add its folder with another `--root`, or move the file inside a root.
- **`NOT_IMPLEMENTED` while `pf serve` is running:** `pf mcp` hands its calls to a running `pf serve`, which does not serve them yet (KNOWN_ISSUES SRV-02). Stop `pf serve`, or delete its `server.json` from the base folder, then restart the MCP server.
- **Reading the trace:** each line has `at`, `tool`, `op`, `doc` (when relevant), `ms` and `ok`, plus `code` on failure. `undoEntry` names the undo step a successful change created. The trace never contains tool input or image data.

## Known gaps

- Tool calls run one at a time, with no cancellation (KNOWN_ISSUES MCP-02).
- The rig resource does not list bone or part keys, so the agent reads poses through `render_frame` or `pixels_read_grid` (KNOWN_ISSUES MCP-03).
