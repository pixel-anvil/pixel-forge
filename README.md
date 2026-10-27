# pixel-forge

pixel-forge is a pixel-art editor and animator for game assets. It has a pixel-aware rig (characters built from part layers on a skeleton, posed with RotSprite rotation, hand-drawn variant swaps, or bake-and-retouch), a typed operation API shared by a CLI, an MCP server and (later) a UI so that LLM agents can drive it and check their own work, and a Godot import plugin that turns a document into an atlas, a frame table and metadata.

**Status: pre-alpha, M1a in progress.** Nothing is published yet and interfaces will change.

## Key ideas

- One headless TypeScript core shared by the CLI, the MCP server and the editor.
- A single document file (`.pxf`) holds the rig, the animations and the rendered frames.
- Frames are always baked; there is no live skeleton in the game.
- Every operation is typed, undoable and reproducible (deterministic output, golden tests).
- The server is local-only (see [SECURITY.md](SECURITY.md)).

## Repository layout

- `packages/` — the pnpm workspace packages (`schema`, `png`, `color`, `raster`, `rig`, `core`, `io`, `lint`, `ops`, `convert`, `server`, `cli`, `testkit`).
- `docs/` — research, specification, plan, ADRs and agent playbooks.
- `fixtures/` — synthetic and CC0 test art.
- `scripts/` — repository tooling.

## Contributing and docs

Start with [AGENTS.md](AGENTS.md) (build/test commands, conventions) and [CONTRIBUTING.md](CONTRIBUTING.md). Design documents are in [docs/](docs/): [spec](docs/01-spec.md), [plan](docs/02-plan.md), [ADRs](docs/adr/README.md).

## Quick start

Coming in M1a.

## Credits

Test fixture: "Hero Swordsman" by tbbk (CC0), see `fixtures/cc0/hero_swordsman/LICENSE.md`.

## License

[MIT](LICENSE)
