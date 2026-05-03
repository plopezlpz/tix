import { describe, expect, it } from 'vitest';
import {
  getRounds,
  getStatus,
  givenIssue,
  whenDone,
  whenKickback,
  whenRequestRevision,
} from '../test-utils/given.js';
import { transitionHumanVerdict, transitionNeedsInput, transitionResume } from './transitions.js';
import { getEvents } from '../db/queries.js';

describe('plan loop', () => {
  it('plan → plan_review when the planner finishes', () => {
    const { id } = givenIssue({ status: 'plan' });
    expect(whenDone(id).to).toBe('plan_review');
  });

  it('plan_review → code when the critic approves', () => {
    const { id } = givenIssue({ status: 'plan_review' });
    expect(whenDone(id).to).toBe('code');
  });

  it('plan_review → plan_revise when the critic requests revision', () => {
    const { id } = givenIssue({ status: 'plan_review' });
    expect(whenRequestRevision(id).to).toBe('plan_revise');
  });

  it('entering plan_revise increments plan_review_round', () => {
    const { id } = givenIssue({ status: 'plan_review' });
    whenRequestRevision(id);
    expect(getRounds(id).plan).toBe(1);
  });

  it('plan_revise on round 4 trips the cap and force-advances to code', () => {
    const { id } = givenIssue({ status: 'plan_review', planRound: 3 });
    const r = whenRequestRevision(id);
    expect(r.to).toBe('code');
    expect(r.capReached).toBe(true);
    expect(r.reason).toMatch(/plan_review cap/);
  });

  it('a clean approve on the first critique never bumps the counter', () => {
    const { id } = givenIssue({ status: 'plan_review' });
    whenDone(id);
    expect(getRounds(id).plan).toBe(0);
  });
});

describe('code loop', () => {
  it('code → code_review when the coder finishes', () => {
    const { id } = givenIssue({ status: 'code' });
    expect(whenDone(id).to).toBe('code_review');
  });

  it('code_review → validate when the reviewer approves', () => {
    const { id } = givenIssue({ status: 'code_review' });
    expect(whenDone(id).to).toBe('validate');
  });

  it('code_review → code_revise when the reviewer requests revision', () => {
    const { id } = givenIssue({ status: 'code_review' });
    expect(whenRequestRevision(id).to).toBe('code_revise');
  });

  it('code_revise on round 4 trips the cap and force-advances to validate', () => {
    const { id } = givenIssue({ status: 'code_review', codeRound: 3 });
    const r = whenRequestRevision(id);
    expect(r.to).toBe('validate');
    expect(r.capReached).toBe(true);
  });
});

describe('validation routing depends on the human-validation flag', () => {
  it('validate with needs_human_validation=true → awaiting_human', () => {
    const { id } = givenIssue({ status: 'validate', needsHumanValidation: true });
    expect(whenDone(id).to).toBe('awaiting_human');
  });

  it('validate with needs_human_validation=false → awaiting_pr', () => {
    const { id } = givenIssue({ status: 'validate', needsHumanValidation: false });
    expect(whenDone(id).to).toBe('awaiting_pr');
  });
});

describe('human validation', () => {
  it('entering awaiting_human increments human_validation_round', () => {
    const { id } = givenIssue({ status: 'validate', needsHumanValidation: true });
    whenDone(id);
    expect(getRounds(id).human).toBe(1);
  });

  it('awaiting_human entry round 4 trips the cap and blocks for triage', () => {
    const { id } = givenIssue({
      status: 'validate',
      needsHumanValidation: true,
      humanRound: 3,
    });
    const r = whenDone(id);
    expect(r.to).toBe('blocked');
    expect(r.capReached).toBe(true);
    expect(r.reason).toMatch(/human validation/);
  });

  it('kickback from awaiting_human routes to code', () => {
    const { id } = givenIssue({ status: 'awaiting_human' });
    expect(whenKickback(id).to).toBe('code');
  });

  it('kickback resets plan/code review counters but preserves human counter', () => {
    const { id } = givenIssue({
      status: 'awaiting_human',
      planRound: 2,
      codeRound: 3,
      humanRound: 2,
    });
    whenKickback(id);
    expect(getRounds(id)).toEqual({ plan: 0, code: 0, human: 2 });
  });
});

describe('error reporting', () => {
  it('done from a state with no on_done lists the valid exits', () => {
    const { id } = givenIssue({ status: 'awaiting_human' });
    expect(() => whenDone(id)).toThrow(/no on_done.*Valid exits.*kickback/);
  });

  it('request-revision from code is not permitted', () => {
    const { id } = givenIssue({ status: 'code' });
    expect(() => whenRequestRevision(id)).toThrow(/no on_request_revision/);
  });

  it('kickback from code is not permitted', () => {
    const { id } = givenIssue({ status: 'code' });
    expect(() => whenKickback(id)).toThrow(/no on_kickback/);
  });
});

describe('validator can request revision when tests reveal a regression', () => {
  it('validate.request-revision routes back to code', () => {
    const { id } = givenIssue({ status: 'validate' });
    expect(whenRequestRevision(id).to).toBe('code');
  });
});

describe('human verdict routing', () => {
  it('pass goes through move() so the events table records `transition` (not `manual`)', () => {
    const { id } = givenIssue({ status: 'awaiting_human' });
    const r = transitionHumanVerdict(id, 'pass');
    expect(r.to).toBe('awaiting_pr');
    // The pass path is the canonical exit from human validation; logging it
    // as a regular transition keeps telemetry uniform with every other edge.
    const events = getEvents(id);
    const transitionToAwaitingPr = events.find(
      (e) => e.kind === 'transition' && (e.data ?? '').includes('awaiting_pr'),
    );
    expect(transitionToAwaitingPr).toBeTruthy();
  });

  it('fail kicks back to code and resets review counters', () => {
    const { id } = givenIssue({ status: 'awaiting_human', planRound: 2, codeRound: 3 });
    const r = transitionHumanVerdict(id, 'fail');
    expect(r.to).toBe('code');
    expect(getRounds(id)).toMatchObject({ plan: 0, code: 0 });
  });

  it('needs-discussion sends to needs_input', () => {
    const { id } = givenIssue({ status: 'awaiting_human' });
    const r = transitionHumanVerdict(id, 'needs-discussion');
    expect(r.to).toBe('needs_input');
  });

  it('rejects verdicts on issues not in awaiting_human', () => {
    const { id } = givenIssue({ status: 'code' });
    expect(() => transitionHumanVerdict(id, 'pass')).toThrow(/not awaiting_human/);
  });
});

describe('resume from needs_input', () => {
  it('restores the previous status from the events log', () => {
    const { id } = givenIssue({ status: 'code' });
    transitionNeedsInput(id, 'should I bump the major version?');
    expect(getStatus(id)).toBe('needs_input');

    const r = transitionResume(id);
    expect(r.from).toBe('needs_input');
    expect(r.to).toBe('code');
    expect(getStatus(id)).toBe('code');
  });

  it('records the human answer as an event so the next agent sees it', () => {
    const { id } = givenIssue({ status: 'plan' });
    transitionNeedsInput(id, 'use jwt or session cookies?');
    transitionResume(id, 'jwt');

    const events = getEvents(id);
    const answer = events.find((e) => e.kind === 'human_answer');
    expect(answer?.data ?? '').toContain('jwt');
  });

  it('refuses to resume an issue not in needs_input', () => {
    const { id } = givenIssue({ status: 'code' });
    expect(() => transitionResume(id)).toThrow(/not in needs_input/);
  });
});

describe('happy path end-to-end', () => {
  it('walks plan → plan_review → code → code_review → validate → awaiting_pr without human val', () => {
    const { id } = givenIssue({ status: 'plan' });
    whenDone(id); // plan_review
    whenDone(id); // code
    whenDone(id); // code_review
    whenDone(id); // validate
    whenDone(id); // → awaiting_pr (function-form on_done)
    expect(getStatus(id)).toBe('awaiting_pr');
  });

  it('walks plan → plan_review → code → code_review → validate → awaiting_human with human val', () => {
    const { id } = givenIssue({ status: 'plan', needsHumanValidation: true });
    whenDone(id);
    whenDone(id);
    whenDone(id);
    whenDone(id);
    whenDone(id);
    expect(getStatus(id)).toBe('awaiting_human');
  });
});
