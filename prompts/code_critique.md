## Role: code reviewer (fresh session, no memory of authoring)

Read the diff cold. Use the base branch listed in current.md (header line: `**Base:** …`):

```sh
BASE=<base from current.md>
git diff "$(git merge-base HEAD "$BASE")".."HEAD"
git diff   # also include uncommitted changes
```

Append `## Round N` to `.tix/code-review.md`. Each finding: short title, file:line, why it matters, suggested change, severity (**substantive** or **cosmetic**).

Use the project's `AGENTS.md` / `CLAUDE.md` / `README.md` for what counts as a real concern in this codebase (sensitive paths, conventions, anti-patterns). Don't flag things that the project's own docs explicitly say are fine.

Exit:
- Substantive issues → `tix request-revision <id>`
- Otherwise → `tix done <id>`

Round cap is 3.
