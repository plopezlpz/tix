/**
 * Test factories. The goal is to make tests readable as prose: each test
 * names a behaviour, sets up an issue with `givenIssue({...})`, drives a
 * transition with `whenDone` / `whenRequestRevision` / `whenKickback`, and
 * asserts on the result.
 *
 * The plumbing (DB rows, round-counter columns, transition routing) lives
 * here so test bodies don't repeat it.
 */
import { createIssue, getIssue, updateIssue } from '../db/queries.js';
import type { Issue, IssueStatus } from '../types.js';
import {
  transitionDone,
  transitionKickback,
  transitionRequestRevision,
} from '../workflow/transitions.js';

export interface IssueShape {
  status?: IssueStatus;
  title?: string;
  body?: string;
  needsHumanValidation?: boolean;
  /** plan_review_round */
  planRound?: number;
  /** code_review_round */
  codeRound?: number;
  /** human_validation_round */
  humanRound?: number;
}

/**
 * Create an issue in the given state with the given counter values.
 * Defaults: status=`new`, no human-val flag, all rounds at 0.
 */
export function givenIssue(shape: IssueShape = {}): Issue {
  const issue = createIssue(shape.title ?? 'test', shape.body ?? '');
  const patch: Partial<Issue> = {};
  if (shape.status && shape.status !== 'new') patch.status = shape.status;
  if (shape.needsHumanValidation) patch.needs_human_validation = 1;
  if (shape.planRound != null) patch.plan_review_round = shape.planRound;
  if (shape.codeRound != null) patch.code_review_round = shape.codeRound;
  if (shape.humanRound != null) patch.human_validation_round = shape.humanRound;
  if (Object.keys(patch).length > 0) updateIssue(issue.id, patch);
  return getIssue(issue.id);
}

export const whenDone = transitionDone;
export const whenRequestRevision = transitionRequestRevision;
export const whenKickback = transitionKickback;

export interface RoundsSnapshot {
  plan: number;
  code: number;
  human: number;
}

/** Shorthand for the three round counters on an issue. */
export function getRounds(issueId: number): RoundsSnapshot {
  const issue = getIssue(issueId);
  return {
    plan: issue.plan_review_round,
    code: issue.code_review_round,
    human: issue.human_validation_round,
  };
}

/** Shorthand for the issue's current status. */
export function getStatus(issueId: number): IssueStatus {
  return getIssue(issueId).status;
}
