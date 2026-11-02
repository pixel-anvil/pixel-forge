# @pixel-forge/cli

## 0.1.0

### Minor Changes

- 1d5e510: CLI: hand-named commands on top of the registry wiring. `pf render <file>`, `pf export <file> <sheet.png>`, `pf lint <file>`, `pf override import|list|resolve`, `pf pack`, `pf unpack` take the document as a positional argument (animations as `group[/direction]`) and keep `--save`, `--confirm`, `--root`, `--home`, JSON on stdout and exit codes 0/1/2. `pf godot install <res-dir>` copies the Godot addon (excluding tests, replacing only `addons/pixel_forge`, refusing a folder without `project.godot`) from `bundle/addon`, which the build now fills. ops: new `override.import` (an edited PNG of a rig frame becomes overrides through `attributeEdit`; the attribution is shared with `pixels.writeGrid` in `frame-edit.ts`), `pxf.pack` and `pxf.unpack` (MCP `pxf_pack`, `pxf_unpack`, CLI `pf pack`, `pf unpack`).
- a514563: The `pf` command line: `pf --version`, `pf mcp` (stdio MCP server with `--root`, `--trace`, clean SIGINT/SIGTERM shutdown), `pf check --script steps.json --out <dir>` (headless harness: `${step.output.path}` references, `expect`, `report.json`, PNGs, exit codes 0/1/2) and one subcommand per registry op (`--doc <path>`, `--save`, `--confirm`, `--out <file>`). Ships as a single-file `tsup` bundle (`bundle/pf.mjs`, the `pf` bin) built by `pnpm build`.
- First release (M1a): the headless core, `.pxf` and `.aseprite` I/O, rig and RotSprite, lint, the operation API, the MCP server, the `pf` CLI and the Godot import addon.

### Patch Changes

- Updated dependencies [1d5e510]
- Updated dependencies [57e8121]
- Updated dependencies [63d2950]
- Updated dependencies [2d2c699]
- Updated dependencies [cf65db9]
- Updated dependencies [d2cea32]
- Updated dependencies [51f51bc]
- Updated dependencies [a6cd5ae]
- Updated dependencies [400c35f]
- Updated dependencies [9cfdc57]
- Updated dependencies [d7424c0]
- Updated dependencies [4ff76c1]
- Updated dependencies
  - @pixel-forge/ops@0.1.0
  - @pixel-forge/server@0.1.0
