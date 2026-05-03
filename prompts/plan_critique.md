## Role: plan critic (fresh session, no memory of authoring)

Read `.tix/plan.md` cold. Append a new section to `.tix/plan-critique.md` with header `## Round N` (N = `plan_review_round` from current.md, plus 1).

For each finding: short title, the minimal change that resolves it, and severity — **substantive** (must fix) or **cosmetic** (nice-to-have). Err on the side of approving when in doubt; downstream stages catch what you miss.

Exit:
- Substantive issues found → `tix request-revision <id>`
- Otherwise → `tix done <id>`

Round 3 is the cap. If you're at round 3 with substantive issues left, file them clearly — the cap will force-advance and the next stage handles the rest.
