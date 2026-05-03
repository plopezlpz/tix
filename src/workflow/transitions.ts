import {
  findLatestEvent,
  getEvents,
  getIssue,
  incrementRound,
  logEvent,
  resetRoundCounters,
  setStatus,
  withTransaction,
} from '../db/queries.js';
import type { Issue, IssueStatus } from '../types.js';
import type { RoundCounter } from './states.js';
import { getStateConfig, isTerminal, resolveTransition, STATES, validExits } from './states.js';

export interface TransitionResult {
  from: IssueStatus;
  to: IssueStatus;
  capReached: boolean;
  reason?: string;
}

/**
 * Loop-entry states: when an issue *enters* one of these from outside the
 * loop, the loop's counters reset so the next review/revise cycle gets a
 * fresh budget. Generalises the old kickback-only reset to also cover the
 * validate-requests-revision-back-to-code path.
 */
const LOOP_RESETS: Partial<Record<IssueStatus, RoundCounter[]>> = {
  plan: ['plan_review_round'],
  code: ['plan_review_round', 'code_review_round'],
};

function move(issue: Issue, to: IssueStatus, extra?: { reason?: string }): TransitionResult {
  return withTransaction(() => {
    const from = issue.status;
    const incoming = getStateConfig(to);

    // Decide whether the cap will trip BEFORE writing any status, so a capped
    // move emits a single status_change → on_cap_reached and never a phantom
    // intermediate transition through `to` itself.
    let target = to;
    let capped = false;
    let capRound: number | undefined;
    let capReason: string | undefined;

    if (incoming.round_counter) {
      const round = incrementRound(issue.id, incoming.round_counter);
      if (incoming.round_cap != null && round > incoming.round_cap && incoming.on_cap_reached) {
        target = incoming.on_cap_reached;
        capped = true;
        capRound = round;
        capReason = incoming.cap_reached_reason ?? 'round cap reached';
        // Reset the just-bumped counter — it's logically out of bounds, and
        // leaving it set would re-trip the cap on a manual restoration.
        resetRoundCounters(issue.id, [incoming.round_counter]);
      }
    }

    // Reset loop counters when entering a loop's start state from outside it.
    // Covers kickback (awaiting_human → code), validate-requests-revision
    // (validate → code), and the plan_revise-cap forced advance to code.
    const resets = LOOP_RESETS[target];
    if (resets) resetRoundCounters(issue.id, resets);

    setStatus(issue.id, target);
    if (capped) {
      logEvent(issue.id, 'cap_reached', {
        from,
        to: target,
        round: capRound,
        cap: incoming.round_cap,
        reason: capReason,
      });
      return { from, to: target, capReached: true, reason: capReason };
    }
    logEvent(issue.id, 'transition', { from, to: target, ...(extra ?? {}) });
    return { from, to: target, capReached: false };
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
  // move() handles the loop-counter reset when entering `code`/`plan`.
  return move(issue, cfg.on_kickback);
}

export function transitionNeedsInput(issueId: number, question: string): TransitionResult {
  return withTransaction(() => {
    const issue = getIssue(issueId);
    const cfg = getStateConfig(issue.status);
    const target = cfg.on_needs_input ?? 'needs_input';
    setStatus(issueId, target);
    logEvent(issueId, 'needs_input', { from: issue.status, question });
    return { from: issue.status, to: target, capReached: false };
  });
}

export function transitionBlock(issueId: number, reason: string): TransitionResult {
  return withTransaction(() => {
    const issue = getIssue(issueId);
    setStatus(issueId, 'blocked');
    logEvent(issueId, 'blocked', { from: issue.status, reason });
    return { from: issue.status, to: 'blocked', capReached: false };
  });
}

const COUNTER_BEARING: ReadonlySet<IssueStatus> = new Set(['plan_revise', 'code_revise', 'awaiting_human']);

/** Manual force-set, bypassing on_* table. */
export function transitionManual(issueId: number, to: IssueStatus, note?: string): TransitionResult {
  if (!(to in STATES)) {
    throw new Error(
      `unknown status '${to}'. Valid: ${Object.keys(STATES).join(', ')}`,
    );
  }
  // Refuse manual transitions into states that own a round counter — entering
  // them via tix status would skip the counter bump and the cap check.
  // Use the legitimate verbs (done / request-revision / kickback) instead.
  if (COUNTER_BEARING.has(to)) {
    throw new Error(
      `refusing manual transition to '${to}' (round-counter-bearing state). ` +
        `Use the appropriate workflow verb instead, or set status to a non-counter state first.`,
    );
  }
  return withTransaction(() => {
    const issue = getIssue(issueId);
    setStatus(issueId, to);
    logEvent(issueId, 'manual', { from: issue.status, to, note });
    return { from: issue.status, to, capReached: false };
  });
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
  return withTransaction(() => {
    const issue = getIssue(issueId);
    if (issue.status !== 'needs_input') {
      throw new Error(`#${issueId} is not in needs_input (status=${issue.status})`);
    }
    // Direct query for the most recent needs_input event — getEvents was
    // capped at 200 which would miss it on long-running issues.
    const pause = findLatestEvent(issueId, 'needs_input');
    if (!pause) throw new Error(`#${issueId} has no needs_input event to resume from`);
    const fromState = parseFromField(pause.data) as IssueStatus | null;
    if (!fromState) throw new Error(`#${issueId} needs_input event has no parseable from-state`);
    if (answer) logEvent(issueId, 'human_answer', { answer });
    setStatus(issueId, fromState);
    logEvent(issueId, 'resumed', { to: fromState, with_answer: !!answer });
    return { from: 'needs_input', to: fromState, capReached: false };
  });
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
