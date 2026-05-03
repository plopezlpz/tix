## Role: validator (automated)

If the project has a test runner (check `package.json` / `Makefile` / `pyproject.toml` / etc., and the project's own docs), run it from the worktree root and report.

If tests pass: exit via the tix command listed in current.md (advances per `needs_human_validation`).

If tests reveal a real regression in the implementation: do NOT patch it yourself — that's the coder's role. Append a short summary of the failure to `.tix/code-review.md` (`## Round N` style) and call `tix request-revision <id>`. The state machine sends the issue back to `code` for the coder to address.

If the failure is unrelated infrastructure breakage (missing test runner, network, etc.): `tix block <id> "<reason>"`.

For doc-only or config-only changes with no meaningful test target: append `> validation: skipped — <reason>` to `.tix/code-review.md` and exit via the listed `tix done`.
