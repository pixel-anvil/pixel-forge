# pixel-forge — Implementation Plan

| | |
|---|---|
| Version | **0.3** (0.2 after plan review, see `02-plan-review.md`; 0.3 adds an effort column, a public repo under the `pixel-anvil` org, and T0.6 public-readiness) |
| Implements | `01-spec.md` v0.2.1 |
| Planning style | **Rolling wave.** M1a is broken down to task cards. M1b, M2 and M3 are epics, turned into cards at the start of each milestone (at gate G2 or the matching milestone gate). |
| Status | **Awaiting user review** |

---

## 0. How to execute this plan (read first, every session)

### 0.1 Session protocol (built for token limits)
1. **Start**: read `docs/STATUS.md`, then the **Task board** (§2), then the cards you're about to run. Don't read the whole spec.
2. **Pick**: take cards that are ☐ with all dependencies ☑. Cards marked ∥ may run in parallel.
3. **Dispatch**: send each card to a subagent with the card's **model and effort** (`Agent` `model: haiku|sonnet|opus`, `effort: low|medium|high|xhigh`). **Every ∥ card runs with `isolation: "worktree"`.** The brief contains:
   - the card text;
   - the **standard context pack** (§0.3).
4. **Subagents don't commit.** They leave changes in their worktree and report: the files they changed, the commands they ran, and anything they're unsure about.
5. **Verify** as the orchestrator, inside the worktree:
   - run the acceptance commands;
   - open any new golden images as an upscaled sheet (§0.6);
   - read the diff of the public API.
   - Never trust a "done" claim on its own.
6. **Integrate**: commit on the phase branch (`feat(<pkg>): <title> [T1.4]`), merge the worktree, and run the full `pnpm verify` on the phase branch. **The phase branch is always green.**
7. **Record**: tick the card, add *Notes* if anything deviated, and update `STATUS.md` → "Current focus / Next".
8. **Broken result**: if verification fails, discard the worktree (or `git restore`), add a note to the card, and re-dispatch, one model up after the second failure (§0.2).
9. **Running low on context**: stop dispatching. For each card still in progress:
   - commit it to `wip/T<id>` (never to the phase branch);
   - write a handoff in the card's *Notes*: what's done, what's left, the branch;
   - update STATUS.

   A fresh session continues from there.

**Orchestrator-only steps** (`O-*` on the board) involve the user, the network or other repositories. A subagent can't ask the user anything, so these never go to subagents.

### 0.2 Model policy (cost-aware)
| Model | Use for | Don't use for |
|---|---|---|
| **Opus** (`claude-opus-5-5`) | Contracts other cards build on (schema, ops framework, document store), subtle algorithms (snapping maths, RotSprite, override staleness and attribution), spikes, integration contracts, **reviews of Opus cards and gates**, MCP ergonomics evaluation, rolling-wave breakdown | Transcription, boilerplate, routine features |
| **Sonnet** (`claude-sonnet-5-5`) | Feature work with a clear spec: codecs, parsers, lint, ops with logic, MCP/CLI wiring, the Godot plugin, UI, ADR transcription | Pure pattern-copying |
| **Haiku** (`claude-haiku-5-5`) | Mechanical work with an **exemplar and an oracle**: data from fetched sources, table-driven ops with no logic, generated subcommands, docs and snippets | Anything where it would have to decide when it's out of its depth |

**Effort.** Each card also has an **effort** level. All current models accept `low`, `medium`, `high`, `xhigh` and `max`. The defaults differ: medium on Opus 5.5 and Haiku 5.5, high on Sonnet 5.5. So the orchestrator **always passes `effort: <level>` explicitly** in the `Agent` call. This plan is the user's standing instruction to name levels.

| Effort | Use for |
|---|---|
| `low` | Fetching or transcribing with an oracle, docs, CI wiring |
| `medium` | Routine features with a clear spec and an exemplar (the default for Sonnet and Haiku cards) |
| `high` | Parsers, codecs, concurrency, contracts, spikes, evaluations, gates |
| `xhigh` | Foundational contracts and the hardest algorithms (T1.1, T1.6, T2.1, T3.1, T3.3, T3.8, T5.1) |
| `max` | Never planned. Only as a last escalation step, with a note. |

Prices per million tokens (input/output): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50. Opus is only about 2× Sonnet per token, but it uses more tokens at high effort. Haiku is about 20× cheaper than Sonnet, so it's the best value for genuinely mechanical cards.

- **Escalation ladder**:
  1. On the first failed verification, if the failure looks like a **reasoning slip** (a wrong edge case, a missed rule), retry once on the same model with effort one level higher.
  2. If the failure looks like a **capability gap** (it misunderstood the task or the architecture), or the retry also fails, move one model up at the card's original effort.
  3. Note every escalation on the card. If a class of cards keeps escalating, change the model or effort columns for similar future cards.
- **Calibration at gates**: at G1 and G2, compare what cards actually cost (the tokens in subagent results) against how often they escalated. Lower the effort where cards passed easily and raise it where they struggled.
- **Orchestrator**: run the main session on **Sonnet at medium effort** for routine waves. Use **Opus at high effort** for waves that include Opus cards (to review their output) and for gates. Switch with `/model` and `/effort` at the start of the session.
- **Review after Opus cards**: after T1.1, T1.6, T2.1, T3.1, T3.3, T3.8 and T5.1, run the `code-review` skill (high effort) on the card's diff before dependent cards start. T1.1 also gets a short look from the user.

### 0.3 Standard context pack (every card)
`AGENTS.md`, plus:
- the README of the target package (create it if missing);
- the **spec sections and requirement IDs** listed on the card (read only those);
- the named source files;
- **one exemplar test** from the same package (or the closest one).

Haiku cards also name the exact exemplar file to copy.

### 0.4 Definition of done (every card)
- `pnpm verify` passes. That runs `lint`, `typecheck`, `test`, `depcruise`, and `gen --check` (generated docs and schemas are current).
- Tests are written alongside or before the logic. Coverage of the touched core package stays ≥ 85 %.
- No `any`, no `Math.random`, no `Date.now()` in pure packages.
- Public API has TSDoc. Docs the change made stale are updated (README, contracts, KNOWN_ISSUES, PLAYBOOKS).
- A user-visible change adds a **changeset** (`pnpm changeset`).

### 0.5 Conventions decided up front
- **Tooling**: Node **26** (`.node-version`, `engines`). pnpm pinned via the `packageManager` field and installed with `npm i -g pnpm@<pinned>`, because corepack and pnpm are not on this machine. TypeScript project references, ESM only, Vitest, `tsup` for the `pf` bundle, changesets for versioning.
- **Dependencies** (check the latest stable version at scaffold time): `zod` v4, `fflate`, `@modelcontextprotocol/sdk`, `commander`, `execa` (tests), `pngjs` (test oracle only), `dependency-cruiser`, `license-checker-rseidelsohn`.
- **Packages** (spec §6.2 plus one addition): `png` is a pure PNG codec on fflate with no other dependencies. It sits at the bottom of the graph and is used by `testkit` and `io`.
- **Layering rule**: `rig` holds **pure functions over schema types**: `evaluatePose`, `renderParts`, `jointCheck`, `overlapMask`, `attributeEdit`, and pose clipboard maths. **`core` holds the document-level operations**: split as a transaction, bake through `renderFrame`, the mirror inside `renderFrame`, and the rig render hook. Each card names its package.
- **Coordinates**: origin top-left, y down, angles in degrees clockwise, integer pixels, pivot at the **pixel centre**.
- **Fixtures**: in `fixtures/`, synthetic art (generated by committed scripts in `fixtures/src/`) **plus CC0 art in `fixtures/cc0/`** with its licence file. **Never licensed pack art (GAME_NOTES §2).**
- **Other repositories**: the user's work files go in `~/pf-work/`. The first consumer game is changed only in O-steps (D1, T6.5), on a branch, with user approval.
- **CI**: the repo is **public** (`pixel-anvil/pixel-forge`), so GitHub-hosted runners are free. **ubuntu-latest and macos-latest run on every push and PR**: lint, tests, the determinism hash suite, and Godot 4.6.1 headless on ubuntu. Windows is added in M3. Benchmarks (`pnpm bench`) run and report but don't fail the build.
- **Public-repo hygiene**:
  - Licence: **MIT** ("pixel-forge contributors").
  - Commits use a repo-local identity, `pixel-forge dev <dev@pixel-forge.invalid>`, which is not linked to any account. Never commit with the global git identity.
  - **Never commit game-specific identifiers or absolute home paths.** Details of the first consumer game (its repo path, art pack layout, scripts, integration specifics) live in the untracked **`~/pf-work/GAME_NOTES.md`**. Public docs say "the first consumer game".
  - `scripts/privacy-check.sh` runs as a pre-commit hook. It rejects absolute home-directory paths and every term listed in the untracked `~/pf-work/denylist.txt`. It's skipped when that file is absent (CI).

### 0.6 Verification oracles & golden policy
- Prefer **independent oracles** to goldens:
  - **ASCII expectations written by hand** for small cases;
  - **property tests**;
  - **external tools**: the Aseprite CLI (`~/code/aseprite/build/bin/aseprite -b`), `pngjs`, macOS `sips`, and Godot itself.
- A golden image produced by the code under test is accepted only after the orchestrator has looked at the upscaled sheet (`pnpm golden:sheet <name>`, ×8 with a grid). The card's Notes say "golden reviewed".
- Goldens are updated only with `UPDATE_GOLDEN=1` plus a note on the card.

---

## 1. Waves of M1a ("rig to game")

```
W0  T0.1 ∥ T0.4 ∥ T0.5 → T0.2 → T0.6 → O-1 (GitHub repo) → T1.8 → T0.3
W1  T1.1 → review → T1.2 ∥ T1.4 → T1.3 ∥ T1.5 ∥ T1.6 ∥ T1.7
W2  T2.1 ∥ T3.0 ∥ T3.1 → T2.2 ∥ T2.3 ∥ T3.2
W3  Godot track: T4.3 → T4.2 → T6.0 → T6.1 → T6.2 → T6.3 → D1 EARLY DEMO (flat target move in the game)
    Rig track (parallel): T3.3 → T3.8 → T3.4 → T3.5 ∥ T3.6 ∥ T3.7 → T3.9 → G1
W4  T4.6 → T4.4 → T4.5 ∥ T4.1 → T5.1 → T5.2a ∥ T5.2b ∥ T5.3 ∥ T5.4 → T5.5 → T5.6a → T5.6b ∥ T5.7 → T5.9 → T5.8
W5  T6.4 (go/no-go after one frame) → T6.5 → G2 (v0.1.0)
```
**The user sees something early:**
- T0.4: RotSprite contact sheets on your art;
- D1: the target move playing in the game through the new importer and driver, flat frames with no rig yet;
- T5.8: Claude Code animating through MCP;
- T6.5: the rigged target move in the game.

---

## 2. Task board — M1a

| Card | Title | Model | Effort | Size | Deps | ∥ | ☐/☑ |
|---|---|---|---|---|---|---|---|
| T0.1 | ADRs + agent docs | sonnet | medium | M | — | ∥ | ☑ |
| T0.4 | **RotSprite spike** on real pack art, vs Aseprite's own RotSprite | opus | high | M | — | ∥ |☑ |
| T0.5 | Fetch and check a CC0 character sheet → `fixtures/cc0/` | haiku | low | S | — | ∥ | ☑ |
| T0.2 | Monorepo scaffold, tooling, CI | sonnet | medium | M | T0.1 | | ☑ |
| T0.6 | Public-readiness: scrub game refs → GAME_NOTES.md, LICENSE, README, SECURITY, privacy hook | sonnet | medium | S | T0.1, T0.2 | | ☑ |
| O-1 | User creates the `pixel-anvil` org → public repo, branch protection, push, CI green | orchestrator | — | S | T0.6 | |☑ |
| T1.8 | `png` package: deterministic PNG encode/decode | sonnet | high | S | T0.2 | | ☐ |
| T0.3 | testkit: golden helper, ASCII helpers, golden sheets, fixture runner | sonnet | medium | S | T1.8 | | ☐ |
| T1.1 | schema: domain types + zod + ids (**+ review + user look**) | opus | xhigh | M | T0.2 | | ☐ |
| T1.2 | color: OKLab/OKLCH, nearest colour, palette ops | sonnet | medium | S | T1.1 | ∥ | ☐ |
| T1.3 | color: palette presets from fetched Lospec `.hex` sources | haiku | low | S | T1.2 | ∥ | ☐ |
| T1.4 | raster: sparse tiled image, compositing, basic transforms | sonnet | high | M | T1.1, T0.3 | ∥ | ☐ |
| T1.5 | raster: primitives (line, rect, ellipse, fill, pixel-perfect) | sonnet | medium | S | T1.4 | ∥ | ☐ |
| T1.6 | raster: fixed-point trig + RotSprite (+ review) | opus | xhigh | M | T1.4, T0.4 | ∥ | ☐ |
| T1.7 | raster: orphan removal + outline pass | sonnet | medium | S | T1.4 | ∥ | ☐ |
| T2.1 | core: document store, transactions, patches, history, rig hook interface (+ review) | opus | xhigh | M | T1.1, T1.4 | ∥ | ☐ |
| T3.0 | rig: joint-gap definition + hand-written ASCII gap fixtures | opus | high | S | T1.1 | ∥ | ☐ |
| T3.1 | rig: FK, interpolation + quantisation, hierarchical snapping (+ review) | opus | xhigh | M | T1.1, T1.6 | ∥ | ☐ |
| T2.2 | core: frame ops (§3.2) + `validate()` | sonnet | medium | M | T2.1 | ∥ | ☐ |
| T2.3 | core: `renderFrame` (pixel layers) + cache key | sonnet | medium | S | T2.1 | ∥ | ☐ |
| T3.2 | rig: templates, bind by name/overlap, pivots, views | sonnet | medium | M | T3.1 | ∥ | ☐ |
| T4.3 | io: spritesheet import (cell ranges, outline sheet), sheet + JSON export, contact sheet | sonnet | medium | M | T2.3, T1.8 | ∥ | ☐ |
| T4.2 | io: `.pxf` read/write, migrations, render cache, atomic save, pack/unpack | sonnet | high | M | T4.3, T2.2 | | ☐ |
| T6.0 | Godot integration contract with the first consumer game (spec addendum) | opus | high | S | T4.2 | | ☐ |
| T6.1 | Godot: `.pxf` reader + import plugin + test harness + fixture `.pxf` generator | sonnet | high | M | T6.0 | | ☐ |
| T6.2 | Godot: PixelForgeDriver (clock + game-driven playback), adapters, mirroring, markers/events | sonnet | high | M | T6.1 | | ☐ |
| T6.3 | Godot: demo scene + CI job (ubuntu, 4.6.1 headless) | haiku | low | S | T6.2 | | ☐ |
| D1 | **Early demo**: flat target-move `.pxf` → plays in the first consumer game through the driver (user approval) | orchestrator + sonnet | medium | M | T6.3 | | ☐ |
| T3.3 | rig: part render pipeline + overrides + staleness; core hook (+ review) | opus | xhigh | M | T3.2, T2.3, T1.7 | ∥ | ☐ |
| T3.8 | rig: `attributeEdit(render, edited) → overrides` (+ review) | opus | xhigh | M | T3.3 | | ☐ |
| T3.4 | rig: `jointCheck` (implements the T3.0 definition) | sonnet | high | M | T3.0, T3.3 | | ☐ |
| T3.5 | rig `overlapMask` + core `splitRegion` transaction | sonnet | high | M | T3.4 | ∥ | ☐ |
| T3.6 | core: derived mirror in `renderFrame`; rig: pose clipboard (mirrored) | sonnet | medium | S | T3.3 | ∥ | ☐ |
| T3.7 | core: bake | sonnet | medium | S | T3.3 | ∥ | ☐ |
| T3.9 | fixtures: synthetic humanoid "hero" (TS doc + `.aseprite` via Lua) | sonnet | medium | M | T3.2, T0.3 | ∥ | ☐ |
| G1 | **Gate: core + rig** | opus | high | — | W1–W3 rig track | | ☐ |
| T4.6 | fixtures: synthetic `.aseprite` files via Aseprite Lua | sonnet | medium | S | T0.3 | ∥ | ☐ |
| T4.4 | io: `.aseprite` binary parser (Aseprite CLI as oracle) | sonnet | high | M | T4.6 | | ☐ |
| T4.5 | io: `.aseprite` → document mapping + in-place re-import (explicit rules) | sonnet | high | M | T4.4, T4.2 | ∥ | ☐ |
| T4.1 | lint: rules + structured findings | sonnet | medium | M | T3.4, T3.3 | ∥ | ☐ |
| T5.1 | ops: registry framework + generators + 3 exemplar ops (+ review) | opus | xhigh | M | T4.1, T4.2 | | ☐ |
| T5.2a | ops (no logic, from table) | haiku | medium | S | T5.1 | ∥ | ☐ |
| T5.2b | ops with logic + P-06 ops | sonnet | medium | M | T5.1 | ∥ | ☐ |
| T5.3 | ops: text grid read/write + render/contact sheet with overlays | sonnet | high | M | T5.1, T3.8, T4.3 | ∥ | ☐ |
| T5.4 | server: DocumentHost, lockfiles, discovery, workspace roots | sonnet | high | M | T5.1 | ∥ | ☐ |
| T5.5 | MCP stdio server | sonnet | high | M | T5.2a, T5.2b, T5.3, T5.4 | | ☐ |
| T5.6a | CLI shell + `check` harness + `tsup` bundle + `pf` on PATH | sonnet | medium | M | T5.5 | | ☐ |
| T5.6b | CLI subcommands from registry metadata (+ override import/list/resolve, `pf godot install`) | haiku | medium | S | T5.6a | ∥ | ☐ |
| T5.7 | Claude Code setup guide + `.mcp.json` | haiku | low | S | T5.6a | ∥ | ☐ |
| T5.9 | W-scenario suite (`pf check` scripts for W2, W2b, W3-manual, W4-CLI) in CI | sonnet | medium | M | T5.6b, T3.9 | | ☐ |
| T5.8 | **MCP dogfood evaluation** (CC0 character + synthetic hero) | opus | high | M | T5.9, T0.5 | | ☐ |
| T6.4 | Target-move rebuild from pack art (with the user) | opus orchestrating | high | session | T5.8, D1 | | ☐ |
| T6.5 | Swap the rigged target move into the first consumer game (user approval) | sonnet | medium | S | T6.4 | | ☐ |
| G2 | **Gate: M1a exit** + v0.1.0 + M1b breakdown | opus | high | — | all | | ☐ |

**Mix**: Opus 12 cards (T0.4, T1.1, T1.6, T2.1, T3.0, T3.1, T3.3, T3.8, T6.0, T5.1, T5.8, T6.4) + 2 gates; Sonnet 32; Haiku 6; orchestrator steps 2 (O-1, D1). Opus is about 25 % of the cards and roughly 35 % of the tokens. Sonnet carries most of the volume.

---

## 3. Task cards — M1a

> Every card: standard context pack (§0.3), DoD (§0.4), oracles (§0.6). Only extras are listed below.

### Wave 0 — Foundations

#### T0.1 ADRs + agent docs  [sonnet] [M] ∥
- **Spec** — §6, §12, `01-spec-review.md`, `02-plan-review.md`.
- **Deliverables**:
  - `docs/adr/ADR-001…011.md` (≤ 1 page each). **ADR-008 and ADR-010 have status "Proposed"** until T0.4 and T1.6 finish.
  - `AGENTS.md` (≤ 80 lines: rules, DoD, conventions, layering rule, links) and `CLAUDE.md` (a pointer to it).
  - `docs/ai/ONBOARDING.md` (reading order per task type).
  - `docs/ai/PLAYBOOKS.md` (headings only; filled in by the cards that create the patterns).
  - `docs/ai/KNOWN_ISSUES.md`.
- **Acceptance** — every ADR in spec §12 exists. AGENTS.md is ≤ 80 lines and covers §0.4–0.6.
- **Notes (2026-10-26)** — ☑ Verified: 11 ADRs (ADR-008 and ADR-010 Proposed), AGENTS.md is 46 lines, the privacy grep is clean, and ADR-004 and ADR-009 were spot-checked against the spec. ONBOARDING links to `packages/<pkg>/README.md` and `docs/contracts/OPERATIONS.md`, which T0.2 and T5.1 create.

#### T0.4 RotSprite spike  [opus] [M] ∥
- **Context** — research doc ("rigging problem").
- **Art** — a licensed pack sheet, one row of 64 px cells (exact sheet, row, cells and mapping: GAME_NOTES §2, local). **Read only. Never copy it into the pixel-forge repo.** Outputs go to `spikes/rotsprite/out/` (gitignored).
- **Do**:
  - crop 3 limbs by hand;
  - implement RotSprite (Scale2x×3 → nearest rotate at ×8 → sample, with the pivot tracked);
  - compare against nearest, shear, and **Aseprite's built-in RotSprite** (Lua, `app.command.Rotate`), at 5°, 15°, 30°, 45° and 60°;
  - time a 32×32 rotation;
  - test 1 and 2 px joint caps at ±30°;
  - try the pixel-centre pivot convention.
- **Deliverables** — `spikes/rotsprite/REPORT.md`, recommending the algorithm and parameters, `maxResidualDeg`, the joint-cap size, and where variants will be needed.
- **Acceptance** — the report has images and timings. The user has seen the sheets (orchestrator shows them).
- **Notes (2026-10-26)** — ☑ The orchestrator viewed the sheets and re-ran the pivot stress test (134,280 runs, 0 failures) and the benchmark (cold 0.093 ms, 16 warm parts 0.044 ms on an M5; NFR-01 targets are 10 ms and 2 ms). Findings:
  - no new colours and an exact pivot for RotSprite, nearest and shear;
  - RotSprite clearly beats nearest on parts ≥ ~16 px, and is about equal on 2 px limbs;
  - Aseprite's built-in RotSprite doesn't track pivots (ruled out as an oracle for pivots);
  - recommended: a 1 px hidden overlap as the joint cap; `maxResidualDeg` 22.5 (15 for detailed parts); variants for hands, for feet beyond ±30°, and for heads.

  Public report: `spikes/rotsprite/REPORT.md`. Reference implementation: `spikes/rotsprite/reference/rot.mjs`. Private full report: `~/pf-work/spikes/rotsprite/REPORT_FULL.md`. Cost: about 224k subagent tokens and 20 minutes, the most expensive W0 card.

#### T0.5 CC0 character sheet  [haiku] [S] ∥
- **Do**:
  - download **Hero Swordsman** by tbbk (https://opengameart.org/node/165036, CC0) into a fresh, empty `~/pf-work/downloads/hero_swordsman/`;
  - confirm the licence on the page;
  - list the archive contents;
  - copy only the PNG sheets to `fixtures/cc0/hero_swordsman/` with `LICENSE.md` (title, author, URL, CC0, date fetched) and `sheet.json` (cell size and the row and column range for each animation, measured from the image).
  - If it has no side-view jump, try **Super Sprite Boy** (https://opengameart.org/content/running-and-jumping-kid-sprite-sheets, CC0) instead. Report both and let the orchestrator choose.
- **Acceptance** — the orchestrator opens the sheets and checks `sheet.json` against them. The licence is confirmed CC0 on the source page.
- **Notes (2026-10-26)** — ☑ Hero Swordsman (tbbk), CC0. Copied 5 sheets: idle, run, jump_and_fall, attack, slide (hurt/die and jump-attack left out). The orchestrator rewrote `sheet.json` to use `[row, col]` frame lists after a visual check; Haiku's row-based schema couldn't represent multi-row strips. The character is about 30 px tall in 64 px cells, roughly a three-quarter side view.

#### T0.2 Monorepo scaffold + CI  [sonnet] [M]
- **Deliverables**:
  - `npm i -g pnpm@<pinned>`, the `packageManager` field, `.node-version` (26), `engines`;
  - `git init` (no remote);
  - the pnpm workspace with every package from spec §6.2 plus `png` and `testkit`, each with `src/index.ts`, a README stub and a smoke test;
  - `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`);
  - ESLint flat config (typescript-eslint strict, `no-explicit-any` as an error, `Math.random` and `Date.now` banned in pure packages);
  - Prettier, Vitest + coverage thresholds;
  - `.dependency-cruiser.cjs` encoding §6.2 + `png`;
  - the license checker;
  - changesets;
  - root scripts `verify`, `lint`, `typecheck`, `test`, `depcruise`, `gen`, `bench`, `fixtures`;
  - `.github/workflows/ci.yml`: a matrix of ubuntu-latest and macos-latest on every push and PR (`pnpm/action-setup`, Node from `.node-version`).
- **Acceptance** — `pnpm verify` passes locally. A deliberate forbidden import (`schema` → `core`) fails depcruise. Show it, then revert. **Don't create the remote** (that's O-1).
- **Notes (2026-10-26)** — ☑ Verified by the orchestrator: `pnpm verify` passes, and the depcruise and `Math.random` lint demos fail then pass as expected. Repo-local identity set, no commits. Versions: pnpm 12.15.0, TypeScript **6.0.3** (pinned below 7 because typescript-eslint 8.72 supports up to <6.1; upgrade when it supports 7), Vitest 5, ESLint 10, NodeNext resolution (relative imports need `.js`). `src/` + `test/` per package. The license check covers dev dependencies too and excludes `lightningcss` (MPL-2.0, dev only) and the spdx data packages. `scripts/license-check.mjs` calls the binary path directly, which needs a Windows fix in M3. `changeset init` hung, so the config was written by hand.

#### T0.6 Public-readiness  [sonnet] [S]
- **Do**:
  - move every game-specific detail out of `docs/` (and AGENTS/ADRs) into `~/pf-work/GAME_NOTES.md`: repo paths, the art pack's name and layout, script and class names, field names. Leave neutral wording in their place ("the first consumer game", "a licensed sprite pack", "the game's custom lit billboard") plus a pointer, "details: GAME_NOTES.md (local)";
  - plan cards that need those details (T0.4, T6.0, D1, T6.4, T6.5) reference GAME_NOTES sections;
  - write `~/pf-work/denylist.txt` and install `scripts/privacy-check.sh` as a pre-commit hook;
  - add `LICENSE` (MIT), `README.md` (what it is, status, quick start placeholder), `SECURITY.md` (localhost-only design; report via GitHub private advisories) and `CONTRIBUTING.md` (points to AGENTS.md);
  - set the repo-local git identity.
- **Acceptance**:
  - `scripts/privacy-check.sh --all` passes on the whole tree;
  - `git log --format='%an %ae'` shows only the pseudonym;
  - the orchestrator reads `GAME_NOTES.md` and checks that nothing the plan needs was lost.
- **Notes (2026-10-26)** — ☑ Verified: `privacy-check --all` passes, `pnpm verify` passes (it now includes privacy-check), and GAME_NOTES §1–§6 were checked against the removed passages. The orchestrator added the exact per-phase cells and fps, the `import.json` globals and the Aseprite path to GAME_NOTES §2 and §6. Public docs now use the neutral names `target move`, `scripts/demo/flat-move.ts` and `~/pf-work/target_move/`.

#### O-1 GitHub repo  [orchestrator]
- **The user** creates the org `pixel-anvil` on the web (github.com/account/organizations/new, Free plan) and sets their membership to private.
- The orchestrator then:
  - runs `gh repo create pixel-anvil/pixel-forge --public --source . --push --description "Pixel-art editor and animator with pixel-aware rigs, MCP and Godot import"`;
  - enables branch protection on `main` (requires CI to pass; no force-push), Dependabot alerts, and private vulnerability reporting.
- Wait for CI to go green, and fix any CI-only failures here.
- **Notes (2026-10-26)** — ☑ The org is **`pixel-anvil`** (the user's choice). Repo https://github.com/pixel-anvil/pixel-forge is public, and the user's org membership is private. First CI run is green on ubuntu and macOS. `main` is protected: required checks `verify (ubuntu-latest)` and `verify (macos-latest)` (strict), linear history, no force-push or deletion. Admins can bypass it, so the orchestrator follows the PR flow by convention. Dependabot alerts and private vulnerability reporting are on.

#### T1.8 `png` codec  [sonnet] [S]
- **Deliverables** — `packages/png`:
  - `encodePng({width, height, data, kind: 'rgba'|'gray8'})`, deterministic: fflate at a fixed level, a fixed filter strategy, no ancillary chunks;
  - `decodePng`, which supports colour types 0/2/3/4/6 at 8-bit, plus palette PNGs.
- **Oracle** — decode our output with `pngjs` and `sips`. Decode PNGs written by `pngjs`.
- **Acceptance** — byte-stable: the same input gives the same bytes on repeated runs. Decoding matches pngjs on a corpus of 10 PNGs, which includes Aseprite exports.

#### T0.3 testkit  [sonnet] [S]
- **Deliverables** — `packages/testkit` (private):
  - `expectGolden(name, rgba)`: compares the RGBA hash and writes actual and diff PNGs to `.golden-diff/`;
  - `expectAscii(img, ascii, legend)` / `asciiToImage`;
  - `pnpm golden:sheet` (×8 upscale with a grid, for review);
  - the `pnpm fixtures` runner.
- **Acceptance** — self-tests pass. A golden mismatch writes the diff files.

### Wave 1 — schema / color / raster

#### T1.1 schema  [opus] [M]
- **Spec** — §3 (all of it), I1–I7, FR-GD-02 (render-cache types), §7.
- **Deliverables** — `packages/schema/src/`:
  - `ids.ts` (branded IDs and a seeded ID generator);
  - zod schemas with inferred types for the document, palette, skin, layer, rig (bones, parts, variants, views), animation (group, direction, `mirrorOf`), frame, cel, keys, override and render cache;
  - `constants.ts`;
  - `refs.ts`.
- **Acceptance** — `fixtures/src/minimal-doc.ts` round-trips through the schema. Invalid names are rejected. JSON Schema export works. **Review: the code-review skill (high), then show the user the domain types summary** before the wave fans out.

#### T1.2 color basics  [sonnet] [S] ∥
- **Deliverables** — sRGB ↔ linear ↔ OKLab/OKLCH conversion; `nearestIndex` (OKLab, cached, ties go to the lower index); palette operations.
- **Oracle** — the reference values published with Björn Ottosson's OKLab, to 1e-4.

#### T1.3 palette presets  [haiku] [S] ∥
- **Do**:
  - fetch the Lospec `.hex` files for PICO-8, NES, Game Boy (DMG), Endesga 32, Resurrect 64, AAP-64 and Sweetie 16;
  - commit them to `packages/color/src/presets/sources/`;
  - write each preset module to **load from the committed `.hex`** (exemplar: write PICO-8 first, following the format in `presets/README.md`);
  - record each preset's source URL and licence.
- **Acceptance** — a test compares each preset with its `.hex` file byte for byte. The colour counts are as published.

#### T1.4 raster core  [sonnet] [M] ∥
- **Deliverables**:
  - `TiledImage` (RGBA8) and `IndexedImage`, with sparse 16×16 copy-on-write tiles: `get`, `set`, `bounds`, `clone`, `tilesChanged`, `byteSize`;
  - `composite` (normal blend, opacity, integer maths);
  - flips, rotations by 90°, `scaleInt`, `crop`;
  - `hashRGBA`.
- **Oracle** — property tests (involutions). ASCII expectations for compositing.
- **Acceptance** — a 256² image with 10 % fill uses ≤ 30 tiles.

#### T1.5 primitives  [sonnet] [S] ∥
- **Deliverables** — Bresenham line, rectangle, midpoint ellipse, flood fill (4- or 8-connected, contiguous or global), and the pixel-perfect stroke filter.
- **Oracle** — hand-written ASCII expectations, plus compare against Aseprite's line and ellipse via Lua on 5 cases.

#### T1.6 fixed-point trig + RotSprite  [opus] [M] ∥
- **Spec** — FR-RIG-20/21, NFR-02, `spikes/rotsprite/REPORT.md`.
- **Deliverables**:
  - `trig.ts`: a Q16 sin/cos table at 0.25°, `rotatePoint`, and rounding that is documented as half away from zero;
  - `rotateAbout(img, pivot, deg, algo) → {img, pivotOut}` with the `rotsprite`, `nearest` and `none` algorithms;
  - a bench script.
- **Oracles**:
  - **sentinel**: a unique colour on the pivot pixel lands exactly on `pivotOut` at every 1° from 0° to 359°;
  - the set of output colours is a subset of the input colours;
  - 0° and 90° results equal `rot90`;
  - the IoU of the masks at θ and the mirror of −θ is ≥ 0.95;
  - the alpha area stays within ±10 %;
  - a metric comparison with Aseprite's RotSprite (from the spike).
- **Acceptance** — a cold 32×32 rotation takes < 10 ms (record it on the card). Then the review.
- **Input from T0.4** — port `spikes/rotsprite/reference/rot.mjs`: Scale2x×3 with a cached ×8 image, then the fused integer pass `sx8 = 8px+4 + sfloor(C·dx+S·dy, 8192)` with C and S = cos/sin×65536, symmetric ties away from the pivot (plain `floor` breaks mirror symmetry at 30° and 60°), the pivot colour forced, and `(ox, oy)` returned. Don't use the majority-colour downsample. Keep the spike's sentinel, mirror-IoU and colour-subset tests as oracles.

#### T1.7 orphan removal + outline  [sonnet] [S] ∥
- **Deliverables** — `removeOrphans`, and `outline(img, colour, {outsideOnly, corners})` producing a four-connected, one-pixel outline.
- **Oracle** — hand-written ASCII cases: convex and concave corners, single pixels, holes.

### Wave 2 — core + rig foundations

#### T2.1 document store + history  [opus] [M] ∥
- **Spec** — §6.4, FR-DOC-02.
- **Deliverables**:
  - `DocumentStore`, with transactions (begin, commit, cancel), patches (structural and tile), undo/redo, `version`, memory accounting with a cap, and events;
  - the **`RigRenderer` hook interface**, which `renderFrame` will call and `rig` will implement.
- **Oracle** — property test: random operations, then undo all, give the initial hash; redo all gives the final hash.
- **Acceptance** — a PLAYBOOKS entry, "how mutations work". Then the review.

#### T3.0 joint-gap definition  [opus] [S] ∥
- **Deliverables** — `docs/contracts/JOINT_CHECK.md`, which defines:
  - the sweep: the child rotates over ±range in steps while the parent stays at rest;
  - a **gap pixel**: transparent in the composite at angle θ, inside the 8-connected closure of (parent ∪ child) at θ, and within *r* px of the joint pivot;
  - the report format.

  Also hand-written ASCII fixtures `fixtures/joint/gappy_*.txt` and `clean_*.txt` with the **expected gap coordinates written by hand**.
- **Acceptance** — the definition is unambiguous. The expected results are in the fixtures, and they're not generated by code.
- **Input from T0.4** — a naive "transparent pixel near the joint" rule reports normal inner corners and the art's own staircase steps as gaps. The definition must count only pixels on the **outer side of the bend** that are **opaque at rest** (or inside the rest composite) and transparent at θ. Default joint cap: a 1 px hidden overlap (`max(1, ceil(w/4))` for limbs ≥ 6 px wide). Disc caps change the rest pose on thin limbs, so don't recommend them.

#### T3.1 FK + interpolation + hierarchical snapping  [opus] [M] ∥
- **Package** — `rig` (pure).
- **Spec** — FR-RIG-10/11/12, FR-RIG-20 steps 1–2.
- **Deliverables** — `evaluatePose(rig, view, keys, frameId) → SnappedSkeleton`.
- **Oracles**:
  - **an independent float64 reference**, where the child pivot is `parentSnapped + roundHalfAway(rotate(rest, θq))`. It must match the fixed-point result exactly, except at documented .5 ties;
  - a translation-only change shifts every pivot by the same integer delta;
  - the per-frame child pivot delta is ≤ `ceil(L·Δθ) + 1`;
  - interpolation tables written by hand;
  - results identical across runs.
- **Acceptance** — then the review.

#### T2.2 frame ops + validate  [sonnet] [M] ∥
- **Spec** — §3.2, I1–I7.
- **Deliverables** — `insertFrame`, `duplicateFrame`, `deleteFrame` (which materialises links into the deleted frame), `reorderFrames`, `validate`.
- **Oracle** — one test per §3.2 rule. Property test: after random frame operations, `validate()` reports no errors.

#### T2.3 renderFrame (pixel layers)  [sonnet] [S] ∥
- **Deliverables** — `renderFrame` for pixel and group layers (links, opacity, visibility, the `export` filter), calling the `RigRenderer` hook when it's present, plus the input-hash memo.
- **Oracle** — ASCII expectations. The cache key changes only when its inputs change.

#### T3.2 templates, binding, pivots, views  [sonnet] [M] ∥
- **Package** — `rig` (pure) and `core` (the transaction wrappers).
- **Spec** — FR-RIG-01–04/06.
- **Deliverables**:
  - humanoid side and front/back templates;
  - `bindByName` (`part:<bone>[@variant][#view]`);
  - `bindByOverlap`, which returns candidates on ambiguity and never guesses;
  - `setPivot`, bone CRUD, bone length, and rest pose per view;
  - view CRUD.
- **Acceptance** — a fixture binds completely. The ambiguous case returns candidates.

### Wave 3a — Godot track (early demo)

#### T4.3 spritesheet / contact sheet  [sonnet] [M] ∥
- **Spec** — FR-DOC-05/06, FR-AI-12.
- **Deliverables**:
  - grid import with cell selection (cell size, row, column ranges → animations) and an outline sheet as an extra layer;
  - spritesheet + JSON export (Aseprite hash format);
  - `contactSheet(frames, {scale, labels})`, keeping the long edge ≤ 1568 px.
- **Oracle** — compare the JSON with Aseprite's own `--sheet --data` output for the same frames. Labels checked by golden, after review.

#### T4.2 `.pxf` io  [sonnet] [M]
- **Spec** — §7, NFR-03, FR-DOC-01.
- **Deliverables**:
  - `readPxf` / `writePxf` (fflate, fixed entry order, sorted keys, fixed timestamps, PNG via the `png` package);
  - the migration registry, plus a **frozen v1 fixture** committed for future migration tests;
  - render-cache updates per frame by hash;
  - an atomic save through the `FileSystem` port;
  - `pack` / `unpack` (`.pxfd` with `.gdignore`).
- **Acceptance**:
  - read → write is byte-identical;
  - a no-op save leaves `modified` unchanged;
  - the render cache equals `renderFrame`;
  - a fake FS failure midway through a write leaves the original intact.

#### T6.0 Godot integration contract  [opus] [S]
- **Context** — the first consumer game's shot controller, character-art and sprite-sheet records, prop-anchor script, lit billboard script, and pipeline doc (file list: GAME_NOTES §4, local). Read only.
- **Deliverables** — `docs/contracts/GODOT_INTEGRATION.md`, defining:
  - the driver's playback API for game-driven timing (`paused`, `seek_ms`, `set_frame`, `hold_last`, `frame_changed`);
  - origin ↔ the game's feet row / ground row;
  - the ball marker ↔ the game's prop-anchor inputs;
  - per-frame rise ↔ root motion (or a generic per-frame `offset` channel);
  - event names;
  - the adapter for the lit billboard node, in pixels with +y up.

  If the spec needs an addendum to FR-GD-03, write it.
- **Acceptance** — a mapping table from every character-art and sprite-sheet field the shot controller uses to a source in the PixelForgeAsset.

#### T6.1 Godot importer + harness  [sonnet] [M]
- **Deliverables**:
  - `godot/addons/pixel_forge/`: `plugin.cfg` (versioned), `pxf_reader.gd`, `import_plugin.gd` (options: which animations and skins, trim, padding), and `pixel_forge_asset.gd`, with atlas shelf packing;
  - `godot/test/`: a project with GUT vendored and pinned to 9.6.1, and `run_tests.sh` **copied from the game's runner (GAME_NOTES §1)** (it does `--import` before GUT and fails when GUT reports parse errors);
  - `fixtures/src/godot.ts`, which generates `godot/test/fixtures/*.pxf` covering two directions, a mirror, markers, events and trimmed frames. CI checks the output is up to date.
- **Oracle** — in GUT, crop every atlas region and compare it pixel for pixel with the `render/*.png` frames in the `.pxf`.

#### T6.2 PixelForgeDriver  [sonnet] [M]
- **Spec** — FR-GD-03 and `GODOT_INTEGRATION.md`.
- **Deliverables**:
  - the driver: a clock driven by `duration_ms`, plus the game-driven API from T6.0;
  - explicit `direction` with the fallback chain, and optional `auto_direction`;
  - the `event(name)`, `finished` and `frame_changed` signals;
  - `marker()` and `marker_metres()`;
  - adapters: Sprite2D, Sprite3D and duck-typed;
  - mirroring (`flip_h` and mirrored markers).
- **Oracle** — GUT tests for timing, `seek` and `hold`, fallback, mirrored markers, and the duck-typed adapter on a fake node with the lit billboard node's properties.

#### T6.3 demo + CI  [haiku] [S]
- **Deliverables** — `godot/demo/` (plays the fixture character), and a CI job on ubuntu with Godot 4.6.1 headless (binary cached) that runs `godot/test/run_tests.sh`.
- **Acceptance** — the CI job is green.

#### D1 Early demo: the flat target move in the game  [orchestrator + sonnet]
- **Ask the user first.**
- A Sonnet subagent writes `scripts/demo/flat-move.ts`, which builds a `.pxf` from the pack sheet (target row and cells → 4 animations, durations from the game's animation table, origin from the feet row, ball marker from the existing marks; GAME_NOTES §2) into `~/pf-work/flat_move.pxf`.
- The orchestrator, on a demo branch of the game repo (GAME_NOTES §1):
  - installs the addon;
  - adds the `.pxf`;
  - drives the lit billboard node for the four target-move animations through the driver, per `GODOT_INTEGRATION.md`;
  - runs the game's test runner;
  - records a screenshot or GIF.
- **Acceptance** — the user approves the demo, which should look identical to the current art. Mismatches go to KNOWN_ISSUES.

### Wave 3b — Rig track

#### T3.3 part render + overrides + staleness  [opus] [M] ∥
- **Package** — `rig` (`renderParts`) and `core` (the hook).
- **Spec** — FR-RIG-20 steps 3–8, FR-RIG-21/22.
- **Deliverables**:
  - variant choice (explicit; auto comes in M1b) and RotSprite aligned on the pivot;
  - the `(variant, angle)` cache;
  - part overrides anchored to the pivot, and final overrides;
  - post-passes between them;
  - the skin hook;
  - `baseHash` over the bbox±1;
  - `staleOverrides`, `rebase`, `discard`.
- **Oracle** — W4 as unit tests with hand-written ASCII expectations:
  - a translated part's override follows it;
  - a rotated part's override goes stale;
  - an untouched part's override stays valid;
  - the outline runs before final overrides.
- **Acceptance** — then the review.

#### T3.8 attributeEdit  [opus] [M]
- **Package** — `rig` (pure).
- **Spec** — FR-RIG-22, FR-RIG-24.
- **Deliverables** — `attributeEdit(renderCtx, before, edited) → Override[]`:
  - additions, changes and erasures;
  - a part override when every changed pixel lies inside one part's footprint, otherwise final;
  - the erase mask, anchor and `baseHash`.
- **Oracle** — hand-written cases: an edit inside one part, an edit straddling two parts, an erase at the silhouette, an edit then a re-pose (W4).
- **Acceptance** — then the review.

#### T3.4 joint check  [sonnet] [M]
- **Deliverables** — `jointCheck(...)`, implementing `JOINT_CHECK.md`.
- **Acceptance** — exactly matches the expected coordinates written by hand in T3.0.

#### T3.5 overlap mask + split  [sonnet] [M] ∥
- **Deliverables** — `rig.overlapMask(joint)` and `core.splitRegion(doc, layer, frame, selection)` (rectangle, lasso or colour-bounded flood) as one transaction.
- **Acceptance**:
  - W2b: the split parts recomposite to the source frame by hash;
  - painting inside the mask leaves the composite at rest unchanged;
  - painting outside the mask is reported.

#### T3.6 mirroring + pose clipboard  [sonnet] [S] ∥
- **Deliverables** — the derived mirror in `renderFrame` (flipped around `origin.x`; markers mirrored, names kept), and `copyPose` / `pastePose({mirrored})`.
- **Oracle** — the mirror equals `flipH` about the origin. The marker formula `x' = 2·origin.x − x`. A mirrored paste swaps `_l`/`_r` and negates angles.

#### T3.7 bake  [sonnet] [S] ∥
- **Deliverables** — `bakeAnimation(doc, animRef, {mode})`, with overrides merged.
- **Acceptance** — the baked render equals the rig render for every frame (hash).

#### T3.9 synthetic hero  [sonnet] [M] ∥
- **Deliverables** — `fixtures/src/hero.ts`, which builds a 48×48 humanoid side view (parts with joint caps, the template bones, and one variant on the forearm) as a `.pxf`, plus `fixtures/src/aseprite/hero_parts.lua`, which writes the same parts as `fixtures/hero_parts.aseprite` with `part:` layer names.
- **Acceptance** — the joint check is clean. Every part binds by name. Both files regenerate deterministically.

#### G1 Gate: core + rig  [opus]
- The `code-review` skill (high) over the rig track.
- Re-check the code against spec §3, §6.2 and FR-RIG-20.
- `pnpm bench` against NFR-01.
- Flip ADR-008 and ADR-010 to Accepted, or revise them.
- Update KNOWN_ISSUES. Correct the model columns for W4.
- **Exit** — no open Blocker or Major findings.

### Wave 4 — io, lint, ops, server, CLI, MCP

#### T4.6 synthetic `.aseprite` fixtures  [sonnet] [S] ∥
- **Do** — Lua scripts in `fixtures/src/aseprite/`, run with `~/code/aseprite/build/bin/aseprite -b --script`. They produce:
  - part-named layers;
  - 2 tags, 1 overlapping pair;
  - linked cels;
  - an indexed palette;
  - a compressed cel.

  The generated files (< 20 KB each) are committed. Each fixture also gets an `expected.json` from the Aseprite CLI (`--list-layers --list-tags --data`), which serves as the oracle.

#### T4.4 `.aseprite` parser  [sonnet] [M]
- **Context** — `~/code/aseprite/docs/ase-file-specs.md`.
- **Deliverables** — a parser for the header, frames, layer, cel (raw, linked, compressed), tag, palette 0x2019 and user-data chunks. Unknown chunks are skipped. Typed errors.
- **Oracle** — matches `expected.json`. Each cel's pixels equal Aseprite's per-frame `--save-as` PNGs.

#### T4.5 `.aseprite` mapping + re-import  [sonnet] [M] ∥
- **Mapping rules**:
  - each tag becomes an animation; untagged frames go to `default`;
  - a frame in overlapping tags appears in each animation, as a linked cel pointing to its first occurrence (one hop);
  - Aseprite's own linked cels resolve to their source;
  - `part:` layers become parts and variants;
  - the palette is imported as the active palette when the document has none, otherwise added and reported.
- **Re-import rules**:
  - layers and parts are matched by name;
  - frames are matched by `(tag, index)`;
  - **added frames are appended without keys; removed frames drop their keys and overrides, and these appear in the returned report**;
  - bindings, pivots and keys of matched items are kept.
- **Acceptance** — one test per rule. Re-importing after a part edit leaves the hash of the rig data unchanged.

#### T4.1 lint  [sonnet] [M] ∥
- **Deliverables** — `lint(doc, opts) → Finding[]` with the rules:
  - `palette.offPalette` (on the render output, per skin);
  - `palette.opacityInLocked`;
  - `pixels.orphan`;
  - `rig.jointGap`;
  - `rig.staleOverride`;
  - `rig.rotationResidual` (stubbed);
  - `anim.emptyFrame`.

  Plus the PLAYBOOKS entry "add a lint rule".
- **Acceptance** — one fixture per rule that triggers it and one that doesn't.

#### T5.1 ops framework  [opus] [M]
- **Spec** — §6.3, FR-AI-01/14.
- **Deliverables**:
  - `defineOp`, the registry, `OpContext`, `OpError`, safety classes, `confirm` for destructive ops, and ref resolution;
  - generators (MCP tool JSON, CLI metadata, `OPERATIONS.md`) with `gen --check`;
  - the exemplars `doc.open`, `doc.summary`, `rig.setPose`;
  - the PLAYBOOKS entry "add an op", written as a Haiku-followable recipe with one fully worked example.
- **Acceptance** — then the review.

#### T5.2a ops without logic  [haiku] [S] ∥
- **Exemplar** — `rig.setPose` plus the PLAYBOOKS recipe.
- **Ops** — `doc.undo`, `doc.redo`, `frame.add`, `frame.delete`, `frame.duplicate`, `lint.run`, `rig.jointCheck`, `rig.applyTemplate`.
- **Acceptance** — each op has a schema test and an example test.

#### T5.2b ops with logic  [sonnet] [M] ∥
- **Ops** — `doc.create`, `doc.save` (roots, lock, atomic), `doc.setColorMode`, `anim.create`, `anim.update` (I6), `frame.setMeta`, `layer.update`, `cel.link`, `part.split`, `rig.bindParts`, `rig.editBones`, `rig.setPivot`, `rig.mirrorAnimation`, `rig.bake` (confirm), `override.list`, `override.resolve`, `io.import` (including cell ranges), `io.export`.
- **Acceptance** — each op is tested. `gen --check` is clean.

#### T5.3 text grid + render ops  [sonnet] [M] ∥
- **Spec** — FR-AI-12/13.
- **Deliverables**:
  - `pixels.readGrid` (per-call legend, rulers, ≤ 64×64);
  - `pixels.writeGrid` (`.` and `_`, ≤ 32×32, palette-checked; on rig frames it writes overrides via `attributeEdit`);
  - `render.frame` and `render.contactSheet`, with bone and pivot overlays drawn in `ops`.
- **Acceptance**:
  - reading then writing is a no-op;
  - more than 62 colours is an error;
  - a write on a rig frame creates the expected override (ASCII check).

#### T5.4 server: DocumentHost + ownership  [sonnet] [M] ∥
- **Deliverables** — `DocumentHost`, lockfiles, `server.json` discovery, workspace roots, the Node `FileSystem`.
- **Acceptance**:
  - **two real processes** (via `execa`): the second gets `DOC_LOCKED` with the owner's pid;
  - a stale lock is reclaimed;
  - a path outside the roots is rejected.

#### T5.5 MCP stdio server  [sonnet] [M]
- **Spec** — FR-AI-10–15, spec §8 M1a list.
- **Deliverables** — the server on the official SDK, with tools generated from the registry, image content, resources and `--trace`. Forwarding returns `NOT_IMPLEMENTED` until M2.
- **Acceptance**:
  - an in-process client calls every tool;
  - **each mutating call adds exactly one undo entry labelled `AI: <tool>`**;
  - images respect the MIME type and size limit;
  - a destructive op without `confirm` is refused.

#### T5.6a CLI shell + harness + build  [sonnet] [M]
- **Deliverables**:
  - `pf` (commander) with `mcp`, `check` (steps.json → report.json + PNGs, exit codes 0, 1 and 2), and `version`;
  - a `tsup` single-file bundle, with `pnpm link --global`, so `pf` is on PATH;
  - generic **registry → subcommand** wiring.
- **Acceptance** — `pf --version` works from any directory. `pf check` runs a sample script.

#### T5.6b generated subcommands  [haiku] [S] ∥
- **Deliverables** — `render`, `export`, `lint`, `override import|list|resolve` (`import` uses `attributeEdit`), `pack`, `unpack`, and `godot install <res-dir>` (copies the addon at the plugin.cfg version).
- **Acceptance** — CLI end-to-end tests on fixtures. `override import` round trip: edit 3 px, import, and the render equals the edited PNG.

#### T5.7 Claude Code guide  [haiku] [S] ∥
- **Deliverables** — `docs/guides/claude-code.md` (an `.mcp.json` snippet, the workspace-root flag, example prompts) and `fixtures/pf.mcp.json`.
- **Acceptance** — the orchestrator runs `claude mcp list` with the config and sees `pf` connected.

#### T5.9 W-scenario suite  [sonnet] [M]
- **Deliverables** — `scenarios/*.steps.json` for W2 (`hero_parts.aseprite` + `gappy`/`clean`), W2b, W3-manual (poses are scripted, not from an LLM) and W4-CLI, run by `pnpm scenarios` in CI.
- **Acceptance** — all pass in CI.

#### T5.8 MCP dogfood evaluation  [opus] [M]
- **Do**:
  - run `claude -p --mcp-config fixtures/pf.mcp.json --model sonnet "<W3 prompt>"` through Bash on the **CC0 character** (import from the sheet, split, rig, re-animate its jump) and on the synthetic hero;
  - read the traces (`--trace`);
  - record friction: unclear descriptions, missing tools, oversized outputs, round trips;
  - revise the descriptions and examples;
  - file new cards for missing tools.
- **Acceptance** — W3-manual is done by the LLM on both characters. `docs/ai/MCP_EVAL_M1a.md` has the evidence. Every tool description has been revised at least once based on it.

### Wave 5 — Target move + exit

#### T6.4 Target-move rebuild  [opus orchestrating, with the user] [session]
- **Work dir** — `~/pf-work/target_move/`. The pack art is read only.
- **Steps**:
  1. Import the target row and cells as 4 animations, plus the matching outline sheet as a layer (GAME_NOTES §2, §5).
  2. **Go/no-go**: split **one** frame into parts and paint the overlap. Log in STATUS whether to continue splitting or redraw the parts. Decide how the outline is handled: an outline layer as a part, or the T1.7 pass with the colour matched (#2e222f).
  3. Apply the template, bind, and set pivots and rest pose.
  4. Pose 12 frames to match the original.
  5. Touch up with `pf override import`.
  6. Add the markers `ball` and `hand_r`, the `release` event, and the T6.0 channels.
- **Acceptance** — the user approves a side-by-side contact sheet (original vs rig). Lint is clean.

#### T6.5 Swap in the rigged target move  [sonnet] [S]
- **User approval required.** On the game branch from D1, replace the flat `.pxf` with the rigged one.
- **Acceptance** — the game's test runner passes. The user approves the in-game capture. (W5)

#### G2 Gate: M1a exit  [opus]
- The `code-review` skill over M1a.
- Re-run all W-scenarios, `pnpm bench` and the determinism suite on macOS.
- Update the docs and KNOWN_ISSUES.
- **Changesets → v0.1.0 tag**, and the addon version bumped to match.
- **Rolling wave**: write the M1b cards, using what was learned about the models.
- **Exit** — the user signs off on M1a.

---

## 4. Later milestones — epics (turned into cards at their gate)

### M1b — Breadth (≈ 25 cards, Opus ≈ 4)
| Epic | Spec | Model guidance |
|---|---|---|
| E1 IK (two-bone, FABRIK) + end-effector targets in `rig.setPose` | FR-RIG-13, FR-AI-17 | opus (solver + bake to FK), sonnet (op) |
| E2 Variant auto-select + hysteresis + residual lint | FR-RIG-14 | sonnet |
| E3 Motion presets | FR-RIG-15 | opus (generator API + walk), sonnet (others) |
| E4 Converter + ConvertRecipe + variant grid | FR-CONV-* | opus (grid detection, k-centroid), sonnet (rest), haiku (dither kernels from published matrices) |
| E5 Palette generation, ramps, palette file formats, remap, skins (+ Godot per-skin atlas) | FR-PAL-02–05/07, W7 | sonnet; haiku for formats with sample files as oracles |
| E6 GIF import/export | FR-DOC-05/06 | sonnet (decoder edge cases), haiku (encoder wiring) |
| E7 Quadruped template | FR-RIG-02 | haiku |
| E8 SpriteFrames + PixelForgeSprite2D/3D | FR-GD-06 | sonnet |
| E9 Remaining MCP tools + prompts + second dogfood | §8, FR-AI-16 | haiku/sonnet split as T5.2a/b; opus eval |

### M2 — Editor (≈ 35 cards, Opus ≈ 6)
| Epic | Spec | Model guidance |
|---|---|---|
| E10 `pf serve`: HTTP, WS sync (snapshot + patches), MCP forwarding, streamable HTTP | §6.5 | opus |
| E11 Editor shell (Vite/React, dock layout, themes, shortcuts) | §9, NFR-08 | sonnet; haiku for tables |
| E12 Canvas renderer (zoom, grid, overlays, stroke preview) | §6.6 | opus designs the interface, sonnet implements |
| E13 Drawing tools | FR-DRAW-* | sonnet for the first 3 + the tool API; haiku for the rest |
| E14 Palette, ramp and skin panels | FR-PAL-03 | sonnet |
| E15 Layers / bones / views tree | | sonnet |
| E16 Timeline + onion skin + playback + preview | FR-ANIM-* | opus designs, sonnet implements |
| E17 Rig and Animate modes | FR-RIG UI | sonnet |
| E18 Overrides UI | FR-RIG-22 | sonnet |
| E19 Converter workspace | FR-CONV-08 | sonnet |
| E20 `window.__pf` + Playwright (W4-editor, W6) | FR-HARN-02/03 | sonnet |

### M3 — Reach (≈ 20 cards)
| Epic | Spec | Model guidance |
|---|---|---|
| E21 Windows: CI job, paths, locks, keychain | NFR-10 | sonnet |
| E22 Desktop shell decision + packaging (optional) | ADR-006 | opus decides, sonnet implements |
| E23 AI panel (provider, agent loop, forked proposals, token meter); user said M3 or later | FR-AI-20 | opus designs, sonnet implements |
| E24 Image providers | FR-AI-30 | sonnet for the first, haiku for the rest |
| E25 `.aseprite` export | FR-DOC-06 | sonnet |
| E26 Normal maps + LUT skins | FR-GD-08 | opus spike, sonnet |
| E27 Bake mirror with re-shading | FR-RIG-16 | sonnet |
| E28 **Experimental warping** (spike + ADR, behind a flag) | FR-RIG-40 | opus |

---

## 5. Risks to the plan
| Risk | Mitigation |
|---|---|
| Cheap models drift from the conventions | §0.5, AGENTS.md, exemplar-first cards, depcruise and lint, orchestrator verification in worktrees |
| Self-fulfilling tests | §0.6 oracles. Gap fixtures and W4 expectations written by hand. The Aseprite CLI and Godot used as external oracles. |
| RotSprite disappoints | T0.4 runs first. The rig falls back to variants plus `none`. |
| Splitting the pack art is laborious | The T6.4 go/no-go after one frame. Redrawing the parts is the fallback. |
| Game-driven timing doesn't fit the driver | T6.0 contract, then D1 checks it on flat frames before any rig work |
| Sessions end mid-card | WIP branches, handoff notes, cards sized for one subagent context |
| Private game details leak into the public repo | T0.6 scrub, GAME_NOTES.md kept outside the repo, privacy pre-commit hook with a local denylist, orchestrator checks diffs before every push |
