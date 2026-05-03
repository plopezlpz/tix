## Role: validator

Run the project's test runner from the worktree root (`pnpm test` / `make test` / etc.).

- Tests pass → exit via tix command in current.md (advances per `needs_human_validation`).
- Real regression in this change → don't patch yourself. Append a short summary to `.tix/code-review.md` and `tix request-revision <id>`.
- Failure unrelated to the change (missing runner, network) → `tix block <id> "<reason>"`.
- Doc/config-only change with no test target → append `> validation: skipped — <reason>` to `.tix/code-review.md` and exit.
