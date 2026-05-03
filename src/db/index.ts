import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, '../../schema.sql');

let cached: Database.Database | null = null;

export function getDb(): Database.Database {
  if (cached) return cached;
  const cfg = getConfig();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const fresh = !existsSync(cfg.dbPath);
  const db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (fresh) {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    seedSlots(db, cfg.slotCount);
  } else {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    syncSlots(db, cfg.slotCount);
  }
  cached = db;
  return db;
}

function seedSlots(db: Database.Database, count: number): void {
  const insert = db.prepare('INSERT OR IGNORE INTO slots(slot, issue_id) VALUES (?, NULL)');
  const txn = db.transaction((n: number) => {
    for (let i = 1; i <= n; i++) insert.run(i);
  });
  txn(count);
}

function syncSlots(db: Database.Database, count: number): void {
  const existing = db
    .prepare('SELECT slot, issue_id FROM slots ORDER BY slot')
    .all() as Array<{ slot: number; issue_id: number | null }>;
  const have = new Set(existing.map((r) => r.slot));

  // Refuse to shrink past an in-use slot. claimSlot would otherwise still
  // hand out the over-cap rows, lying about the configured concurrency.
  const overCap = existing.filter((r) => r.slot > count);
  const occupiedOverCap = overCap.filter((r) => r.issue_id != null);
  if (occupiedOverCap.length > 0) {
    const ids = occupiedOverCap.map((r) => `${r.slot}->#${r.issue_id}`).join(', ');
    throw new Error(
      `tix config: slotCount=${count} would orphan in-use slot(s) ${ids}. ` +
        `Release those issues first, then lower slotCount.`,
    );
  }

  const insert = db.prepare('INSERT OR IGNORE INTO slots(slot, issue_id) VALUES (?, NULL)');
  const drop = db.prepare('DELETE FROM slots WHERE slot = ?');
  const txn = db.transaction((n: number) => {
    for (let i = 1; i <= n; i++) if (!have.has(i)) insert.run(i);
    for (const r of overCap) drop.run(r.slot); // safe — all are free per the check above
  });
  txn(count);
}

export function closeDb(): void {
  cached?.close();
  cached = null;
}
