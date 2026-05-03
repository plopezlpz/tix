import {
  getEvents,
  getIssue,
  incrementRound,
  logEvent,
  resetRoundCounters,
  setStatus,
  withTransaction,
} from '../db/queries.js';
import type { Issue, IssueStatus } from '../types.js';
import { getStateConfig, isTerminal, resolveTransition, STATES, validExits } from './states.js';

export interface TransitionResult {
  from: IssueStatus;
  to: IssueStatus;
  capReached: boolean;
  reason?: string;
}

function move(issue: Issue, to: IssueStatus, extra?: { reason?: string }): TransitionResult {
  // Wrap the whole status-change + counter-bump + cap-trip in a single tx so
  // a crash mid-sequence can't leave the issue parked above its cap.
  return withTransaction(() => {
    const from = issue.status;
    setStatus(issue.id, to);
    logEvent(issue.id, 'transition', { from, to, ...(extra ?? {}) });

    // After landing in `to`, see if `to` itself has a round counter to bump.
    // Round counters increment on entry to the revise/validated states so the
    // cap covers the *number of attempts*, not the number of approvals.
    const incoming = getStateConfig(to);
    if (incoming.round_counter) {
      const round = incrementRound(issue.id, incoming.round_counter);
      if (incoming.round_cap != null && round > incoming.round_cap && incoming.on_cap_reached) {
        const capTarget = incoming.on_cap_reached;
        const reason = incoming.cap_reached_reason ?? 'round cap reached';
        setStatus(issue.id, capTarget);
        logEvent(issue.id, 'cap_reached', {
          from: to,
          to: capTarget,
          round,
          cap: incoming.round_cap,
          reason,
        });
        return { from, to: capTarget, capReached: true, reason };
      }
    }
    return { from, to, capReached: false };
  });
}

/** Agent finished successfully; advance per state config's `on_done`. */
export function transitionDone(issueId: number): TransitionResult {
  const issue = getIssue(issueId);
  const cfg = getStateConfig(issue.status);
  const target = resolveTransition(cfg.on_done, issue);
  if (!target) throw missingTransition(issue.status, 'on_done');
  return move(issue, target);
}

/** Critic/reviewer wants revision. */
export function transitionRequestRevision(issueId: number): TransitionResult {
  const issue = getIssue(issueId);
  const cfg = getStateConfig(issue.status);
  if (!cfg.on_request_revision) throw missingTransition(issue.status, 'on_request_revision');
  return move(issue, cfg.on_request_revision);
}

/** Human validation failed; bounce back to coding. */
export function transitionKickback(issueId: number): TransitionResult {
  const issue = getIssue(issueId);
  const cfg = getStateConfig(issue.status);
  if (!cfg.on_kickback) throw missingTransition(issue.status, 'on_kickback');
  // Reset plan/code review counters when re-entering the code loop. They
  // describe the *current* coding pass, not the issue's lifetime — leaving
  // them at the prior cap value would force an immediate cap-trip on the next
  // review/revise loop, eliding the safety net.
  if (cfg.on_kickback === 'code') {
    resetRoundCounters(issueId, ['plan_review_round', 'code_review_round']);
    logEvent(issueId, 'rounds_reset_on_kickback', {
      reset: ['plan_review_round', 'code_review_round'],
    });
  }
  return move(issue, cfg.on_kickback);
}

export function transitionNeedsInput(issueId: number, question: string): TransitionResult {
  const issue = getIssue(issueId);
  const cfg = getStateConfig(issue.status);
  const target = cfg.on_needs_input ?? 'needs_input';
  setStatus(issueId, target);
  logEvent(issueId, 'needs_input', { from: issue.status, question });
  return { from: issue.status, to: target, capReached: false };
}

export function transitionBlock(issueId: number, reason: string): TransitionResult {
  const issue = getIssue(issueId);
  setStatus(issueId, 'blocked');
  logEvent(issueId, 'blocked', { from: issue.status, reason });
  return { from: issue.status, to: 'blocked', capReached: false };
}

/** Manual force-set, bypassing on_* table. */
export function transitionManual(issueId: number, to: IssueStatus, note?: string): TransitionResult {
  if (!(to in STATES)) {
    throw new Error(
      `unknown status '${to}'. Valid: ${Object.keys(STATES).join(', ')}`,
    );
  }
  const issue = getIssue(issueId);
  setStatus(issueId, to);
  logEvent(issueId, 'manual', { from: issue.status, to, note });
  return { from: issue.status, to, capReached: false };
}

function missingTransition(status: IssueStatus, kind: 'on_done' | 'on_request_revision' | 'on_kickback'): Error {
  const verbs = validExits(status).map((e) => e.verb).join(', ');
  return new Error(
    `state ${status} has no ${kind} transition. Valid exits: ${verbs || '(none — terminal state)'}`,
  );
}

/**
 * Resume an issue from `needs_input` back to whatever state it was in before
 * the pause. Looks at the events log for the last `needs_input` entry and
 * restores its `from` field. Optionally records a human answer as an event
 * so the next-agent kick-off can include it.
 */
export function transitionResume(issueId: number, answer?: string): TransitionResult {
  const issue = getIssue(issueId);
  if (issue.status !== 'needs_input') {
    throw new Error(`#${issueId} is not in needs_input (status=${issue.status})`);
  }
  const events = getEvents(issueId, 200);
  const pause = events.find((e) => e.kind === 'needs_input');
  if (!pause) throw new Error(`#${issueId} has no needs_input event to resume from`);
  const fromState = parseFromField(pause.data) as IssueStatus | null;
  if (!fromState) throw new Error(`#${issueId} needs_input event has no parseable from-state`);
  if (answer) {
    logEvent(issueId, 'human_answer', { answer });
  }
  setStatus(issueId, fromState);
  logEvent(issueId, 'resumed', { to: fromState, with_answer: !!answer });
  return { from: 'needs_input', to: fromState, capReached: false };
}

function parseFromField(data: string | null): string | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as { from?: string };
    return parsed.from ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply a human-validation verdict, routing through `move()` so the events
 * table records `transition` (not `manual`) for the canonical pass path.
 * `tix human-result` is the only legitimate caller.
 */
export function transitionHumanVerdict(
  issueId: number,
  verdict: 'pass' | 'fail' | 'needs-discussion',
): TransitionResult {
  const issue = getIssue(issueId);
  if (issue.status !== 'awaiting_human') {
    throw new Error(`#${issueId} is not awaiting_human (status=${issue.status})`);
  }
  if (verdict === 'pass') {
    return move(issue, 'awaiting_pr', { reason: 'human verdict=pass' });
  }
  if (verdict === 'fail') {
    return transitionKickback(issueId);
  }
  return transitionNeedsInput(issueId, 'human validator flagged needs-discussion');
}

export { isTerminal };

/** Recent transition timeline for the issue, oldest first. */
export function timeline(issueId: number, limit = 50): Array<{ kind: string; data: string | null; at: number }> {
  return getEvents(issueId, limit).reverse();
}
