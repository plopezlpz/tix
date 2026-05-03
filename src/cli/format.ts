import pc from 'picocolors';
import type { Issue, IssueStatus } from '../types.js';

const STATUS_COLOR: Record<IssueStatus, (s: string) => string> = {
  new: pc.dim,
  ready: pc.cyan,
  plan: pc.cyan,
  plan_review: pc.cyan,
  plan_revise: pc.cyan,
  code: pc.blue,
  code_review: pc.blue,
  code_revise: pc.blue,
  validate: pc.yellow,
  awaiting_human: pc.magenta,
  awaiting_pr: pc.green,
  awaiting_merge: pc.green,
  done: pc.green,
  needs_input: pc.yellow,
  blocked: pc.red,
};

export function colorStatus(s: IssueStatus): string {
  return STATUS_COLOR[s]?.(s) ?? s;
}

export function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

export function issueRow(i: Issue): string {
  const id = pad(`#${i.id}`, 5);
  const status = pad(colorStatus(i.status), 30); // colour codes inflate length, use a fixed pad
  const slot = pad(i.slot == null ? '-' : `s${i.slot}`, 4);
  return `${id} ${slot} ${status} ${i.title}`;
}
