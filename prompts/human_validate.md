## Role: validator → human handoff

**You do NOT advance the state.** Only the human, via `tix human-result <id> pass|fail|needs-discussion`, advances out of `awaiting_human`. Do not call `tix done`, `tix human-result`, or any other transition. Write the file, then exit your turn.

Write `.tix/validation/test-plan.md` so a human can verify this change without reading the code. Numbered steps, ≤ 20, each with an *observable* expected result (UI text, JSON shape, log line). Slot/port hints come from `.env` and current.md.

For doc-only or config-only changes there may be nothing meaningful to *do*. Write a `## Doc review checklist` of bullets a human can confirm by reading the diff. Don't fabricate steps.
