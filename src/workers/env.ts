import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getConfig } from '../config.js';

export interface SlotEnv {
  TIX_SLOT: string;
  TIX_API_PORT: string;
  TIX_FRONTEND_PORT: string;
  TIX_DATABASE_URL: string;
  TIX_REDIS_DB: string;
  TIX_PG_DBNAME: string;
}

export function envForSlot(slot: number): SlotEnv {
  const cfg = getConfig();
  const apiPort = cfg.ports.api + slot * 10;
  const frontendPort = cfg.ports.frontend + slot * 10;
  const dbName = `${cfg.postgres.prefix}${slot}`;
  const databaseUrl = `postgresql://${cfg.postgres.user}@${cfg.postgres.host}:${cfg.postgres.port}/${dbName}`;
  const redisDb = String(cfg.redis.dbBase + slot);
  return {
    TIX_SLOT: String(slot),
    TIX_API_PORT: String(apiPort),
    TIX_FRONTEND_PORT: String(frontendPort),
    TIX_DATABASE_URL: databaseUrl,
    TIX_REDIS_DB: redisDb,
    TIX_PG_DBNAME: dbName,
  };
}

/**
 * Render the .env file for the worktree by substituting `${VAR}` placeholders
 * in the template with slot-derived values plus the passthrough environment.
 *
 * Idempotent: only writes when the destination is missing. Re-provision will
 * not clobber edits the user (or the agent) made to .env. Pass `force: true`
 * to re-render anyway.
 */
export function renderEnv(worktreePath: string, slot: number, opts: { force?: boolean } = {}): string {
  const cfg = getConfig();
  const templatePath = isAbsolute(cfg.envTemplate)
    ? cfg.envTemplate
    : join(cfg.repoPath, cfg.envTemplate);
  // envOutput is validated as relative at config-load time.
  const outPath = join(worktreePath, cfg.envOutput);

  if (existsSync(outPath) && !opts.force) return outPath;

  const slotEnv = envForSlot(slot);
  const subs: Record<string, string> = { ...slotEnv };

  // No template? Write the slot env directly so the worktree at least has the
  // basics, but let the caller know.
  let body: string;
  if (!existsSync(templatePath)) {
    body = Object.entries(subs)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    body = `# tix: no env template at ${templatePath}\n` + body;
  } else {
    const template = readFileSync(templatePath, 'utf8');
    body = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
      if (key in subs) return subs[key]!;
      const passthrough = process.env[key];
      if (passthrough != null) return passthrough;
      return '';
    });
    // Append slot-derived overrides at the end so they win over template defaults.
    const trailer = '\n# --- tix slot overrides ---\n' +
      Object.entries(subs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    body += trailer;
  }
  // 0o600: contains TIX_DATABASE_URL and any passthrough secrets from the
  // template; should never be world-readable.
  writeFileSync(outPath, body, { mode: 0o600 });
  return outPath;
}
