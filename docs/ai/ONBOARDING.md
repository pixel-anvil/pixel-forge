# Onboarding: what to read for your task

Always first: `AGENTS.md`, then `docs/STATUS.md`, then your card in `docs/02-plan.md` (not the whole plan or spec). Code is the source of truth; if a doc disagrees with the code, fix the doc.

## Start here

| If you are working on... | Read (spec section / ADR) | Package(s) |
|---|---|---|
| Schema / core | spec 3 (model), 6.3, 6.4; ADR-002, 003, 007 | `schema`, `core` |
| Raster / colour | spec 6.7, NFR-02; ADR-007, 008, 010 | `color`, `raster`, `png` |
| Rig | spec 3, FR-RIG-*, 6.7; ADR-008, 010, 011 | `rig` (pure), `core` (hook) |
| IO | spec 7, NFR-03; ADR-005, 010 | `io`, `png` |
| Ops / MCP / CLI | spec 6.3, 6.5, 8; ADR-003, 004 | `ops`, `lint`, `server`, `cli` |
| Godot addon | spec FR-GD-*, 7; ADR-005, 009 | `godot/addons/pixel_forge` |
| Docs only | `docs/adr/README.md`, `docs/ai/PLAYBOOKS.md` | none |

## Packages (spec 6.2, plus `png` and `testkit`)

| Package | Role | Depends on |
|---|---|---|
| `png` | Pure deterministic PNG codec on fflate | none |
| `testkit` | Golden helper, ASCII helpers, golden sheets, fixture runner | `png` |
| `schema` | Types, zod, ids, constants; no logic | none |
| `color` | OKLab/OKLCH, palettes, quantisation | `schema` |
| `raster` | Sparse tiles, compositing, primitives, RotSprite, fixed-point trig | `schema`, `color` |
| `rig` | Pure functions: FK, snapping, part render, overrides, joint check | `schema`, `raster` |
| `convert` | Image to sprite steps | `schema`, `color`, `raster` |
| `core` | Document store, transactions, history, `validate()`, `renderFrame` | `schema`, `raster`, `rig` |
| `lint` | Structured findings | `core`, `rig` |
| `io` | `.pxf`, codecs, `.aseprite` import | `core`, `convert` |
| `ops` | Op registry and generators | `core`, `lint`, `io`, `rig`, `convert` |
| `server` | DocumentHost, locks, transports | `ops` |
| `cli` | `pf` binary | `server`, `ops` |

## Reading order by task type

**Schema / core**: spec 6.1, 3, 6.4 -> ADR-002, 007 -> `packages/schema/README.md` -> one exemplar test in the package. Contracts are additive; breaking changes need an ADR.

**Raster / colour**: spec NFR-02 -> ADR-010 (determinism: integer maths, no `Math.random`) -> ADR-008 for rotation -> `packages/raster/README.md`. Prefer ASCII expectations and property tests to goldens.

**Rig**: spec 3 (Rig, Animation), FR-RIG-14/16/20/22 -> ADR-008, 011 -> layering rule in `AGENTS.md`. Keep `rig` pure; document-level work goes in `core`.

**IO**: spec 7 -> ADR-005, 010 -> `packages/io/README.md`. Use the `FileSystem` port; encode only with `fflate`. Old fixtures must keep opening.

**Ops / MCP / CLI**: spec 6.3, 6.5, 8 -> ADR-003, 004 -> `docs/contracts/OPERATIONS.md` (generated) -> the playbook "Add an op". Tool descriptions state the coordinate conventions.

**Godot addon**: spec FR-GD-01..03, 7 -> ADR-009, 005 -> `docs/contracts/GODOT_INTEGRATION.md` (T6.0) -> GUT tests under the addon. Godot reads only the render cache.

**Docs only**: `docs/adr/README.md` for the ADR template; keep the public-repo hygiene rules in `AGENTS.md`; update `KNOWN_ISSUES.md` and `PLAYBOOKS.md` when a change makes them stale.

## Also useful
`docs/01-spec.md`, `docs/02-plan.md`, `docs/01-spec-review.md`, `docs/02-plan-review.md`, `docs/ai/KNOWN_ISSUES.md`.
