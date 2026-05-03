import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRepoPathIsGitRepo, getConfig } from '../config.js';
import type { Issue, IssueStatus } from '../types.js';
import { getStateConfig, validExits as stateValidExits } from '../workflow/states.js';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prompts');
import { claimSlot, getEvents, getIssue, listSlots, logEvent, releaseSlot, updateIssue } from '../db/queries.js';
import { renderEnv } from './env.js';
import { ensureWorktree, removeWorktree, worktreeFor } from './git.js';
import { run, shQuote } from './sh.js';
import { createSlotDb, dropSlotDb } from './postgres.js';
import { ensureSession, killSession, sendCommand, sessionName } from './tmux.js';

export interface ProvisionResult {
  slot: number;
  worktreePath: string;
  branch: string;
  tmuxSession: string;
}

/**
 * Allocate a slot for an issue, create the worktree, render env, create the
 * per-slot DB, open a tmux session. Idempotent: if the issue already owns a
 * slot we reuse it.
 */
export function provision(issueId: number, opts: { skipDb?: boolean } = {}): ProvisionResult {
  assertRepoPathIsGitRepo();
  const issue = getIssue(issueId);

  // Acquire the slot first, then immediately persist `issues.slot` so a crash
  // anywhere downstream still leaves a recoverable state for `tix release`.
  let slot: number;
  if (issue.slot != null) {
    slot = issue.slot;
  } else {
    const claimed = claimSlot(issueId);
    if (!claimed) {
      const inUse = listSlots().filter((s) => s.issue_id != null);
      throw new Error(
        `no free slot (occupied: ${inUse.map((s) => `${s.slot}->#${s.issue_id}`).join(', ')})`,
      );
    }
    slot = claimed.slot;
    logEvent(issueId, 'slot_claimed', { slot });
    updateIssue(issueId, { slot });
  }

  const spec = worktreeFor(issueId);
  ensureWorktree(issueId);
  // Persist worktree paths early too, so a crash before the final updateIssue
  // still allows deprovision to find them.
  updateIssue(issueId, { worktree_path: spec.path, branch: spec.branch });

  // Per-issue subdirs the agents will write into. All under .tix/ so they
  // never appear at the worktree root and never pollute `git status`.
  const tx = tixPaths(spec.path);
  mkdirSync(tx.root, { recursive: true });
  mkdirSync(tx.validationDir, { recursive: true });

  // Env render: rethrow on failure. A misconfigured / unrenderable env is the
  // production-data-corruption path (agent runs against the wrong DB).
  renderEnv(spec.path, slot);

  if (!opts.skipDb) {
    try {
      createSlotDb(slot);
    } catch (err) {
      logEvent(issueId, 'db_create_failed', { error: String(err) });
      throw err;
    }
  }

  const session = sessionName(issueId);
  ensureSession(session, spec.path);
  updateIssue(issueId, { tmux_session: session });

  // Pre-create .tix/agent.log so the spawn command's tee/append always lands.
  mkdirSync(join(spec.path, '.tix'), { recursive: true });
  const logPath = agentLogPath(spec.path);
  if (!existsSync(logPath)) writeFileSync(logPath, '');

  writeWorktreeGitignore(spec.path);
  syncAgentsMd(spec.path);
  writeClaudeSettings(spec.path);
  writeCurrentMd(issueId);

  return { slot, worktreePath: spec.path, branch: spec.branch, tmuxSession: session };
}

/**
 * Tear down everything tied to the issue. Best-effort per-resource: a
 * failure on one teardown step (e.g. dropSlotDb) doesn't mask state for the
 * others. Columns are nulled only when the matching resource was actually
 * cleaned, so a partial release leaves a recoverable shape.
 *
 * Slot resolution: prefers `issue.slot`, but falls back to the slots table
 * (in case provision crashed before persisting `issues.slot`).
 */
export function deprovision(issueId: number, opts: { skipDb?: boolean; force?: boolean } = {}): void {
  const issue = getIssue(issueId);
  const slot = issue.slot ?? findSlotByIssueId(issueId);
  const failures: string[] = [];
  const patch: Partial<Issue> = { agent_state: null };

  if (slot != null) {
    if (!opts.skipDb) {
      try {
        dropSlotDb(slot, { ifExists: true });
      } catch (err) {
        failures.push('db');
        logEvent(issueId, 'db_drop_failed', { error: String(err) });
      }
    }
    try {
      killSession(sessionName(issueId));
      patch.tmux_session = null;
    } catch (err) {
      failures.push('tmux');
      logEvent(issueId, 'tmux_kill_failed', { error: String(err) });
    }
    releaseSlot(slot);
    patch.slot = null;
    logEvent(issueId, 'slot_released', { slot });
  }

  try {
    removeWorktree(issueId, { force: opts.force ?? false });
    patch.worktree_path = null;
    patch.branch = null;
  } catch (err) {
    failures.push('worktree');
    logEvent(issueId, 'worktree_remove_failed', { error: String(err) });
  }

  updateIssue(issueId, patch);
  if (failures.length > 0) {
    throw new Error(
      `partial release for #${issueId}: ${failures.join(', ')} teardown failed; ` +
        `corresponding fields preserved on the issue. See timeline for details.`,
    );
  }
}

function findSlotByIssueId(issueId: number): number | null {
  const row = listSlots().find((s) => s.issue_id === issueId);
  return row ? row.slot : null;
}

/** Resolve all tix orchestration paths, all under `.tix/`. */
export function tixPaths(worktreePath: string): {
  root: string;
  current: string;
  plan: string;
  planCritique: string;
  codeReview: string;
  validationDir: string;
  testPlan: string;
  testResults: string;
  agentLog: string;
} {
  const root = join(worktreePath, '.tix');
  return {
    root,
    current: join(root, 'current.md'),
    plan: join(root, 'plan.md'),
    planCritique: join(root, 'plan-critique.md'),
    codeReview: join(root, 'code-review.md'),
    validationDir: join(root, 'validation'),
    testPlan: join(root, 'validation', 'test-plan.md'),
    testResults: join(root, 'validation', 'test-results.md'),
    agentLog: join(root, 'agent.log'),
  };
}

/** (Re)write .tix/current.md inside the worktree. Hot cache for the agent. */
export function writeCurrentMd(issueId: number): void {
  const issue = getIssue(issueId);
  if (!issue.worktree_path) return;
  const paths = tixPaths(issue.worktree_path);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.validationDir, { recursive: true });

  const cfg = getConfig();
  const lines = [
    `# Issue ${issue.id}: ${issue.title}`,
    '',
    `**Status:** ${issue.status}`,
    `**Slot:** ${issue.slot ?? '-'}  |  **Branch:** ${issue.branch ?? '-'}  |  **Base:** ${cfg.baseBranch}  |  **Remote:** ${cfg.remote}`,
    `**Plan rounds:** ${issue.plan_review_round}  |  **Code rounds:** ${issue.code_review_round}  |  **Human val rounds:** ${issue.human_validation_round}`,
    `**Needs human validation:** ${issue.needs_human_validation ? 'yes' : 'no'}`,
    '',
    '## Body',
    '',
    issue.body,
    '',
    ...arrivalContextSection(issue.id),
    ...recentHumanAnswerSection(issue.id),
    '## How tix works',
    '',
    'Each state spawns a fresh agent. No continuity from prior sessions: read artifacts cold. Author and critic are different sessions on purpose.',
    '',
    'Project conventions live in `AGENTS.md` / `CLAUDE.md` / `README.md` at the worktree root. Real project files at the worktree root; tix files under `.tix/` (gitignored): `plan.md`, `plan-critique.md`, `code-review.md`, `validation/{test-plan,test-results}.md`, `agent.log`.',
    '',
    'Slot env in `.env`: `${TIX_PG_DBNAME}`, `${TIX_API_PORT}`, `${TIX_FRONTEND_PORT}`, `${TIX_REDIS_DB}`. Round caps: 3 review/revise iterations before force-advance. Humans merge.',
    '',
    '## Exit (call exactly one)',
    '',
    ...validExitsMarkdown(issue.status, issue.id),
    '',
    'Other transitions from this state will fail.',
    '',
  ];

  const roleBody = readPrompt(issue.status);
  if (roleBody) {
    lines.push(roleBody.trim(), '');
  }

  writeFileSync(paths.current, lines.join('\n'));
}

/** Path to the running tee'd log of the agent inside this worktree. */
export function agentLogPath(worktreePath: string): string {
  return tixPaths(worktreePath).agentLog;
}

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Rename `.tix/agent.log` to `.tix/agent.<timestamp>.log` once it crosses a
 * size threshold. Called before each spawn so a long-running issue doesn't
 * accumulate forever and `tix logs -f` stays cheap.
 */
function rotateLogIfLarge(logPath: string): void {
  if (!existsSync(logPath)) return;
  try {
    const size = statSync(logPath).size;
    if (size < LOG_ROTATE_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = logPath.replace(/agent\.log$/, `agent.${stamp}.log`);
    renameSync(logPath, archived);
  } catch {
    // best-effort; never block spawn on rotation
  }
}

/**
 * Idempotently merge tix-artifact patterns into the main repo's
 * `.git/info/exclude`. Git only consults `$GIT_COMMON_DIR/info/exclude` (the
 * main `.git/`), not per-worktree exclude files. The patterns are
 * tix-specific and never appear on the project's real branches, so adding
 * them to the shared exclude is harmless for master and other worktrees.
 */
export function writeWorktreeGitignore(worktreePath: string): void {
  // Resolve the common .git dir even when called from a linked worktree.
  const r = run('git', ['-C', worktreePath, 'rev-parse', '--git-common-dir'], { allowFail: true });
  if (r.status !== 0) return;
  const commonDir = r.stdout.trim();
  if (!commonDir) return;
  const infoDir = join(commonDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, 'exclude');
  const marker = '# --- tix orchestration artifacts (managed) ---';
  // Granular patterns: ignore the dynamic per-worktree files but allow
  // tracked project content under `.tix/` (prompts/, config.json, README.md).
  // This is what lets `tix init` ship project-shared scaffolding inside
  // the same `.tix/` directory the agent writes generated artifacts into.
  const block = [
    marker,
    '.tix/current.md',
    '.tix/plan.md',
    '.tix/plan-critique.md',
    '.tix/code-review.md',
    '.tix/validation/',
    '.tix/agent.log',
    '.tix/agent.*.log',
    '# --- end tix block ---',
    '',
  ].join('\n');

  let existing = '';
  try {
    existing = readFileSync(excludePath, 'utf8');
  } catch {
    // file may not exist; start fresh
  }
  // Idempotent update: if a tix block already exists, replace it with the
  // current desired block. Lets us evolve the patterns (e.g. blanket → granular)
  // without leaving the old block behind.
  const endMarker = '# --- end tix block ---';
  const stripped = stripExisting(existing, marker, endMarker);
  const sep = stripped.length === 0 || stripped.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, stripped + sep + block);
}

function stripExisting(text: string, startMarker: string, endMarker: string): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(endMarker, startIdx);
  if (endIdx === -1) return text;
  // Drop the block plus its trailing newline if present.
  const tail = text.slice(endIdx + endMarker.length).replace(/^\n/, '');
  return text.slice(0, startIdx) + tail;
}

/**
 * Write `.claude/settings.local.json` into the worktree so the spawned agent
 * doesn't prompt for routine commands (tix, pnpm, git read-only, common
 * shell builtins). Risky operations (rm, force push, etc.) still gate.
 *
 * Idempotent: only writes when the file is missing. Preserves user edits on
 * subsequent provision calls.
 */
export function writeClaudeSettings(worktreePath: string): void {
  const dir = join(worktreePath, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.local.json');
  if (existsSync(path)) return;
  const settings = {
    permissions: {
      allow: [
        // Agent-side tix transitions only. Not human-result/status/release/
        // claim/new — those are human commands and an agent calling them is a
        // role violation.
        'Bash(tix done *)',
        'Bash(tix request-revision *)',
        'Bash(tix kickback *)',
        'Bash(tix needs-input *)',
        'Bash(tix block *)',
        'Bash(tix show *)',
        'Bash(tix list)',
        'Bash(tix ls)',
        'Bash(tix logs *)',
        'Bash(tix timeline *)',
        // Build / package manager — projects may use any of these.
        'Bash(pnpm *)',
        'Bash(pnpm:*)',
        'Bash(npm *)',
        'Bash(yarn *)',
        'Bash(node *)',
        'Bash(npx *)',
        // Git read + common writes. Push is scoped to the configured remote;
        // other remotes, force-push variants, etc. still gate.
        'Bash(git status*)',
        'Bash(git diff*)',
        'Bash(git log*)',
        'Bash(git show*)',
        'Bash(git branch*)',
        'Bash(git add *)',
        'Bash(git commit *)',
        'Bash(git restore *)',
        'Bash(git checkout *)',
        'Bash(git switch *)',
        'Bash(git stash*)',
        'Bash(git reset*)',
        'Bash(git rev-list*)',
        'Bash(git rev-parse*)',
        'Bash(git merge-base*)',
        'Bash(git fetch*)',
        `Bash(git push ${getConfig().remote}*)`,
        `Bash(git push -u ${getConfig().remote}*)`,
        // Read-only inspection.
        'Bash(ls *)',
        'Bash(ls)',
        'Bash(cat *)',
        'Bash(head *)',
        'Bash(tail *)',
        'Bash(grep *)',
        'Bash(rg *)',
        'Bash(find *)',
        'Bash(wc *)',
        'Bash(file *)',
        'Bash(which *)',
        'Bash(echo *)',
        'Bash(pwd)',
        'Bash(date)',
        'Bash(env)',
        'Bash(printenv*)',
      ],
    },
  };
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Copy AGENTS.md (and CLAUDE.md if present) from the main repo's working tree
 * to the worktree. Lets policy edits on master propagate to all agent
 * worktrees without a commit.
 *
 * Hash-compares contents to decide whether to write. mtime alone is too
 * sensitive (a `touch` or `git checkout` bumps mtime without changing
 * content; we'd then clobber legitimate worktree edits).
 */
export function syncAgentsMd(worktreePath: string): void {
  const cfg = getConfig();
  if (worktreePath === cfg.repoPath) return;
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const src = join(cfg.repoPath, name);
    const dst = join(worktreePath, name);
    if (!existsSync(src)) continue;
    try {
      const srcContent = readFileSync(src, 'utf8');
      if (existsSync(dst)) {
        const dstContent = readFileSync(dst, 'utf8');
        // Skip if dst already matches src OR if dst differs and src isn't
        // actually newer in *content*. Either way, no clobber.
        if (dstContent === srcContent) continue;
        // dst differs from src — could be a worktree-local edit. Don't
        // overwrite. The user can manually copy if they want to sync.
        continue;
      }
      writeFileSync(dst, srcContent);
    } catch {
      // best-effort; don't block provision
    }
  }
}

/**
 * Surface the most recent state-changing event so the agent knows whether
 * it arrived by approval, by cap-forced advance, or by human kickback.
 * Different arrivals carry different priorities — a cap-reached coder needs
 * to read `.tix/plan-critique.md` for unresolved items first.
 */
function arrivalContextSection(issueId: number): string[] {
  const events = getEvents(issueId, 20);
  const STATE_KINDS = new Set(['transition', 'manual', 'resumed', 'cap_reached', 'blocked']);
  const evt = events.find((e) => STATE_KINDS.has(e.kind));
  if (!evt) return [];
  if (evt.kind === 'cap_reached') {
    const reason = parseField(evt.data, 'reason') ?? 'round cap reached';
    return [
      '## How you arrived here',
      '',
      `**Cap-forced advance.** ${reason}.`,
      'Read the relevant critique/review file (`.tix/plan-critique.md` or `.tix/code-review.md`) — there are unresolved points the previous loop didn’t close. Prioritise the substantive ones; ignore the cosmetic.',
      '',
    ];
  }
  if (evt.kind === 'resumed') {
    return [
      '## How you arrived here',
      '',
      'Resumed from a paused `needs_input`. The human’s answer is below — read it before continuing.',
      '',
    ];
  }
  return [];
}

/**
 * If the issue was *just* resumed from `needs_input`, surface the most recent
 * pending question + human answer so the freshly-spawned agent has both
 * without scrolling the events log. Once any subsequent transition happens,
 * the Q&A is considered consumed and we stop showing it.
 */
function recentHumanAnswerSection(issueId: number): string[] {
  const events = getEvents(issueId, 50);
  // The Q&A is current ONLY if the most recent state-changing event is a
  // `resumed`. Any newer transition means the agent already saw it and
  // moved on; re-injecting it is misleading.
  const STATE_KINDS = new Set(['transition', 'manual', 'resumed', 'cap_reached', 'blocked']);
  const latestStateChange = events.find((e) => STATE_KINDS.has(e.kind));
  if (!latestStateChange || latestStateChange.kind !== 'resumed') return [];

  let question: string | null = null;
  let answer: string | null = null;
  for (const e of events) {
    if (e.kind === 'human_answer' && answer == null) {
      answer = parseField(e.data, 'answer');
    } else if (e.kind === 'needs_input' && question == null) {
      question = parseField(e.data, 'question');
      break;
    }
  }
  if (!question && !answer) return [];
  const out = ['## Recent human exchange', ''];
  if (question) out.push(`**Question (from earlier needs_input):** ${question}`, '');
  if (answer) out.push(`**Human answer:** ${answer}`, '');
  return out;
}

function parseField(data: string | null, key: string): string | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const v = parsed[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Format the valid-exits list for current.md. */
function validExitsMarkdown(status: IssueStatus, id: number): string[] {
  return stateValidExits(status).map((e) => {
    const arg = e.verb === 'needs-input' ? ` "<question>"` : e.verb === 'block' ? ` "<reason>"` : '';
    const dest = e.to ? `**${e.to}**` : 'next state';
    const hint = e.verb === 'done' ? `advance to ${dest}` : e.hint;
    return `- \`tix ${e.verb} ${id}${arg}\` — ${hint}`;
  });
}

/**
 * Read the role prompt for a state. Lookup chain:
 *   1. `<repoPath>/.tix/prompts/<basename>.md` — project override (committed)
 *   2. `<tix-repo>/prompts/<basename>.md`     — tix baseline
 * Project overrides REPLACE the baseline (full replace, simpler mental model
 * than append/merge).
 */
function readPrompt(status: string): string | null {
  const stateCfg = getStateConfig(status as never);
  const file = stateCfg?.prompt_file;
  if (!file) return null;
  const basename = file.split('/').pop() ?? file;
  const cfg = getConfig();
  const projectOverride = join(cfg.repoPath, '.tix/prompts', basename);
  if (existsSync(projectOverride)) return readFileSync(projectOverride, 'utf8');
  const baseline = join(PROMPTS_DIR, '..', file);
  if (existsSync(baseline)) return readFileSync(baseline, 'utf8');
  return null;
}

/** Spawn the agent process inside the issue's tmux session. */
export function spawnAgent(issueId: number, opts: { delaySeconds?: number } = {}): void {
  const issue = getIssue(issueId);
  if (!issue.tmux_session) throw new Error(`issue ${issueId} has no tmux session — provision first`);
  if (!issue.worktree_path) throw new Error(`issue ${issueId} has no worktree — provision first`);
  ensureSession(issue.tmux_session, issue.worktree_path);
  const cfg = getConfig();

  const kickoff = buildKickoff(issue);
  const logPath = agentLogPath(issue.worktree_path);
  // Make sure the log file exists before spawning so the shell redirect inside
  // the tmux pane never fails.
  mkdirSync(join(issue.worktree_path, '.tix'), { recursive: true });
  rotateLogIfLarge(logPath);
  if (!existsSync(logPath)) writeFileSync(logPath, '');
  appendFileSync(
    logPath,
    `\n\n===== ${issue.status} @ ${new Date().toISOString()} =====\n`,
  );
  // -p (print) mode: agent runs, finishes its turn, exits. Pane returns to shell.
  // --output-format stream-json + tix format-stream: turns the JSON event
  // stream into human-readable lines (every tool call, every assistant text
  // block, the final result summary). The raw JSON would be mostly unreadable
  // and the default text format only shows the final assistant message.
  // --permission-mode auto: claude's "auto" mode — fewer prompts than default,
  // safer than bypassPermissions. Combined with .claude/settings.local.json's
  // explicit Bash allowlist for tix/pnpm/git, the agent runs without prompting
  // but still gates anything outside the allowlist.
  // Output is tee'd to .tix/agent.log so the user can `tix logs <id>` from
  // anywhere instead of having to attach to the tmux pane.
  const cmd =
    `cd ${shQuote(issue.worktree_path ?? '.')} && ` +
    `${cfg.agentCommand} -p --permission-mode auto ` +
    `--output-format stream-json --verbose ${shQuote(kickoff)} 2>&1 ` +
    `| tix format-stream ` +
    `| tee -a ${shQuote(logPath)}`;

  if (opts.delaySeconds && opts.delaySeconds > 0) {
    scheduleDetachedRespawn(issue.tmux_session, cmd, opts.delaySeconds);
    logEvent(issueId, 'agent_respawn_scheduled', {
      state: issue.status,
      session: issue.tmux_session,
      delay_s: opts.delaySeconds,
    });
    return;
  }

  sendCommand(issue.tmux_session, cmd);
  logEvent(issueId, 'agent_spawned', {
    state: issue.status,
    session: issue.tmux_session,
    cmd: cfg.agentCommand,
  });
}

function buildKickoff(issue: ReturnType<typeof getIssue>): string {
  return `Read .tix/current.md and follow it. State: ${issue.status}. Don't exit without calling one of the tix commands listed there.`;
}

/**
 * Fire-and-forget: launch a detached `sh` that sleeps and then injects the
 * given command into the tmux session via send-keys. Survives the death of
 * the parent tix process (and of the agent's own claude session).
 *
 * Uses two send-keys calls (first `-l` for the command literal, then a
 * separate Enter) — same pattern as `tmux.sendCommand`. A single
 * combined call has been observed to drop Enter on long commands.
 */
function scheduleDetachedRespawn(session: string, command: string, delaySeconds: number): void {
  const target = shQuote(session);
  const cmd = shQuote(command);
  // Bail out if the session has been killed (release-then-claim within the
  // delay window). Sessions are per-issue, so even a recycled slot has a
  // different name — but the existence check costs nothing extra.
  const script =
    `sleep ${delaySeconds}; ` +
    `tmux has-session -t ${target} 2>/dev/null || exit 0; ` +
    `tmux send-keys -t ${target} -l ${cmd}; ` +
    `tmux send-keys -t ${target} Enter`;
  const child = spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
