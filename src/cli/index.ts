#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import {
  createIssue,
  findIssue,
  getEvents,
  getIssue,
  listIssues,
  listSlots,
  updateIssue,
} from '../db/queries.js';
import type { IssueStatus } from '../types.js';
import {
  agentLogPath,
  deprovision,
  provision,
  spawnAgent,
  tixPaths,
  writeCurrentMd,
} from '../workers/provision.js';
import { attachCommand } from '../workers/tmux.js';
import { getStateConfig } from '../workflow/states.js';
import {
  timeline,
  transitionBlock,
  transitionDone,
  transitionHumanVerdict,
  transitionKickback,
  transitionManual,
  transitionNeedsInput,
  transitionRequestRevision,
  transitionResume,
} from '../workflow/transitions.js';
import { colorStatus, issueRow } from './format.js';
import { editInEditor, newIssueViaEditor } from './editor.js';
import { runFormatStream } from './format-stream.js';
import { reportInit, runInit } from './init.js';

const program = new Command();
program
  .name('tix')
  .description('Multi-agent coding orchestrator (SQLite + tmux + git worktrees)')
  .version('0.1.0');

// Ensure DB is initialized before any command runs.
program.hook('preAction', () => {
  getDb();
});

function parseId(arg: string): number {
  const id = Number.parseInt(arg, 10);
  if (!Number.isFinite(id)) throw new Error(`bad issue id: ${arg}`);
  return id;
}

// ─── init ─────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Scaffold the project’s .tix/ directory (config, README, optional prompt overrides)')
  .option('--with-prompts', 'Also copy tix’s baseline prompts into .tix/prompts/ for editing', false)
  .option('--force', 'Overwrite existing files', false)
  .action((opts: { withPrompts: boolean; force: boolean }) => {
    const result = runInit({ withPrompts: opts.withPrompts, force: opts.force });
    reportInit(result);
  });

// ─── new ──────────────────────────────────────────────────────────────────────
program
  .command('new')
  .description('Open $EDITOR to create a new issue')
  .option('--human-validate', 'Mark issue as needing human validation', false)
  .option('--title <title>', 'Title (skips editor for body if --body also given)')
  .option('--body <body>', 'Body markdown (used with --title)')
  .action((opts: { humanValidate: boolean; title?: string; body?: string }) => {
    let title: string;
    let body: string;
    if (opts.title && opts.body != null) {
      title = opts.title;
      body = opts.body;
    } else {
      const r = newIssueViaEditor();
      if (!r) {
        console.error('aborted: empty issue');
        process.exit(1);
      }
      title = opts.title ?? r.title;
      body = opts.body ?? r.body;
    }
    const issue = createIssue(title, body);
    if (opts.humanValidate) {
      updateIssue(issue.id, { needs_human_validation: 1 });
    }
    console.log(`created #${issue.id}: ${title}`);
  });

// ─── list ─────────────────────────────────────────────────────────────────────
program
  .command('list')
  .alias('ls')
  .description('List issues')
  .option('--status <status>', 'Filter by status')
  .action((opts: { status?: IssueStatus }) => {
    const issues = listIssues(opts.status ? { status: opts.status } : undefined);
    if (issues.length === 0) {
      console.log(pc.dim('(no issues)'));
      return;
    }
    for (const i of issues) console.log(issueRow(i));
  });

// ─── show ─────────────────────────────────────────────────────────────────────
program
  .command('show <id>')
  .description('Show an issue and recent events')
  .option('--events <n>', 'How many events to include', '15')
  .action((idArg: string, opts: { events: string }) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    console.log(`${pc.bold(`#${issue.id}`)} ${issue.title}`);
    console.log(`status:    ${colorStatus(issue.status)}`);
    console.log(`slot:      ${issue.slot ?? '-'}`);
    console.log(`branch:    ${issue.branch ?? '-'}`);
    console.log(`worktree:  ${issue.worktree_path ?? '-'}`);
    console.log(`tmux:      ${issue.tmux_session ?? '-'}`);
    console.log(`rounds:    plan=${issue.plan_review_round} code=${issue.code_review_round} human=${issue.human_validation_round}`);
    console.log(`flags:     ${issue.needs_human_validation ? 'human-validate ' : ''}${issue.pr_url ? `pr=${issue.pr_url}` : ''}`);
    console.log('');
    console.log(pc.dim('── body ────────────────────────────────────────────'));
    console.log(issue.body);
    console.log(pc.dim('── events ──────────────────────────────────────────'));
    const events = getEvents(id, Number.parseInt(opts.events, 10));
    for (const e of events.reverse()) {
      const date = new Date(e.at * 1000).toISOString().slice(0, 19).replace('T', ' ');
      console.log(`${pc.dim(date)} ${pc.bold(e.kind)} ${e.data ?? ''}`);
    }
  });

// ─── edit ─────────────────────────────────────────────────────────────────────
program
  .command('edit <id>')
  .description('Edit issue body in $EDITOR')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    const before = `# ${issue.title}\n\n${issue.body}`;
    const edited = editInEditor(before);
    const lines = edited.split('\n');
    const firstNonBlank = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonBlank === -1) {
      console.log('no change');
      return;
    }
    let title = issue.title;
    let bodyStart = 0;
    const first = lines[firstNonBlank]!;
    if (first.startsWith('# ')) {
      title = first.slice(2).trim();
      bodyStart = firstNonBlank + 1;
    } else {
      bodyStart = firstNonBlank;
    }
    const body = lines.slice(bodyStart).join('\n').trim();
    updateIssue(id, { title, body });
    if (issue.worktree_path) writeCurrentMd(id);
    console.log(`updated #${id}`);
  });

// ─── claim ────────────────────────────────────────────────────────────────────
program
  .command('claim <id>')
  .description('Allocate slot, provision worktree+db, open tmux session, mark planning')
  .option('--no-db', 'Skip per-slot Postgres clone (faster bring-up for testing)')
  .option('--spawn', 'Also spawn the agent process inside the tmux session', false)
  .action((idArg: string, opts: { db: boolean; spawn: boolean }) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    if (issue.status === 'new') {
      console.error(`refusing to claim #${id}: status is 'new'. Run \`tix status ${id} ready\` first to mark it claimable.`);
      process.exit(1);
    }
    if (issue.status !== 'ready') {
      console.error(`refusing to claim #${id}: status is ${issue.status}`);
      process.exit(1);
    }
    const result = provision(id, { skipDb: !opts.db });
    transitionDone(id); // ready.on_done = 'plan'
    writeCurrentMd(id);
    console.log(`claimed #${id} → slot ${result.slot}`);
    console.log(`  worktree: ${result.worktreePath}`);
    console.log(`  branch:   ${result.branch}`);
    console.log(`  tmux:     ${result.tmuxSession}`);
    if (opts.spawn) {
      spawnAgent(id);
      console.log(`  spawned agent in ${result.tmuxSession}`);
    } else {
      console.log(pc.dim(`  attach with: tix attach ${id}    (or: tmux attach -t ${result.tmuxSession})`));
    }
  });

// ─── attach ───────────────────────────────────────────────────────────────────
program
  .command('attach <id>')
  .description('Attach (or switch) to the issue’s tmux session')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    if (!issue.tmux_session) {
      console.error(`#${id} has no tmux session — run \`tix claim ${id}\` first`);
      process.exit(1);
    }
    const { cmd, args } = attachCommand(issue.tmux_session);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  });

// ─── spawn ────────────────────────────────────────────────────────────────────
program
  .command('spawn <id>')
  .description('Spawn the agent process inside the issue’s tmux session')
  .action((idArg: string) => {
    const id = parseId(idArg);
    spawnAgent(id);
    console.log(`spawned agent for #${id}`);
  });

// ─── done / request-revision / kickback ───────────────────────────────────────
program
  .command('done <id>')
  .description('Agent: advance per state config’s on_done')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const r = transitionDone(id);
    writeCurrentMd(id);
    reportTransition(id, r);
    autoRespawnIfNeeded(id, r.to);
  });

program
  .command('request-revision <id>')
  .description('Agent (critic/reviewer): bounce to revise state')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const r = transitionRequestRevision(id);
    writeCurrentMd(id);
    reportTransition(id, r);
    autoRespawnIfNeeded(id, r.to);
  });

program
  .command('kickback <id>')
  .description('Human-validation failed: send back to coding')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const r = transitionKickback(id);
    writeCurrentMd(id);
    reportTransition(id, r);
    autoRespawnIfNeeded(id, r.to);
  });

// ─── resume ───────────────────────────────────────────────────────────────────
program
  .command('resume <id> [answer...]')
  .description('Resume an issue from needs_input. Optional answer is logged and shown to the agent.')
  .action((idArg: string, answerParts: string[]) => {
    const id = parseId(idArg);
    const answer = answerParts.length > 0 ? answerParts.join(' ') : undefined;
    const r = transitionResume(id, answer);
    writeCurrentMd(id);
    reportTransition(id, r, answer ? `answer: ${answer}` : undefined);
    autoRespawnIfNeeded(id, r.to);
  });

// ─── needs-input ──────────────────────────────────────────────────────────────
program
  .command('needs-input <id> <question...>')
  .description('Pause for a human answer')
  .action((idArg: string, qs: string[]) => {
    const id = parseId(idArg);
    const question = qs.join(' ');
    const r = transitionNeedsInput(id, question);
    writeCurrentMd(id);
    reportTransition(id, r, `q: ${question}`);
  });

// ─── block ────────────────────────────────────────────────────────────────────
program
  .command('block <id> <reason...>')
  .description('Terminal block')
  .action((idArg: string, reasons: string[]) => {
    const id = parseId(idArg);
    const reason = reasons.join(' ');
    const r = transitionBlock(id, reason);
    writeCurrentMd(id);
    reportTransition(id, r, `reason: ${reason}`);
  });

// ─── status ───────────────────────────────────────────────────────────────────
program
  .command('status <id> <newStatus>')
  .description('Manually force-set the status')
  .option('--note <note>', 'Annotation logged with the transition')
  .action((idArg: string, newStatus: string, opts: { note?: string }) => {
    const id = parseId(idArg);
    const r = transitionManual(id, newStatus as IssueStatus, opts.note);
    writeCurrentMd(id);
    reportTransition(id, r);
  });

// ─── release ──────────────────────────────────────────────────────────────────
program
  .command('release <id>')
  .description('Tear down worktree, db, tmux, free slot. Status preserved unless --status given.')
  .option('--status <status>', 'Force the status after release (e.g. --status new to re-claim)')
  .option('--no-db', 'Skip dropping per-slot db')
  .option('--force', 'Force-remove worktree even with uncommitted changes / unmerged branch', false)
  .action((idArg: string, opts: { status?: IssueStatus; db: boolean; force: boolean }) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    // Auto-force on done/blocked: those are decided outcomes — branch and
    // edits are either safely merged or known-disposable. needs_input is
    // pause-not-end (you may still want the worktree intact), so it requires
    // explicit --force.
    const safeToForce = issue.status === 'done' || issue.status === 'blocked';
    deprovision(id, { skipDb: !opts.db, force: opts.force || safeToForce });
    if (opts.status) {
      transitionManual(id, opts.status, 'release');
    }
    console.log(`released #${id}`);
  });

// ─── needs-human-validation flag ──────────────────────────────────────────────
program
  .command('needs-human-validation <id>')
  .description('Mark/unmark issue as needing human validation step')
  .option('--off', 'Clear the flag', false)
  .action((idArg: string, opts: { off: boolean }) => {
    const id = parseId(idArg);
    updateIssue(id, { needs_human_validation: opts.off ? 0 : 1 });
    console.log(`#${id}: needs_human_validation = ${opts.off ? 0 : 1}`);
  });

// ─── human-result ─────────────────────────────────────────────────────────────
program
  .command('human-result <id> <verdict>')
  .description('Submit human validation verdict: pass | fail | needs-discussion')
  .action((idArg: string, verdict: string) => {
    const id = parseId(idArg);
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'needs-discussion') {
      console.error(`unknown verdict: ${verdict} (expected pass|fail|needs-discussion)`);
      process.exit(1);
    }
    const r = transitionHumanVerdict(id, verdict);
    writeCurrentMd(id);
    reportTransition(id, r);
    autoRespawnIfNeeded(id, r.to);
  });

// ─── show-test-plan ───────────────────────────────────────────────────────────
program
  .command('show-test-plan <id>')
  .description('Print .tix/validation/test-plan.md for the issue')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    if (!issue.worktree_path) {
      console.error(`#${id} has no worktree`);
      process.exit(1);
    }
    const path = tixPaths(issue.worktree_path).testPlan;
    if (!existsSync(path)) {
      console.error(`no test plan at ${path}`);
      process.exit(1);
    }
    console.log(readFileSync(path, 'utf8'));
  });

// ─── slots ────────────────────────────────────────────────────────────────────
program
  .command('slots')
  .description('Show slot occupancy')
  .action(() => {
    const cfg = getConfig();
    for (const s of listSlots()) {
      const issue = s.issue_id != null ? findIssue(s.issue_id) : undefined;
      const label = issue ? `#${issue.id} (${colorStatus(issue.status)}) ${issue.title}` : pc.dim('(free)');
      console.log(`slot ${s.slot}  api=:${cfg.ports.api + s.slot * 10}  fe=:${cfg.ports.frontend + s.slot * 10}  ${label}`);
    }
  });

// ─── timeline ─────────────────────────────────────────────────────────────────
program
  .command('timeline <id>')
  .description('Print the issue’s event timeline (oldest first)')
  .option('--limit <n>', 'How many events', '50')
  .action((idArg: string, opts: { limit: string }) => {
    const id = parseId(idArg);
    for (const e of timeline(id, Number.parseInt(opts.limit, 10))) {
      const date = new Date(e.at * 1000).toISOString().slice(0, 19).replace('T', ' ');
      console.log(`${pc.dim(date)} ${pc.bold(e.kind)} ${e.data ?? ''}`);
    }
  });

// ─── logs ─────────────────────────────────────────────────────────────────────
program
  .command('logs <id>')
  .description('Tail the agent log for the issue (.tix/agent.log inside the worktree)')
  .option('-f, --follow', 'Follow new output (tail -f)', false)
  .option('-n, --lines <n>', 'Show last N lines', '200')
  .action((idArg: string, opts: { follow: boolean; lines: string }) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    if (!issue.worktree_path) {
      console.error(`#${id} has no worktree`);
      process.exit(1);
    }
    const path = agentLogPath(issue.worktree_path);
    if (!existsSync(path)) {
      console.error(`no log yet at ${path}`);
      process.exit(1);
    }
    const args = ['-n', opts.lines];
    if (opts.follow) args.unshift('-f');
    args.push(path);
    const r = spawnSync('tail', args, { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  });

// ─── format-stream ────────────────────────────────────────────────────────────
program
  .command('format-stream')
  .description('Read claude --output-format stream-json from stdin, print human-readable lines')
  .action(async () => {
    await runFormatStream();
  });

// ─── prompt-for ───────────────────────────────────────────────────────────────
program
  .command('prompt-for <id>')
  .description('Print the prompt file the agent should be using right now')
  .action((idArg: string) => {
    const id = parseId(idArg);
    const issue = getIssue(id);
    const cfg = getStateConfig(issue.status);
    if (!cfg.prompt_file) {
      console.error(`state ${issue.status} has no prompt file`);
      process.exit(1);
    }
    console.log(cfg.prompt_file);
  });

/**
 * If the new state has an agent role, schedule a delayed respawn so the next
 * agent is launched automatically. The delay gives the previous claude -p
 * session time to finish its turn and exit, returning the tmux pane to a
 * shell prompt that can receive the new command.
 */
function autoRespawnIfNeeded(id: number, newState: IssueStatus): void {
  const cfg = getStateConfig(newState);
  if (!cfg.agent_role) return;
  // Don't auto-respawn for awaiting_human — that state waits for the human.
  if (newState === 'awaiting_human') return;
  spawnAgent(id, { delaySeconds: 4 });
  console.log(pc.dim(`  → next agent (${cfg.agent_role}) auto-spawning in ~4s`));
}

function reportTransition(
  id: number,
  r: { from: IssueStatus; to: IssueStatus; capReached: boolean; reason?: string },
  trail?: string,
): void {
  const arrow = `${colorStatus(r.from)} → ${colorStatus(r.to)}`;
  const cap = r.capReached ? pc.yellow(` [cap reached: ${r.reason ?? ''}]`) : '';
  console.log(`#${id}: ${arrow}${cap}${trail ? `  ${pc.dim(trail)}` : ''}`);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red('error:'), err instanceof Error ? err.message : err);
  process.exit(1);
});
