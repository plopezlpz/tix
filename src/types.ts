/**
 * Phase the issue is currently in, NOT whether an agent is actively working.
 * Live activity goes in `agent_state` (Phase 3 daemon will populate that).
 *
 * Phase names: prefer phase nouns (`plan`, `code`, `validate`, `awaiting_*`)
 * over gerunds — a gerund reads as "happening now" but the field describes
 * "where the issue sits in the workflow", which may or may not have an agent
 * running against it.
 */
export type IssueStatus =
  | 'new'
  | 'ready'
  | 'plan'
  | 'plan_review'
  | 'plan_revise'
  | 'code'
  | 'code_review'
  | 'code_revise'
  | 'validate'
  | 'awaiting_human'
  | 'awaiting_pr'
  | 'awaiting_merge'
  | 'done'
  | 'needs_input'
  | 'blocked';

/**
 * Live runtime state of the agent process in the slot. Phase 3 daemon will
 * populate this from tmux pane activity; Phase 1 leaves it null.
 */
export type AgentState = 'working' | 'waiting_input' | 'idle' | 'crashed' | null;

export interface Issue {
  id: number;
  title: string;
  body: string;
  status: IssueStatus;
  group_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  tmux_session: string | null;
  slot: number | null;
  agent_state: AgentState;
  agent_state_at: number | null;
  needs_human_validation: 0 | 1;
  plan_review_round: number;
  code_review_round: number;
  human_validation_round: number;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface Event {
  id: number;
  issue_id: number;
  kind: string;
  data: string | null;
  at: number;
}

export interface Slot {
  slot: number;
  issue_id: number | null;
  claimed_at: number | null;
}

export type TransitionKind =
  | 'done'
  | 'request_revision'
  | 'kickback'
  | 'needs_input'
  | 'block'
  | 'cap_reached'
  | 'manual';

/** Every kind value `logEvent` accepts. Centralised so a typo is a type error. */
export type EventKind =
  | 'created'
  | 'status_change'
  | 'transition'
  | 'manual'
  | 'cap_reached'
  | 'needs_input'
  | 'human_answer'
  | 'resumed'
  | 'blocked'
  | 'slot_claimed'
  | 'slot_released'
  | 'env_render_failed'
  | 'db_create_failed'
  | 'db_drop_failed'
  | 'tmux_kill_failed'
  | 'worktree_remove_failed'
  | 'agent_spawned'
  | 'agent_respawn_scheduled';
