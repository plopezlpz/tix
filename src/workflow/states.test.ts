import { describe, expect, it } from 'vitest';
import type { Issue, IssueStatus } from '../types.js';
import { resolveTransition, STATES, validExits } from './states.js';

describe('STATES configuration is internally consistent', () => {
  it('every entry’s `state` field matches its key', () => {
    for (const [key, cfg] of Object.entries(STATES)) {
      expect(cfg.state).toBe(key);
    }
  });

  it('every static transition target points at a defined state', () => {
    for (const cfg of Object.values(STATES)) {
      const targets = [
        typeof cfg.on_done === 'string' ? cfg.on_done : null,
        cfg.on_request_revision,
        cfg.on_kickback,
        cfg.on_needs_input,
        cfg.on_cap_reached,
      ];
      for (const target of targets) {
        if (target) expect(STATES).toHaveProperty(target);
      }
    }
  });

  it('every state with an agent_role has a prompt_file', () => {
    for (const cfg of Object.values(STATES)) {
      if (cfg.agent_role) expect(cfg.prompt_file).not.toBeNull();
    }
  });

  it('every state with a round_counter also has a round_cap and on_cap_reached target', () => {
    for (const cfg of Object.values(STATES)) {
      if (cfg.round_counter) {
        expect(cfg.round_cap).not.toBeNull();
        expect(cfg.on_cap_reached).not.toBeNull();
      }
    }
  });

  it('every state is reachable from `new` through some sequence of transitions', () => {
    // Seed with function-form on_done targets that the static walk can't see.
    // `validate.on_done` is a function returning awaiting_human or awaiting_pr;
    // both are valid runtime targets and so reachable in practice.
    const reachable = new Set(['new', 'awaiting_human', 'awaiting_pr']);
    const targetsOf = (cfg: (typeof STATES)[keyof typeof STATES]): string[] => {
      const out: string[] = [];
      if (typeof cfg.on_done === 'string') out.push(cfg.on_done);
      if (cfg.on_request_revision) out.push(cfg.on_request_revision);
      if (cfg.on_kickback) out.push(cfg.on_kickback);
      if (cfg.on_needs_input) out.push(cfg.on_needs_input);
      if (cfg.on_cap_reached) out.push(cfg.on_cap_reached);
      return out;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const cfg of Object.values(STATES)) {
        if (!reachable.has(cfg.state)) continue;
        for (const t of targetsOf(cfg)) {
          if (!reachable.has(t)) {
            reachable.add(t);
            changed = true;
          }
        }
      }
    }
    for (const key of Object.keys(STATES)) {
      expect(reachable, `state \`${key}\` is unreachable`).toContain(key);
    }
  });
});

describe('resolveTransition', () => {
  const dummyIssue = (overrides: Partial<Issue> = {}): Issue =>
    ({ id: 1, status: 'validate', needs_human_validation: 0, ...overrides } as Issue);

  it('returns the static target for string transitions', () => {
    expect(resolveTransition('plan_review', dummyIssue())).toBe('plan_review');
  });

  it('calls the function for function transitions', () => {
    const fn = (i: Issue): IssueStatus => (i.needs_human_validation ? 'awaiting_human' : 'awaiting_pr');
    expect(resolveTransition(fn, dummyIssue({ needs_human_validation: 1 }))).toBe('awaiting_human');
    expect(resolveTransition(fn, dummyIssue({ needs_human_validation: 0 }))).toBe('awaiting_pr');
  });

  it('returns null for null transitions', () => {
    expect(resolveTransition(null, dummyIssue())).toBeNull();
  });
});

describe('validExits enumerates legitimate exit verbs per state', () => {
  const verbs = (state: Parameters<typeof validExits>[0]): string[] =>
    validExits(state).map((e) => e.verb);

  it('plan offers done, needs-input, block', () => {
    expect(verbs('plan')).toEqual(['done', 'needs-input', 'block']);
  });

  it('plan_review adds request-revision', () => {
    expect(verbs('plan_review')).toEqual(['done', 'request-revision', 'needs-input', 'block']);
  });

  it('awaiting_human offers kickback (the human routes via tix human-result)', () => {
    expect(verbs('awaiting_human')).toContain('kickback');
    expect(verbs('awaiting_human')).not.toContain('done');
  });

  it('done has only the terminal escapes (an agent shouldn’t be running anyway)', () => {
    expect(verbs('done')).toEqual(['needs-input', 'block']);
  });
});
