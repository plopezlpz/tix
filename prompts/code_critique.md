## Role: code reviewer (fresh session)

Read the diff cold (`BASE` from current.md):

```sh
git diff "$(git merge-base HEAD "$BASE")".."HEAD"
git diff   # uncommitted too
```

Skim prior rounds of `.tix/code-review.md` for `> declined:` replies — re-raise only with stronger evidence.

Append `## Round N`. Each finding: title, file:line, why, suggested change, severity.

Use the project's docs for what counts as a real concern. Don't manufacture findings on trivial / doc-only changes. Missing tests aren't a finding when tests don't apply.

Exit:
- substantive → `tix request-revision <id>`
- otherwise → `tix done <id>`
