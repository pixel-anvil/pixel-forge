---
'@pixel-forge/cli': minor
---

The `pf` command line: `pf --version`, `pf mcp` (stdio MCP server with `--root`, `--trace`, clean SIGINT/SIGTERM shutdown), `pf check --script steps.json --out <dir>` (headless harness: `${step.output.path}` references, `expect`, `report.json`, PNGs, exit codes 0/1/2) and one subcommand per registry op (`--doc <path>`, `--save`, `--confirm`, `--out <file>`). Ships as a single-file `tsup` bundle (`bundle/pf.mjs`, the `pf` bin) built by `pnpm build`.
