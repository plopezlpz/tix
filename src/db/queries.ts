import type Database from 'better-sqlite3';
import type { EventKind, Issue, IssueStatus } from '../types.js';
import { getDb } from './index.js';

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function logEvent(
  issueId: number,
  kind: EventKind,
  data?: Record<string, unknown> | null,
): void {
  const db = getDb();
  db.prepare('INSERT INTO events(issue_id, kind, data, at) VALUES (?, ?, ?, ?)').run(
    issueId,
    kind,
    data == null ? null : JSON.stringify(data),
    now(),
  );
}

export function createIssue(title: string, body: string): Issue {
  const db = getDb();
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO issues(title, body, status, created_at, updated_at)
       VALUES (?, ?, 'new', ?, ?)`,
    )
    .run(title, body, t, t);
  const id = info.lastInsertRowid as number;
  logEvent(id, 'created', { title });
  return getIssue(id);
}

export function getIssue(id: number): Issue {
  const db = getDb();
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Issue | undefined;
  if (!row) throw new Error(`issue ${id} not found`);
  return row;
}

export function findIssue(id: number): Issue | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Issue | undefined;
}

export function listIssues(filter?: { status?: IssueStatus }): Issue[] {
  const db = getDb();
  if (filter?.status) {
    return db
      .prepare('SELECT * FROM issues WHERE status = ? ORDER BY id')
      .all(filter.status) as Issue[];
  }
  return db.prepare('SELECT * FROM issues ORDER BY id').all() as Issue[];
}

export function setStatus(
  id: number,
  status: IssueStatus,
  patch: Partial<Issue> = {},
): void {
  const db = getDb();
  const cols: string[] = ['status = ?', 'updated_at = ?'];
  const vals: unknown[] = [status, now()];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE issues SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  logEvent(id, 'status_change', { status, ...patch });
}

export function updateIssue(id: number, patch: Partial<Issue>): void {
  const db = getDb();
  const cols: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now()];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE issues SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

export function incrementRound(id: number, column: 'plan_review_round' | 'code_review_round' | 'human_validation_round'): number {
  const db = getDb();
  const row = db
    .prepare(`UPDATE issues SET ${column} = ${column} + 1, updated_at = ? WHERE id = ? RETURNING ${column} AS r`)
    .get(now(), id) as { r: number };
  return row.r;
}

/** Zero one or more round counters for an issue. */
export function resetRoundCounters(
  id: number,
  columns: Array<'plan_review_round' | 'code_review_round' | 'human_validation_round'>,
): void {
  if (columns.length === 0) return;
  const db = getDb();
  const sets = columns.map((c) => `${c} = 0`).join(', ');
  db.prepare(`UPDATE issues SET ${sets}, updated_at = ? WHERE id = ?`).run(now(), id);
}

export interface ClaimedSlot {
  slot: number;
}

/**
 * Atomically claim a free slot for an issue. Idempotent: if this issue
 * already owns a slot, returns that slot without allocating a new one.
 * Returns null if all slots are full.
 *
 * Wrapped in a transaction so concurrent `claimSlot(<same id>)` calls can't
 * both pass the "already mine?" check and each grab a different free slot.
 */
export function claimSlot(issueId: number): ClaimedSlot | null {
  return withTransaction((db) => {
    const existing = db
      .prepare('SELECT slot FROM slots WHERE issue_id = ? LIMIT 1')
      .get(issueId) as { slot: number } | undefined;
    if (existing) return existing;
    const row = db
      .prepare(
        `UPDATE slots
           SET issue_id = ?, claimed_at = ?
         WHERE slot = (SELECT slot FROM slots WHERE issue_id IS NULL ORDER BY slot LIMIT 1)
         RETURNING slot`,
      )
      .get(issueId, now()) as { slot: number } | undefined;
    return row ?? null;
  });
}

export function releaseSlot(slot: number): void {
  const db = getDb();
  db.prepare('UPDATE slots SET issue_id = NULL, claimed_at = NULL WHERE slot = ?').run(slot);
}

export function listSlots(): Array<{ slot: number; issue_id: number | null }> {
  const db = getDb();
  return db
    .prepare('SELECT slot, issue_id FROM slots ORDER BY slot')
    .all() as Array<{ slot: number; issue_id: number | null }>;
}

export function getEvents(issueId: number, limit = 50): Array<{ kind: string; data: string | null; at: number }> {
  const db = getDb();
  return db
    .prepare('SELECT kind, data, at FROM events WHERE issue_id = ? ORDER BY at DESC LIMIT ?')
    .all(issueId, limit) as Array<{ kind: string; data: string | null; at: number }>;
}

/** Most recent event of a given kind, regardless of how far back it lives. */
export function findLatestEvent(
  issueId: number,
  kind: string,
): { kind: string; data: string | null; at: number } | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT kind, data, at FROM events WHERE issue_id = ? AND kind = ? ORDER BY at DESC LIMIT 1',
    )
    .get(issueId, kind) as { kind: string; data: string | null; at: number } | undefined;
}

export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const txn = db.transaction(fn);
  return txn(db);
}
