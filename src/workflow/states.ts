import type { Issue, IssueStatus } from '../types.js';

export type RoundCounter = 'plan_review_round' | 'code_review_round' | 'human_validation_round';

/** Static target state, or a function that picks one based on the issue. */
export type Transition = IssueStatus | ((issue: Issue) => IssueStatus);

export interface StateConfig {
  state: IssueStatus;
  agent_role: string | null;
  prompt_file: string | null;
  on_done: Transition | null;
  on_request_revision: IssueStatus | null;
  on_kickback: IssueStatus | null;
  on_needs_input: IssueStatus | null;
  timeout_minutes: number | null;
  /** When entering this state, increment this counter and check the cap. */
  round_counter: RoundCounter | null;
  round_cap: number | null;
  /** What happens when round_cap is hit on entry. */
  on_cap_reached: IssueStatus | null;
  /** Reason text logged when on_cap_reached fires. */
  cap_reached_reason: string | null;
}

export const TERMINAL_STATES: ReadonlySet<IssueStatus> = new Set([
  'done',
  'needs_input',
  'blocked',
]);

export const STATES: Record<IssueStatus, StateConfig> = {
  new: {
    state: 'new',
    agent_role: null,
    prompt_file: null,
    on_done: 'ready',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: null,
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  ready: {
    state: 'ready',
    agent_role: null,
    prompt_file: null,
    on_done: 'plan',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: null,
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  plan: {
    state: 'plan',
    agent_role: 'planner',
    prompt_file: 'prompts/plan.md',
    on_done: 'plan_review',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 30,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  plan_review: {
    state: 'plan_review',
    agent_role: 'critic',
    prompt_file: 'prompts/plan_critique.md',
    on_done: 'code',
    on_request_revision: 'plan_revise',
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 20,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  plan_revise: {
    state: 'plan_revise',
    agent_role: 'reviser',
    prompt_file: 'prompts/plan_revise.md',
    on_done: 'plan_review',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 20,
    round_counter: 'plan_review_round',
    round_cap: 3,
    on_cap_reached: 'code',
    cap_reached_reason: 'plan_review cap reached, advancing with unresolved critique points',
  },
  code: {
    state: 'code',
    agent_role: 'coder',
    prompt_file: 'prompts/code.md',
    on_done: 'code_review',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 90,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  code_review: {
    state: 'code_review',
    agent_role: 'reviewer',
    prompt_file: 'prompts/code_critique.md',
    on_done: 'validate',
    on_request_revision: 'code_revise',
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 30,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  code_revise: {
    state: 'code_revise',
    agent_role: 'reviser',
    prompt_file: 'prompts/code_revise.md',
    on_done: 'code_review',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 60,
    round_counter: 'code_review_round',
    round_cap: 3,
    on_cap_reached: 'validate',
    cap_reached_reason: 'code_review cap reached, advancing to validation with unresolved review points',
  },
  validate: {
    state: 'validate',
    agent_role: 'validator',
    prompt_file: 'prompts/validate.md',
    // Conditional transition: when needs_human_validation is set, hand off to
    // a human via awaiting_human; otherwise skip straight to PR creation.
    on_done: (issue) => (issue.needs_human_validation ? 'awaiting_human' : 'awaiting_pr'),
    // If tests surface a regression beyond what the validator should patch
    // in-place, the validator can request revision — sends back to `code`
    // for the coder to address. Keeps the validator in its lane.
    on_request_revision: 'code',
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 30,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  awaiting_human: {
    // Validator agent writes .tix/validation/test-plan.md, then exits. No
    // on_done: this state is "waiting for human", not "waiting for an agent".
    // Humans advance via `tix human-result <id> <verdict>`, which transitions
    // directly to `code` (fail), `awaiting_pr` (pass), or `needs_input`
    // (needs-discussion) — there is no transient `human_validated` step.
    state: 'awaiting_human',
    agent_role: 'validator',
    prompt_file: 'prompts/human_validate.md',
    on_done: null,
    on_request_revision: null,
    on_kickback: 'code',
    on_needs_input: 'needs_input',
    timeout_minutes: null,
    round_counter: 'human_validation_round',
    round_cap: 3,
    on_cap_reached: 'blocked',
    cap_reached_reason: 'human validation failed 3 times, requires human triage',
  },
  awaiting_pr: {
    state: 'awaiting_pr',
    agent_role: 'publisher',
    prompt_file: 'prompts/pr.md',
    // Publisher's `tix done` advances to awaiting_merge — the branch is
    // pushed and (ideally) a PR exists, but it hasn't been merged yet.
    // Human runs `tix done <id>` after merging to advance to `done`.
    on_done: 'awaiting_merge',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: 15,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  awaiting_merge: {
    // No agent role: this is a human-only state. The publisher has pushed
    // the branch and (until we wire up a PR API) the human opens the PR
    // manually, then runs `tix done <id>` once it's merged.
    state: 'awaiting_merge',
    agent_role: null,
    prompt_file: null,
    on_done: 'done',
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: 'needs_input',
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  done: {
    state: 'done',
    agent_role: null,
    prompt_file: null,
    on_done: null,
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: null,
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  needs_input: {
    state: 'needs_input',
    agent_role: null,
    prompt_file: null,
    on_done: null,
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: null,
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
  blocked: {
    state: 'blocked',
    agent_role: null,
    prompt_file: null,
    on_done: null,
    on_request_revision: null,
    on_kickback: null,
    on_needs_input: null,
    timeout_minutes: null,
    round_counter: null,
    round_cap: null,
    on_cap_reached: null,
    cap_reached_reason: null,
  },
};

export function getStateConfig(state: IssueStatus): StateConfig {
  return STATES[state];
}

export function isTerminal(state: IssueStatus): boolean {
  return TERMINAL_STATES.has(state);
}

/** Resolve a (possibly function-form) Transition to its target state. */
export function resolveTransition(t: Transition | null, issue: Issue): IssueStatus | null {
  if (t == null) return null;
  return typeof t === 'function' ? t(issue) : t;
}

export interface ValidExit {
  /** The verb the user types: `done`, `request-revision`, `kickback`. */
  verb: 'done' | 'request-revision' | 'kickback' | 'needs-input' | 'block';
  /** Resolved destination state, or null for terminal escapes (`needs-input`, `block`). */
  to: IssueStatus | null;
  /** Human-readable purpose, used in current.md and error messages. */
  hint: string;
}

/**
 * Single source of truth for "what tix verbs are legitimate from this state".
 * `block` and `needs-input` are always valid (terminal escapes). `done`,
 * `request-revision`, `kickback` only when the state config defines a target.
 *
 * For function-form `on_done`, `to` is null in this list (we don't know the
 * destination without an issue). Callers that want destinations can resolve
 * separately via `resolveTransition`.
 */
export function validExits(state: IssueStatus): ValidExit[] {
  const cfg = STATES[state];
  const out: ValidExit[] = [];
  if (cfg.on_done != null) {
    const dest = typeof cfg.on_done === 'string' ? cfg.on_done : null;
    out.push({
      verb: 'done',
      to: dest,
      hint: dest ? `advance to ${dest}` : 'advance to the next state',
    });
  }
  if (cfg.on_request_revision != null) {
    out.push({
      verb: 'request-revision',
      to: cfg.on_request_revision,
      hint: `bounce to ${cfg.on_request_revision} (substantive issues found)`,
    });
  }
  if (cfg.on_kickback != null) {
    out.push({
      verb: 'kickback',
      to: cfg.on_kickback,
      hint: `kick back to ${cfg.on_kickback}`,
    });
  }
  out.push(
    { verb: 'needs-input', to: null, hint: 'pause for a human answer' },
    { verb: 'block', to: null, hint: 'terminal block (use only for unrecoverable failures)' },
  );
  return out;
}
