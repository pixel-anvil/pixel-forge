---
"@pixel-forge/cli": minor
"@pixel-forge/ops": minor
---

CLI: hand-named commands on top of the registry wiring. `pf render <file>`, `pf export <file> <sheet.png>`, `pf lint <file>`, `pf override import|list|resolve`, `pf pack`, `pf unpack` take the document as a positional argument (animations as `group[/direction]`) and keep `--save`, `--confirm`, `--root`, `--home`, JSON on stdout and exit codes 0/1/2. `pf godot install <res-dir>` copies the Godot addon (excluding tests, replacing only `addons/pixel_forge`, refusing a folder without `project.godot`) from `bundle/addon`, which the build now fills. ops: new `override.import` (an edited PNG of a rig frame becomes overrides through `attributeEdit`; the attribution is shared with `pixels.writeGrid` in `frame-edit.ts`), `pxf.pack` and `pxf.unpack` (MCP `pxf_pack`, `pxf_unpack`, CLI `pf pack`, `pf unpack`).
