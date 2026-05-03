## Role: publisher

Commit, push, link a PR. **Do not** re-evaluate the work — by the time you're spawned, validation and human approval already happened. Do not read `.tix/validation/test-results.md` (it may contain prior-round failure feedback that's now history).

`.tix/` is gitignored at the repo level, so orchestration artifacts can't leak into the commit. You only need to handle real code changes. Use the base branch + remote listed in current.md (header line: `**Base:** …  |  **Remote:** …`):

```sh
BASE=<base from current.md>
REMOTE=<remote from current.md>
TITLE="<from .tix/current.md or the issue body>"

git add -A

COMMITS_AHEAD=$(git rev-list --count "$BASE"..HEAD)

if [ "$COMMITS_AHEAD" -gt 1 ]; then
  git reset --soft "$BASE"
  git commit -m "$TITLE"
elif [ "$COMMITS_AHEAD" -eq 1 ] && git diff --staged --quiet; then
  git commit --amend -m "$TITLE"
else
  git diff --staged --quiet || git commit -m "$TITLE"
fi

git push -u "$REMOTE" "$(git branch --show-current)"
```

After pushing, the host (Bitbucket / GitHub / GitLab / Gitea) usually prints a "Create pull request" URL — capture it and call:

```
tix needs-input <id> "branch pushed; open PR/MR at <url>"
```

Don't merge. Don't force-push if anyone's already commented. Don't delete the branch.
