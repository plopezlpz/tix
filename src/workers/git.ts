import { existsSync } from 'node:fs';
import { getConfig } from '../config.js';
import { run } from './sh.js';

export interface WorktreeSpec {
  path: string;
  branch: string;
}

export function worktreeFor(issueId: number): WorktreeSpec {
  const cfg = getConfig();
  return {
    path: `${cfg.worktreesRoot}/${cfg.worktreePrefix}${issueId}`,
    branch: `${cfg.branchPrefix}${issueId}`,
  };
}

export function ensureWorktree(issueId: number): WorktreeSpec {
  const cfg = getConfig();
  const spec = worktreeFor(issueId);
  if (existsSync(spec.path)) return spec;

  // Best-effort fetch so we cut from a fresh base, not whatever the user last
  // pulled. If the remote isn't reachable, fall back to the local ref.
  run('git', ['fetch', cfg.remote, cfg.baseBranch], { cwd: cfg.repoPath, allowFail: true });

  // Branch may or may not already exist. `git worktree add -B` creates or
  // resets the branch from the (now-up-to-date) baseBranch.
  run('git', ['worktree', 'add', '-B', spec.branch, spec.path, cfg.baseBranch], {
    cwd: cfg.repoPath,
  });
  return spec;
}

export interface RemoveWorktreeOpts {
  /** Force removal even with uncommitted changes / unmerged branch. */
  force?: boolean;
}

/**
 * Remove the worktree and best-effort delete the branch.
 *
 * Default is non-destructive: `git worktree remove` (no `--force`) refuses
 * if there are uncommitted edits, and `git branch -d` (lowercase) refuses
 * unmerged branches. Pass `{ force: true }` to override (e.g. when releasing
 * an issue that's already merged or terminally blocked).
 *
 * Branch delete is always allowFail — it's a best-effort cleanup, and the
 * branch may legitimately be checked out elsewhere or already gone.
 */
export function removeWorktree(issueId: number, opts: RemoveWorktreeOpts = {}): void {
  const cfg = getConfig();
  const spec = worktreeFor(issueId);
  const wtArgs = ['worktree', 'remove', spec.path];
  if (opts.force) wtArgs.splice(2, 0, '--force');
  run('git', wtArgs, { cwd: cfg.repoPath, allowFail: true });

  const brArgs = ['branch', opts.force ? '-D' : '-d', spec.branch];
  run('git', brArgs, { cwd: cfg.repoPath, allowFail: true });
}
