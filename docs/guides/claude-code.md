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

- `--root <dir>`: a workspace root. Repeatable. The agent can only open and save files inside the roots. Without it, the working directory is the only root. A relative root resolves against the folder Claude Code starts `pf mcp` in, but document paths in tool calls must be **absolute**: `doc_open` with `hero.pxf` fails with `BAD_INPUT`. You can still say "hero.pxf in this folder" in a prompt: in the T5.8 evaluation the model made every path absolute by itself, with no retry.
- `--trace [file]`: writes one JSON line per tool call to the file, or to stderr when no file is given. Stdout is reserved for the protocol.
- `--tools <groups>` (env `PF_TOOLS`; the flag wins): the tool groups `tools/list` shows, comma-separated: `core`, `rig`, `palette` or `all` (default: all, nothing changes). `core` is documents, frames, animations, layers, cels, import/export, renders, pixel grids, lint and undo (24 tools, about 42 KB of `tools/list` against 83 KB for all 43). `rig` is bones, poses, presets, templates, parts and overrides. `palette` is palette editing, sorting and colour ramps (`palette_edit`, `palette_sort`, `palette_ramp`, `palette_remap`). With fewer groups the server also lists `tool_groups` (show or switch groups; the server sends `notifications/tools/list_changed`, and many clients ignore it, so start with the groups you need) and `find_tool` (search every tool by name and description; it returns the group). A call to a hidden tool fails with `REFUSED` and a message that names its group. Example: `"args": ["mcp", "--root", ".", "--tools", "core,rig"]`.
- `--home <dir>`: the folder for lockfiles and `server.json`. Defaults to `~/.pixel-forge`.

Example with a trace file: `"args": ["mcp", "--root", ".", "--trace", "pf-trace.jsonl"]`.

## How edits behave

- Every mutating call is one undo step, labelled `AI: <op name>` (for example `AI: rig.setPose`). The `undo` and `redo` tools step through that history.
- A call that changes nothing adds no undo step.
- Destructive tools need `"confirm": true`. Today that is `rig_bake` only; without it the call fails with `CONFIRM_REQUIRED`.
- Nothing reaches disk until `doc_save`. Open and edit freely, then save.
- `undo` and `redo` move through the history and add no step of their own.
- A channel with no key on a frame does not return to rest: it interpolates between the keys on other frames, and in a `loop` animation it wraps from the last frame to the first. An offset keyed on one frame leaks into the others, so key offsets on every frame or on none.
- Part keys (`z`, `visible`, `variant`) hold across the animation, so one key is enough. A part's default z is set once, when the part is created: plan the draw order before the first `part_split`.
- A part draws in every frame of every animation. Key `visible: false` on animations that show other art.
- `pixels_write_grid` on a rig frame makes overrides for that frame only. Use them for touch-ups of a few pixels. Art pasted over a pose is not rig animation, it goes stale when the pose changes, and lint does not report it (KNOWN_ISSUES MCP-07).

## Vision versus precision

- Use the render tools for gesture and readability: `render_frame` for one frame, and `render_contact_sheet` to compare the frames of an animation side by side (`bones` and `pivots` draw the skeleton).
- Use `lint` and `rig_joint_check` for exact pixels: off-palette colours, 1 px gaps and joint gaps. `rig_joint_check` passes when `summary.gapCount` is 0. Its output is long; `lint` with `enable: ["rig.jointGap"]` gives pass or fail in a few characters.

Do not judge a 1 px gap by eye. The reverse also holds: 0 findings is not a visual pass. Lint does not see art cut off at the canvas edge (LINT-01) or 1 px holes inside rotated parts (LINT-02), and the joint sweep only covers 30 degrees around rest by default. Look at the contact sheet as well, and check the edges of each tile.

## Rig flat art

The order that worked in the T5.8 evaluation for a sprite sheet with no parts:

1. `doc_create` at the cell size, then `import_file` to bring in the sheet as its own animation.
2. `rig_apply_template`, then refit the rest pose with `rig_edit_bones`, comparing with `render_frame` (`bones: true`). The template's proportions are generic. Do this first: a part keeps the bone pivot it had when it was cut. Rest `x`, `y` are canvas offsets from the parent pivot, and rest `angle` adds to the parent's, so a thigh pointing down under a pelvis at -90 is 180.
3. `import_file` the frame to cut again as its own animation on its own layer, so the sheet stays as a reference.
4. Plan the draw order, then cut each part with `part_split`. Run `part_paint_overlap` and check with `rig_joint_check`.
5. Hide the parts on the reference animation, then `anim_create` and pose with `rig_set_pose`. Use `loop: "once"` for a one-shot such as a jump.

## Example prompts

- **Rig a character:** "Open `hero.pxf` and import `hero_parts.aseprite`. Apply the humanoid-side template with `rig_apply_template`, bind the layers with `rig_bind_parts`, set the pivots with `rig_set_pivot`, then run `rig_joint_check` and fix any gaps."
- **Six-frame run:** "Create a `run` animation with `anim_create`, pose its frames with `rig_set_pose` for a side-view run at 12 fps, render a `render_contact_sheet` and tell me what looks wrong, then run `lint`."
- **Fix 3 px on frame 2:** "Read the area around the eye on frame 2 with `pixels_read_grid`, then paint the three pixels with `pixels_write_grid` using a legend. Check with `render_frame`, then `doc_save`."
- **Match a reference pose:** "Fit the `upper_arm_r` and `lower_arm_r` angles of frame 0 to `reference.png` with `rig_fit_pose` (also `parts: [\"lower_arm_r\"]` for the sleeve), then pass its `bones` and `parts` to `rig_set_pose` and compare with `render_frame`." `exact: false` is not proof that no pose fits (KNOWN_ISSUES FIT-01): fit the parents first, narrow `range`, or raise `maxRenders`.
- **Bake for export:** "Bake the `idle` animation as a new animation with `rig_bake` (with `confirm: true`), then render a contact sheet."

## Troubleshooting

- **`DOC_LOCKED`:** another process owns the document, and `details.pid` is its process id. If that process is a running `pf` session, close it and retry. If the pid is dead on this machine, the stale lock is reclaimed on the next open. If the lock was written on another host, delete the lockfile named in `details.lockFile` once its owner is gone.
- **`NOT_ALLOWED`:** the path is outside every workspace root. Add its folder with another `--root`, or move the file inside a root.
- **`NOT_IMPLEMENTED` while `pf serve` is running:** `pf mcp` hands its calls to a running `pf serve`, which does not serve them yet (KNOWN_ISSUES SRV-02). Stop `pf serve`, or delete its `server.json` from the base folder, then restart the MCP server.
- **Reading the trace:** each line has `at`, `tool`, `op`, `doc` (when relevant), `ms` and `ok`, plus `code` on failure. `undoEntry` names the undo step a successful change created. The trace never contains tool input or image data.

## Known gaps

- Tool calls run one at a time, with no cancellation (KNOWN_ISSUES MCP-02).
- To put a hand or foot on a pixel, pass `targets: {hand_r: {x, y}}` to `rig_set_pose`: IK keys the parent bones (plain angles) and `reached` says if the pivot is within 1 px. A target on the straight line of a folded chain of 3 or more bones can stall (`reached: false`): nudge it 1 px sideways.
- To read a pose, call `rig_read_pose` (or read `pf://doc/{id}/animations/{group}/{direction}/pose/{frame}`). It gives the bone and part values of one frame in the form `rig_set_pose` takes, and `keyed` says which are real keys. The rig resource shows the skeleton only. `render_frame` with `bones: true` returns pivots and tips as numbers.
- No tool changes a part's default z or paints a part's own art (KNOWN_ISSUES RIG-07).

The evidence for this guide is in `docs/ai/MCP_EVAL_M1a.md`.
