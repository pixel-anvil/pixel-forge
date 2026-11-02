# Project status (read this first in every new session)

Planning steps 1 to 5 are done (research, spec, plan and their reviews). Implementation: **M1a is done and tagged `v0.1.0`; M1b is in progress** (`docs/03-plan-m1b.md`; M1a tasks are in `docs/02-plan.md`). History, the planning decisions log and the M1a progress log: `docs/STATUS-archive.md`.

## Standing rules
- **Cost mode (user, 2026-11-01):** run the orchestrator on **Sonnet/medium** (`/model sonnet`, `/effort medium`). This replaces the Opus/medium and gate-at-high lines in `docs/ai/ORCHESTRATOR.md`. Keep the short report contract (including the Deviations / External sources / Design decisions lines); Opus cards still run at high.
- Max two agents at a time; at most one on Opus. Use subagents for code-writing cards. For mechanical, output-heavy steps (test loops, captures), give the user commands that write to log files and print only totals.
- Work goes on wave branches and PRs to `main` (M1b: branch `m1b-wave0`). The user's sign-off is needed before any tag and before a merge to `main`: prepare them, do not do them.
- The game's demo worktree (GAME_NOTES §1 path + `-pf-demo`, branch `pixel-forge-demo`) is local only; never push it.
- If an agent stops at the usage limit, resume it with `SendMessage`.

## M1b progress (branch `m1b-wave0`)
- **Plan approved by the user on 2026-11-02.** User answers: (1) E4.0 (how JPEG/WebP decode): tell the user the choice, who approves any new dependency; (2) W1 photo: try to make one; the user may give CC0 sprites for more tests. T5.11 stays unscheduled; W3 stays as it is.
- Wave B0 done so far: ☑ T5.13 `rig.setPartZ` (RIG-07 half fixed; it counts per-frame z keys and does not delete them). ☑ T5.10 `rig.readPose` (MCP-03 resolved; also `pf://doc/{id}/animations/.../pose/{frame}` resources). ☑ B0.3 `tools/list` 83,005 → 75,775 bytes (−8.7%; limit 76,300): conventions and the undo note moved to server `instructions`; `additionalProperties:false` and `annotations.title` dropped from the listed view only.
- **Tool size:** field descriptions (about 3.9 KB of `pattern`) and input schemas are the rest, so tool groups (card TG.1, first card of wave B2; default stays all groups until G3) are the real fix. Every new tool must remove text elsewhere until then (MCP-04).
- **Open:** one unexplained flaky full-suite failure in the B0.3 agent's run (3 reruns passed). W3 must be re-run at G2b: a client that ignores server instructions loses the conventions line.
- **In flight:** nothing.
- **Next:** T5.17 (needs T5.10) and T5.14 (T5.13 is done) first; then T5.15 and T5.12 (no dependencies); then T5.16 and B0.1 (need T5.17); then B0.2 (needs T5.14).

## Open questions for the user
1. E4.0 (before wave B3): the JPEG/WebP decoder choice and its dependency, for approval.
