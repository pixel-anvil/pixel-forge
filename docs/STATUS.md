# Project status (read this first in every new session)

| Step | State | File |
|---|---|---|
| 1. Research + options | ✅ done (Option D chosen) | `docs/00-research-and-options.md` |
| 2. Spec | ✅ v0.2; user answered the open questions (§13) | `docs/01-spec.md` |
| 3. Spec review & critique | ✅ done, all findings accepted | `docs/01-spec-review.md` |
| 4. Plan + task breakdown (model-cost-aware) | ✅ v0.3 approved by user | `docs/02-plan.md` |
| 5. Plan review & critique | ✅ done, 24 findings accepted | `docs/02-plan-review.md` |
| 6. Implementation | 🔄 M1a Wave 0 in progress | tasks tracked in `docs/02-plan.md` |

User wants to review the spec and the plan before proceeding past each.

## Decisions log
- 2026-10-26: Option D (full) chosen. Personal tool, macOS first, Windows later. Text→image later via a pluggable provider. Do NOT inherit the existing in-house pipeline (see §5 of research; GAME_NOTES §3, local).
- 2026-10-26: Spec v0.1 reviewed (21 findings, 4 blockers), all accepted → spec v0.2. M1 split into M1a "rig to game" / M1b "breadth". AI panel proposed → M3 (needs user OK).
- 2026-10-26: User: name pixel-forge, GitHub, AI panel M3 or later, M1a exit move = the target move, 4 phases (GAME_NOTES §5, local).
- 2026-10-26: Also use a CC0 sprite sheet (candidate: Hero Swordsman by tbbk, OpenGameArt node 165036, 64×64, jump/air-attack) as a committed real-art fixture, MCP dogfood character and CI test; the target move stays the in-game M1a exit.
- 2026-10-26: Plan v0.1 reviewed (24 findings, 3 blockers), all accepted → plan v0.2; spec → v0.2.1 (FR-GD-03 game-driven playback, FR-DOC-05 cell ranges, M1a tools, `png` package).
- 2026-10-26: Effort level per card added (plan v0.3). Repo will be PUBLIC under a new GitHub org `pixel-anvil` (the user creates it on the web), MIT, pseudonymous commit identity `pixel-forge dev <dev@pixel-forge.invalid>`, game details kept local in `~/pf-work/GAME_NOTES.md` (new card T0.6 before the first push). CI: ubuntu+macOS on every push (free).

## Current focus / Next
- **Cost mode (2026-10-27):** run the orchestrator on **Opus/medium** in fresh sessions per `docs/ai/ORCHESTRATOR.md`, with the short report contract (including the Deviations / External sources / Design decisions lines); the remaining Opus cards run at high.
- 2026-10-26: Plan v0.3 approved. Wave 0 started: T0.1 (sonnet/medium), T0.4 (opus/high), T0.5 (haiku/low) dispatched in parallel.
- Deviation: no git repo yet, so W0 cards share the working tree (they write to separate directories). **No commits until T0.6 has scrubbed game references**, so the public history stays clean.
- ☑ T0.5 (CC0 Hero Swordsman; the orchestrator fixed sheet.json). ☑ T0.1 (ADRs + agent docs). ☑ T0.2 (scaffold; `pnpm verify` passes; repo-local pseudonymous identity; no commits). ☑ T0.6 (game refs moved to `~/pf-work/GAME_NOTES.md`; privacy hook + denylist; LICENSE/README/SECURITY/CONTRIBUTING).

- ☑ O-1: https://github.com/pixel-anvil/pixel-forge (public, CI green, `main` protected). **From now on, work goes on phase branches and PRs to `main`**: wave branch `m1a-wave1`.
- ☑ T0.4 RotSprite spike (verified; recommendations added to T1.6, T3.0 and ADR-008). ☑ T1.8 png codec (merged into `m1a-wave1`).
- ☑ T0.3 testkit. ☑ T1.1 schema (the user signed off on the domain summary on 2026-10-27).
- ☑ T4.2 .pxf io. ☑ T3.2 rig templates + binding (multiple parts per bone). ☑ T4.4 .aseprite parser. ☑ T4.3 spritesheet I/O. ☑ T3.1 FK + snapping (ADR-012 accepted). ☑ T4.6 .aseprite fixtures. ☑ T2.3 renderFrame (pipeline: core owns steps 5–8; rig hook is parts-only). ☑ T2.2 frame ops + validate. ☑ T1.5 primitives (clean-room ellipse after a licensing catch). ☑ T1.7 post-passes. ☑ T1.2 color. ☑ T1.3 presets (no licence stated on Lospec; see PAL-01). ☑ T1.4 raster. ☑ T3.0 joint-gap contract. ☑ T1.6 RotSprite (reviewed and fixed). ☑ T2.1 document store (reviewed and fixed). ☑ T4.5 .aseprite mapping + re-import (IO-03/IO-04 logged). ☑ T3.9 synthetic hero (golden reviewed). ☑ T3.3 part render + overrides (reviewed and fixed; RIG-03/CORE-03 logged).
- **In flight (2026-10-28):**
  - T6.0 (opus/high), worktree `.claude/worktrees/agent-af4c97b12a368c012`. It hit the usage limit and was resumed. Its private game mapping goes to `<wt>/.claude/reports/T6.0-private.md`; move that into GAME_NOTES, never into the repo.
  - T3.4 jointCheck (sonnet/high), in its own worktree. It also replaces the hero's `it.todo`.
- **Next:** regenerate `hero.pxf` with a render cache (small; fold it into T3.6/T3.7, or do it in the orchestrator); T3.8 (opus/high, after T6.0 frees the Opus slot); T3.6 and T3.7 (sonnet); T4.1 after T3.4; T6.1 after T6.0.

  Max two agents at a time; at most one on Opus.

## Open questions for the user
None right now.
