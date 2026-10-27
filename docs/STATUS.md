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
- 2026-10-26: Plan v0.3 approved. Wave 0 started: T0.1 (sonnet/medium), T0.4 (opus/high), T0.5 (haiku/low) dispatched in parallel.
- Deviation: no git repo yet, so W0 cards share the working tree (they write to separate directories). **No commits until T0.6 has scrubbed game references**, so the public history stays clean.
- ☑ T0.5 (CC0 Hero Swordsman; the orchestrator fixed sheet.json). ☑ T0.1 (ADRs + agent docs). ☑ T0.2 (scaffold; `pnpm verify` passes; repo-local pseudonymous identity; no commits). ☑ T0.6 (game refs moved to `~/pf-work/GAME_NOTES.md`; privacy hook + denylist; LICENSE/README/SECURITY/CONTRIBUTING).
- In flight: T0.4 RotSprite spike (opus/high).
- ☑ O-1: https://github.com/pixel-anvil/pixel-forge (public, CI green, `main` protected). **From now on, work goes on phase branches and PRs to `main`**: wave branch `m1a-wave1`.
- ☑ T0.4 RotSprite spike (verified; recommendations added to T1.6, T3.0 and ADR-008). ☑ T1.8 png codec (merged into `m1a-wave1`).
- Next: T0.3 testkit (sonnet/medium) → Wave 1 (T1.1 schema, opus/xhigh; the orchestrator should be on Opus/high). Then T1.8 → T0.3 → Wave 1 (T1.1 is the next Opus card, so the orchestrator should be on Opus/high).

## Open questions for the user
None right now.
