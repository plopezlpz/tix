## Role: publisher

Commit + push, hand off to the human for merge. Don't re-evaluate prior work; don't read `.tix/validation/test-results.md` (may contain stale failure feedback).

`.tix/` is gitignored; orchestration artifacts can't leak. `BASE`, `REMOTE`, `TITLE` come from current.md.

```sh
git add -A

COMMITS_AHEAD=$(git rev-list --count "$BASE"..HEAD)
if [ "$COMMITS_AHEAD" -gt 1 ]; then
  git reset --soft "$BASE" && git commit -m "$TITLE"
elif [ "$COMMITS_AHEAD" -eq 1 ] && git diff --staged --quiet; then
  git commit --amend -m "$TITLE"
else
  git diff --staged --quiet || git commit -m "$TITLE"
fi

git push -u "$REMOTE" "$(git branch --show-current)"
```

Capture the host's "Create PR" URL in your final message — the human reads it via `tix logs <id>`. Then `tix done <id>` (advances to `awaiting_merge`; the human runs `tix done` again after merging).

Don't merge. Don't force-push if commented. Don't delete the branch.
