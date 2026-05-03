# Phase 1 friction log

Notes from driving real issues through the tix orchestrator. Originally intended as capture-only ("do not fix during Phase 1") but in practice many items had to be fixed in-flight to keep the orchestrator usable enough to test. Items still tagged `fixed-in-place` so it's clear what's resolved.

## Format

For each entry: when, which area was affected, status, what broke / what was done. Severity tags: `blocker / friction / nice-to-have / observed / fixed-in-place / phase-2`.

## First-run fixes (driving issue #2 through the workflow)

- **2026-05-03 / provision / blocker** — `.env.example` defines `DATABASE_URL=postgresql://...localhost:5432/bit2me-dac`. The renderer appends `TIX_DATABASE_URL` overrides at the end, but the DAC app reads `DATABASE_URL`. Agent will run against the live dev DB by default. Either: (a) make the renderer substitute `DATABASE_URL` itself when the value matches a known dev pattern, (b) add an explicit `# tix-override` comment scheme to `.env.example`, or (c) write a real `.env.template` with `${TIX_DATABASE_URL}` placeholders. Same applies to `REDIS_HOST`/`POSTGRES_DB`/etc.
- **2026-05-03 / provision / blocker** — `TIX_DATABASE_URL` is rendered as `postgresql://postgres@127.0.0.1:5432/dac_agent_1` — no password. DAC's actual `DATABASE_URL` is `postgresql://postgres:postgres@...`. Need to include the password in the slot URL (probably from config).
- **2026-05-03 / provision / friction** — `API_SERVER_PORT` (the variable DAC actually reads) is not being set anywhere. The renderer sets `TIX_API_PORT` but the app doesn't know that name. Same issue shape as `DATABASE_URL` above.
- **2026-05-03 / observation / nice-to-have** — `tix release` does not reset round counters. If you release back to `new` and re-claim, the previous run's `plan_review_round` etc. carries over. Probably want a `tix release --fresh` flag or auto-zero on status=`new`.
- **2026-05-03 / cli / friction** — `tix status <id> reade` (typo) was accepted silently and recorded as a transition to `reade`. The CLI did `as IssueStatus` cast without validating. Fixed in pass-1 review (`transitionManual` rejects unknown statuses with a list of valid options).
- **2026-05-03 / cli / nice-to-have** — `tix show <id>` doesn't print `agent_state` or `agent_state_at`. Add them to the output so users can tell whether an agent is currently active in the slot. (Daemon-time work; `agent_state` is unused in Phase 1.)
- **2026-05-03 / spawn / fixed-in-place** — original `spawnAgent` failed with "can't find session" if the tmux session had been killed. Fixed: spawn now calls `ensureSession` before `sendCommand`.
- **2026-05-03 / spawn / fixed-in-place** — first spawn prompted to approve every `tix done` call. Fixed by writing `.claude/settings.local.json` to the worktree at provision time with an explicit allowlist for tix transitions, pnpm/npm/yarn, git read-only + common writes, node, and basic shell builtins.
- **2026-05-03 / spawn / fixed-in-place** — interactive `claude` doesn't exit after the agent calls `tix done`, so subsequent `tix spawn` keystrokes land in the running claude's input box instead of the shell. Switched to `claude -p --permission-mode auto '<kickoff>'` (one-shot mode). Each agent now runs, completes, and exits cleanly.
- **2026-05-03 / spawn / fixed-in-place** — no auto-respawn between states. Fixed: `tix done` / `request-revision` / `kickback` / `human-result` now schedule a detached `sh` that injects the next `claude -p` command into the tmux pane after a 4s delay. Skipped for `awaiting_human` (waits for human). The 4s magic number is a Phase-3-daemon stop-gap.
- **2026-05-03 / visibility / fixed-in-place** — `claude -p` default text format only emits the final assistant message. Switched the spawn pipeline to `--output-format stream-json | tix format-stream | tee -a .tix/agent.log` so `tix logs <id> -f` shows every tool call and assistant text block live.
- **2026-05-03 / artifacts-vs-commits / fixed-in-place** — orchestration artifacts were appearing as untracked files in the worktree, polluting `git status`. Provision now appends a managed block to the main repo's `.git/info/exclude`. Idempotent; refreshed in Phase 2 to use granular patterns instead of a blanket `.tix/` exclude.
- **2026-05-03 / artifacts-layout / fixed-in-place** — orchestration files (`current.md`, `plan.md`, etc.) were scattered at the worktree root. Consolidated under `.tix/` so the worktree root only contains real project files.
- **2026-05-03 / commit-discipline / observed** — the coder agent for issue #2 didn't commit anything; left the change uncommitted. `prompts/code.md` says "Commit in small, conventional-commit slices" but the agent skipped it. `prompts/pr.md` updated to handle both "commits ahead" and "uncommitted working tree" cases — publisher stages + commits + squashes uniformly.
- **2026-05-03 / human-result / fixed-in-place** — `tix human-result` did not auto-respawn after fail/pass. Fixed: respawns coder on fail, publisher on pass, no respawn on needs-discussion.
- **2026-05-03 / kickback-context / fixed-in-place** — coder had no path to the human's complaints after a kickback. Updated `prompts/code.md` to read `.tix/validation/test-results.md` first when it exists with `Status: fail` / `needs-discussion`.
- **2026-05-03 / wrong-exit-command / fixed-in-place** — coder in `code` state tried `tix kickback` (only valid from `awaiting_human`) because `current.md` listed all five tix transition commands generically. Fixed: `current.md` now derives the valid-exits list from `STATES`, so only state-appropriate verbs are listed with their destination states.
- **2026-05-03 / role-boundary / fixed-in-place** — validator agent in `awaiting_human` called `tix human-result 2 success` (invalid verdict). State got corrupted because `tix human-result` mutated state before validating the verdict. Three fixes: (a) verdict validated first, before any state mutation; (b) `prompts/human_validate.md` opens with an emphatic "you do NOT advance the state, only the human does" guard; (c) `.claude/settings.local.json` allowlist no longer permits `tix human-result`, `tix status`, `tix release`, `tix claim`, `tix new` — only legitimate agent-side transitions.
- **2026-05-03 / publisher-confused / fixed-in-place** — publisher in `awaiting_pr` read stale `.tix/validation/test-results.md` (failure feedback from a prior round), interpreted it as a kickback signal, tried `tix kickback` (invalid from `awaiting_pr`), bailed without pushing. Updated `prompts/pr.md` to forbid reading test-results.md.
- **2026-05-03 / agents-md-not-in-worktree / fixed-in-place** — uncommitted policy edits to master's `AGENTS.md` didn't propagate to linked worktrees (which are cut from commits). Added `syncAgentsMd` to provision: copies `AGENTS.md` / `CLAUDE.md` from the main repo's working tree to each new worktree at provision time.
- **2026-05-03 / current-md-stale-role / observed** — `current.md` embeds the role from `prompts/<state>.md` at the last transition. If you edit a prompt mid-run, in-flight worktrees keep the old role. Workaround: re-trigger `writeCurrentMd` via a node one-liner. Phase 2: a `tix refresh-current <id>` subcommand would help.
- **2026-05-03 / release-rolls-back-status / fixed-in-place** — `tix release` defaulted to setting status back to `new` after teardown. For a `done` issue that's wrong. Fixed: status is preserved by default; `--status new` is opt-in for re-claim.

## Pass-1 code review (after first run)

- **2026-05-03 / round-counter-not-reset-on-kickback / fixed-in-place** — Critical: after a cap-forced advance from `code_revise → validate`, `code_review_round` stayed at 4. Next kickback to `code` immediately tripped the cap on re-entry to `code_revise`, eliding the safety net. `transitionKickback` now zeros `plan_review_round` and `code_review_round` on the kickback path.
- **2026-05-03 / validate-on-done-unconditional / fixed-in-place** — `validate.on_done` was hardcoded to `awaiting_human`, but the prompt promised a branch on `needs_human_validation`. Initially patched with a special-case in `transitionDone`; the elegance pass replaced it with function-form `on_done`.
- **2026-05-03 / claim-slot-toctou / fixed-in-place** — `provision()` read `issue.slot` then conditionally claimed; concurrent calls could each grab a different slot. Fixed: `claimSlot` does an explicit "already mine?" SELECT inside a transaction (later wrapped properly via `withTransaction`).
- **2026-05-03 / allowlist-missing-git-commands / fixed-in-place** — Publisher used `git reset --soft`, `git rev-list`, `git merge-base`, none of which were in the allowlist. Added them plus `git rev-parse`, `git fetch`.
- **2026-05-03 / prompts-hardcode-master-origin / fixed-in-place** — `prompts/code_critique.md` and `prompts/pr.md` had `master`/`origin` baked in. Now reference the `**Base:** … | **Remote:** …` header in `current.md`. Header values come from `cfg.baseBranch` and `cfg.remote`.
- **2026-05-03 / source-state-kickback-bump-dead-code / fixed-in-place** — Block in `transitionKickback` that bumped the source state's round counter never fired (only `awaiting_human` had `on_kickback` and its `round_counter` is `null`). Removed.
- **2026-05-03 / write-claude-settings-clobber / fixed-in-place** — `writeClaudeSettings` and `syncAgentsMd` overwrote on every provision, eating user/agent edits. Now write-if-missing for settings; mtime-aware copy for AGENTS.md.
- **2026-05-03 / send-keys-l-inconsistency / fixed-in-place** — `scheduleDetachedRespawn` didn't use `-l` for tmux send-keys; `sendCommand` did. Made consistent.
- **2026-05-03 / failed-state-removed / fixed-in-place** — `failed` was declared terminal but no transition targeted it. Removed from `IssueStatus` and `STATES` to avoid future-maintainer confusion.
- **2026-05-03 / format-stream-silent-on-unknown / fixed-in-place** — Unknown JSON event types were dropped silently; a future schema change would invisibly degrade output. Now passes through tagged `[?] <raw>`.
- **2026-05-03 / remove-worktree-always-force / fixed-in-place** — `removeWorktree` ran `git worktree remove --force` and `git branch -D` unconditionally, eating uncommitted edits / unmerged commits. Changed to non-force by default; `tix release --force` opts in. Auto-force on `done`/`blocked` only.
- **2026-05-03 / ensure-worktree-no-fetch / fixed-in-place** — Worktrees were cut from local `baseBranch`, never fetched. Added `git fetch <remote> <baseBranch>` (best-effort, allowFail) before `worktree add`.
- **2026-05-03 / git-push-allowlist-too-broad / fixed-in-place** — `Bash(git push *)` allowed any push. Tightened to `Bash(git push <remote>*)` / `Bash(git push -u <remote>*)` keyed off `cfg.remote`.

## Elegance pass

- **2026-05-03 / per-issue-tmux-sessions / fixed-in-place** — Sessions were named `tix-agent-<slot>`. A release-then-claim within the 4s respawn window could deliver orphan keystrokes to the new occupant. Switched to per-issue: `tix-agent-<issueId>`. Slots can be reused freely; session names can't collide.
- **2026-05-03 / render-env-clobber / fixed-in-place** — `renderEnv` overwrote on every provision, eating user secrets. Write-if-missing; pass `{ force: true }` to override.
- **2026-05-03 / release-auto-force-needs_input / fixed-in-place** — `tix release` auto-forced for `needs_input`. That state is a pause-not-end; the user often expects to resume. Removed from auto-force list (still works with explicit `--force`).
- **2026-05-03 / function-form-on-done / fixed-in-place** — `transitionDone`'s `validate` special-case was a leak. Now `on_done` accepts `IssueStatus | (issue) => IssueStatus`. `validate.on_done` is a function returning `awaiting_human` or `awaiting_pr`. Generic transition engine, no special cases.
- **2026-05-03 / valid-exits-duplicated / fixed-in-place** — Two near-identical `validExits` walks lived in `provision.ts` and `transitions.ts`. Consolidated as `validExits()` in `states.ts`; both consumers use it.
- **2026-05-03 / void-update-issue-cleanup / fixed-in-place** — `void updateIssue;` "for future use" was junk. Removed.
- **2026-05-03 / human-result-fabricated-result / fixed-in-place** — `human-result pass` constructed an inline `TransitionResult` and discarded the real return value. First fixed to use `transitionManual`'s return. Pass-2 review escalated: `transitionManual` logs as `manual` (not `transition`) — moved to a real `transitionHumanVerdict` helper that uses `move()` so the events table records the canonical exit edge uniformly.
- **2026-05-03 / shquote-misplaced / fixed-in-place** — `shQuote` lived in `provision.ts`. Moved to `sh.ts` next to `run`.
- **2026-05-03 / format-stream-truncates-errors / fixed-in-place** — Tool errors were truncated to 160 chars; failed `pnpm test` output was the most diagnostic part of the log. Errors now print full body; successes still truncate.
- **2026-05-03 / get-config-empty-file-crash / fixed-in-place** — Empty / malformed config file crashed with a JSON.parse stack trace. Now produces a clear `failed to parse tix config at <path>: <reason>`.
- **2026-05-03 / state-rename / fixed-in-place** — Status names were gerunds ("planning") that read like "happening now" but actually meant "in this phase". Renamed: `planning→plan`, `plan_critique→plan_review`, `coding→code`, `code_critique→code_review`, `validating→validate`, `human_validating→awaiting_human`, `pr_open→awaiting_pr`. Removed transient `human_validated` (verdict routing inlined into `tix human-result`).

## Pass-2 code review

- **2026-05-03 / human-result-pass-logs-as-manual / fixed-in-place** — Pass path went through `transitionManual` (logs `kind=manual`), making the canonical exit from human validation look like a manual override. Replaced with `transitionHumanVerdict` that calls `move()` for pass and `transitionKickback` / `transitionNeedsInput` for fail / needs-discussion.
- **2026-05-03 / current-md-hardcodes-origin / fixed-in-place** — Header advertised `**Remote:** origin` as a hardcoded literal even though `cfg` had no `remote` field. Added `Config.remote` (default `'origin'`); threaded into `writeCurrentMd`, `git fetch`, and the allowlist.
- **2026-05-03 / move-not-transactional / fixed-in-place** — `setStatus → logEvent → incrementRound → (cap) setStatus → logEvent` was five separate writes. Wrapped in `withTransaction` so a crash mid-cap can't park the issue above its cap.
- **2026-05-03 / claim-slot-select-update-race / fixed-in-place** — Two concurrent `claimSlot(<same id>)` could both pass the "already mine?" check and each grab a different free slot. Wrapped SELECT + UPDATE in `withTransaction`.
- **2026-05-03 / validate-no-back-to-code / fixed-in-place** — Validator with a real regression in tests had no clean exit (only "fix it yourself" or `tix block`), blurring role boundaries. Added `validate.on_request_revision = 'code'` and updated `prompts/validate.md` to use it for unrelated regressions.
- **2026-05-03 / absolute-env-output-collision / fixed-in-place** — `cfg.envOutput` accepted absolute paths; every slot would race writing the same file. Rejected at config-load time with a clear error.
- **2026-05-03 / orphan-human-validated-prompt / fixed-in-place** — `prompts/human_validated.md` survived the state rename. Deleted.
- **2026-05-03 / sync-slots-no-shrink / fixed-in-place** — Reducing `slotCount` left orphan rows that `claimSlot` still handed out. Now refuses to shrink past in-use slots; deletes free over-cap rows.
- **2026-05-03 / repo-path-bad-error / fixed-in-place** — Default `repoPath = process.cwd()` produced a confusing "fatal: not a git repository" from inside `git worktree add`. `assertRepoPathIsGitRepo()` runs at provision time with a clear "set repoPath in your config" message. Read-only commands like `tix list` don't trigger the check.
- **2026-05-03 / agent-log-unbounded / fixed-in-place** — `agent.log` grew indefinitely. Rotates to `.tix/agent.<timestamp>.log` once it crosses 5 MB.

## Phase 2 first chunk (project overrides + resume)

- **2026-05-03 / project-prompt-overrides / phase-2-done** — Tix baseline prompts can now be replaced per-project. Lookup chain in `readPrompt`: `<repoPath>/.tix/prompts/<basename>.md` first, fall back to tix's `prompts/<basename>.md`. Project overrides are FULL replace.
- **2026-05-03 / project-config-layer / phase-2-done** — Three-layer config merge: defaults < `<repoPath>/.tix/config.json` < `<userConfig>` (~/.config/tix/config.json or `$TIX_CONFIG`). Lets a team commit shared values (slotCount, baseBranch, postgres template) while individuals override on their machine.
- **2026-05-03 / tix-init / phase-2-done** — `tix init` scaffolds `<repoPath>/.tix/{config.json,README.md}`. `--with-prompts` also copies tix's baseline prompts into `.tix/prompts/` for editing. `--force` to overwrite.
- **2026-05-03 / tix-resume / phase-2-done** — `tix resume <id> [answer...]` reads the most recent `needs_input` event from the timeline, restores status to its `from` field, optionally records the human's answer as an event, and auto-respawns. The next agent's `current.md` includes the question and the answer.
- **2026-05-03 / granular-gitignore / phase-2-done** — Replaced blanket `.tix/` exclude with specific patterns (`.tix/current.md`, `.tix/plan.md`, …, `.tix/agent.log`, `.tix/agent.*.log`, `.tix/validation/`). Lets `<repo>/.tix/prompts/` and `<repo>/.tix/config.json` be tracked while generated artifacts stay ignored. Update is idempotent: existing managed blocks are replaced wholesale, so we can evolve the patterns.

## Test coverage added

- **2026-05-03 / tests-added** — Vitest with helpers (`givenIssue`, `whenDone`/`whenRequestRevision`/`whenKickback`, `getRounds`, `getStatus`) so test bodies read like prose. 69 tests at last count, ~190ms total runtime. Coverage:
  - `transitions.test.ts` — FSM transitions, round caps, kickback resets, error messages, function-form on_done routing, human-verdict routing, `tix resume`, happy-path end-to-end.
  - `states.test.ts` — config consistency, `validExits`, `resolveTransition`, full state-graph reachability.
  - `format-stream.test.ts` — parser as a pure function with JSON fixtures, including `tool->err` no-truncate and unknown-event pass-through.
  - `config.test.ts` — three-layer merge, malformed-file errors, absolute-envOutput rejection.
  - `db/index.test.ts` — `syncSlots` grow/shrink behaviour, refuse-to-shrink past in-use.
  - `init.test.ts` — `tix init` scaffolding, idempotency, `--force`, `--with-prompts`, project config layer, user-overrides-project.

## Open questions

- Should round counters reset on `tix release --status new` (re-claim flow)? Currently they don't.
- Should agent-side commands ever be allowed to call `tix needs-human-validation` to *upgrade* an issue mid-flight if they realise the change is risky?
- Where should the agent dump scratch notes if `.tix/plan.md` would otherwise grow past the ≤60-line cap?

## Carried forward to Phase 2 / 3

- **PR/MR API integration** — publisher today pushes the branch and tells the human to open the PR by hand. A pluggable `src/publishers/{bitbucket,github,gitlab}.ts` with REST integration would close the loop.
- **`test-results.md` per-round rotation** — currently accumulates; the publisher had to be told not to read it. Per-round files (`test-results-round-N.md`) would be cleaner than the current "ignore stale content" workaround.
- **`tix refresh-current <id>` subcommand** — for picking up prompt edits mid-run without releasing.
- **Phase 3 daemon** — replaces the 4s magic-number respawn delay with poll-driven detection of previous-claude exit. Also: enforce per-state `timeout_minutes`, populate `agent_state` column from tmux pane activity.
- **Phase 4 TUI** — Ink-based, polling SQLite, jump-to-tmux keybinds, macOS notifications on `awaiting_human` / `needs_input` / `awaiting_pr`.
