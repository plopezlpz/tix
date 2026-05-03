import { getConfig } from '../config.js';
import { run } from './sh.js';

function psqlArgs(extra: string[]): string[] {
  const cfg = getConfig();
  return [
    '-h', cfg.postgres.host,
    '-p', String(cfg.postgres.port),
    '-U', cfg.postgres.user,
    '-v', 'ON_ERROR_STOP=1',
    ...extra,
  ];
}

/** Create per-slot DB by cloning the template. */
export function createSlotDb(slot: number): string {
  const cfg = getConfig();
  const dbName = `${cfg.postgres.prefix}${slot}`;
  // Drop if exists (idempotent provisioning)
  dropSlotDb(slot, { ifExists: true });
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `CREATE DATABASE ${quoteIdent(dbName)} TEMPLATE ${quoteIdent(cfg.postgres.template)};`,
  ]));
  return dbName;
}

export function dropSlotDb(slot: number, opts: { ifExists?: boolean } = {}): void {
  const cfg = getConfig();
  const dbName = `${cfg.postgres.prefix}${slot}`;
  // Terminate active connections first.
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapeLit(dbName)}' AND pid <> pg_backend_pid();`,
  ]), { allowFail: true });
  const stmt = opts.ifExists
    ? `DROP DATABASE IF EXISTS ${quoteIdent(dbName)};`
    : `DROP DATABASE ${quoteIdent(dbName)};`;
  run('psql', psqlArgs(['-d', 'postgres', '-c', stmt]), { allowFail: opts.ifExists });
}

/** Refresh the template from the live dev DB. Call manually when stale. */
export function refreshTemplate(devDbName: string): void {
  const cfg = getConfig();
  const tmpl = cfg.postgres.template;
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapeLit(tmpl)}' AND pid <> pg_backend_pid();`,
  ]), { allowFail: true });
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `ALTER DATABASE ${quoteIdent(tmpl)} IS_TEMPLATE false;`,
  ]), { allowFail: true });
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `DROP DATABASE IF EXISTS ${quoteIdent(tmpl)};`,
  ]));
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `CREATE DATABASE ${quoteIdent(tmpl)} TEMPLATE ${quoteIdent(devDbName)};`,
  ]));
  run('psql', psqlArgs([
    '-d', 'postgres',
    '-c', `ALTER DATABASE ${quoteIdent(tmpl)} IS_TEMPLATE true;`,
  ]));
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function escapeLit(s: string): string {
  return s.replace(/'/g, "''");
}
