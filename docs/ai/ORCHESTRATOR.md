# Orchestrator runbook

How the main session runs the plan cheaply and safely. Read this after `docs/STATUS.md`. The full protocol is plan §0.

## Session setup
- **Model:** use `/model sonnet` and `/effort medium` for routine waves. Switch to Opus (`/effort high`) only for gates (G1, G2) and for integrating Opus cards (reading their reviews).
- **Keep the context short.** When a session gets long, start a fresh one from `docs/STATUS.md`. Nothing is lost: all state lives in the repo, the worktrees and `~/pf-work/`.
- **Parallelism:** at most two background agents at a time, and at most one of them on Opus. The session usage quota is the real limit.

## The loop
1. Read `docs/STATUS.md` (Current focus / Next), then only the board rows and the cards you're about to run.
2. **Dispatch** with the Agent tool:
   - `model` and `effort` from the card;
   - `isolation: "worktree"` and `run_in_background: true`;
   - a brief that starts with: `git merge --ff-only m1a-wave1`, then `pnpm install && pnpm build`, then "Do NOT commit/push; never use git stash";
   - the card's context pack, naming exact files and spec IDs;
   - the **report contract** below.
3. **On a report**, verify in the worktree:
   `cd <worktree> && pnpm -s verify >/dev/null 2>&1 && echo ok`
   Open images only when a new golden needs review.
4. **Integrate as a patch**:
   ```sh
   git -C <wt> add -A && git -C <wt> diff --cached --binary > <scratch>/<card>.patch
   cd <repo> && git apply --3way <scratch>/<card>.patch
   ```
   Conflict rules:
   - files that are only appended to (`src/index.ts`, `README.md`): keep both sides;
   - `package.json`: take the union of the dependencies;
   - `pnpm-lock.yaml`: take ours, then run `pnpm install`.
5. **Commit only if verify passes**, in one `if` (never chain the commit after an `echo`):
   `if pnpm -s verify >/dev/null 2>&1; then git commit … && git push; else echo VERIFY_FAILED; fi`
   Then `git worktree remove --force <wt>` and `git branch -D worktree-<name>`.
6. **Record**: tick the board row, add card notes (≤ 6 lines: what, key decisions, cost) and update STATUS.
7. **Opus cards T3.3, T3.8 and T5.1**: run the `code-review` skill (high) on the staged diff, then dispatch a Sonnet/high fix agent with the findings. Accept or reject each finding explicitly.

## Report contract (paste into every brief)
> Write your full report (files, API, decisions, test output, doubts) to `.claude/reports/<card>.md` at the root of the MAIN repo checkout, not your worktree (git-ignored). Your final message to the orchestrator must be **at most 15 lines**: status (done/blocked), whether `pnpm verify` passed, worktree path, the decisions the orchestrator must make, and the top 3 doubts. Run only the checks the card asks for. No extra mutation testing or exploratory benchmarks unless the card requests them.

## Usage-limit recovery
If an agent stops with "session limit", wait for the reset, then `SendMessage` to the same agent id ("continue from where you stopped"). Its worktree keeps the work. Record the agent id and worktree in STATUS as soon as it stops.

## Hygiene
- The public repo must contain no game-specific terms and no absolute home paths. The privacy hook enforces it; the details live in `~/pf-work/GAME_NOTES.md`.
- No code ported from non-permissive sources (AGENTS.md "Licensing of code").
- Never use bare `git stash`. The stash stack is shared across worktrees.
