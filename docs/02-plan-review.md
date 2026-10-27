# Plan review — v0.1 → v0.2

Reviewer: an independent engineering-lead reviewer agent, 2026-10-26. No files were edited during the review.
I checked these claims myself:
- `pnpm` and `corepack` are absent on this machine. `gh` is authenticated.
- The game's shot controller holds frames until release and applies the per-frame rise and the feet-row offset itself (GAME_NOTES §4).
- The target move sits in a specific row of the pack sheet, according to the pack's import mapping (GAME_NOTES §2).

| ID | Sev | Finding (short) | Disposition in v0.2 |
|---|---|---|---|
| P-01 | Blocker | Cards broke the §6.2 package graph (bake, split and mirror need `core`; `rig` must stay pure) | **Accepted.** Layering rule in §0.5. Each card names its package. T3.1 no longer depends on T2.1. T2.1 defines the `RigRenderer` hook. |
| P-02 | Blocker | Parallel subagents in one working tree, WIP commits breaking the phase branch | **Accepted.** Worktree isolation for ∥ cards. Subagents don't commit. The orchestrator verifies and merges. `wip/T*` branches. Recovery step (§0.1). |
| P-03 | Blocker | The free-running driver clock doesn't fit the game's gameplay-driven frames | **Accepted.** New T6.0 integration contract (Opus). Spec FR-GD-03 gains the game-driven playback API. |
| P-04 | Major | Neither pnpm nor corepack is installed | **Accepted.** `npm i -g pnpm@<pinned>`, `packageManager`, `.node-version`, `engines`. |
| P-05 | Major | False parallelism and a cycle in io (PNG encoder, T4.4↔T4.6) | **Accepted.** New `png` package card (T1.8). T4.6 depends only on T0.3. io cards depend on T2.3, not G1. |
| P-06 | Major | Missing M1a ops (bones, pivots, cel links, override resolution, colour mode) | **Accepted.** Added to T5.2b and to the spec §8 M1a list. |
| P-07 | Major | Override attribution buried in the CLI card | **Accepted.** New T3.8 `attributeEdit` (Opus), used by `override import` and `writeGrid`. |
| P-08 | Major | Joint-gap definition missing; the card wrote its own fixtures | **Accepted.** New T3.0 (Opus) with a definition and hand-written fixtures. Dependencies fixed. |
| P-09 | Major | Oracles that confirm themselves or are mathematically wrong | **Accepted.** §0.6 policy. Sentinel and IoU tests for RotSprite. A float64 oracle for snapping. Aseprite CLI, pngjs, sips and Godot crops as external checks. |
| P-10 | Major | T5.2 too large for Haiku | **Accepted.** Split into T5.2a (Haiku) and T5.2b (Sonnet). |
| P-11 | Major | T5.6 wrong dependencies and too large | **Accepted.** Split into T5.6a (Sonnet) and T5.6b (Haiku), with corrected dependencies. |
| P-12 | Major | W-scenarios not automated; fixtures without a producer | **Accepted.** New T3.9 (synthetic hero) and T5.9 (scenario suite). T6.1 gets a fixture generator. |
| P-13 | Major | A subagent can't open a fresh Claude Code session; no `pf` build | **Accepted.** tsup bundle + `pf` on PATH (T5.6a). T5.8 uses `claude -p --mcp-config`. |
| P-14 | Major | Pack art layout wrong. T6.4 wrote into the game repo (GAME_NOTES §1). | **Accepted.** Cell-range import (spec FR-DOC-05, T4.3). `~/pf-work/`. Go/no-go after one frame. Outline decision recorded. |
| P-15 | Major | macOS CI minutes count ×10 on a private repo | **Accepted.** ubuntu per push. macOS on main and nightly. |
| P-16 | Major | Thin context packs; Sonnet can't catch Opus mistakes | **Accepted.** Standard context pack (§0.3). Code review after every Opus card. The user looks at T1.1. |
| P-17 | Minor | Godot harness pitfalls | **Accepted.** Copy the game's test runner (GAME_NOTES §1). Godot 4.6.1 pinned. |
| P-18 | Minor | Haiku would invent palette hex values | **Accepted.** Fetch Lospec `.hex` files and test presets against them. |
| P-19 | Minor | Aseprite Lua fixtures too niche for Haiku | **Accepted.** T4.6 moved to Sonnet. |
| P-20 | Minor | A subagent can't ask about creating the repo | **Accepted.** Orchestrator step O-1. |
| P-21 | Minor | ADRs are transcription work | **Accepted.** T0.1 moved to Sonnet. ADR-008 and ADR-010 stay "Proposed" until the evidence is in. |
| P-22 | Minor | Missing best practices (versioning, bench, frozen fixture, addon install) | **Accepted.** Changesets, v0.1.0 at G2, `pf godot install`, non-gating `pnpm bench`, frozen v1 `.pxf`. |
| P-23 | Minor | `.aseprite` re-import rules unspecified | **Accepted.** Rules written into T4.5. |
| P-24 | Minor | Small gaps (undo-step test, overlay location, import options, Opus count) | **Accepted.** All fixed. |

Also in v0.2, from the user (2026-10-26):
- **T0.5** fetches a CC0 sprite sheet (Hero Swordsman, fallback Super Sprite Boy) as a committed real-art fixture, used in T5.8 dogfooding and CI.
- The target move stays the in-game exit (GAME_NOTES §5).

The reviewer's re-ordering was adopted, including the **early demo D1**: the flat target move plays in the game through the new importer and driver before any rig work is done.
