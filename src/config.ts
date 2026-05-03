import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PortBases {
  api: number;
  frontend: number;
}

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  template: string;
  prefix: string;
}

export interface RedisConfig {
  /** Slot N maps to redis logical DB (dbBase + N) */
  dbBase: number;
}

export interface Config {
  /** Path to the project repo that worktrees are cut from. Required — set in your config file. */
  repoPath: string;
  /** Branch worktrees are cut off. */
  baseBranch: string;
  /** Git remote name for fetch/push (default `origin`). */
  remote: string;
  /** Where per-issue worktrees live. */
  worktreesRoot: string;
  /** Per-issue branch prefix. Issue 47 => prefix + '47'. */
  branchPrefix: string;
  /** Per-issue worktree dir prefix. Issue 47 => `${worktreesRoot}/${worktreePrefix}47`. */
  worktreePrefix: string;
  /** Per-slot tmux session prefix. Slot 2 => `${tmuxSessionPrefix}2`. */
  tmuxSessionPrefix: string;
  /** How many concurrent slots. */
  slotCount: number;
  /** Slot N gets api port = ports.api + N*10, etc. */
  ports: PortBases;
  postgres: PostgresConfig;
  redis: RedisConfig;
  /** Command run inside the worktree's tmux session. */
  agentCommand: string;
  /** Path to .env template inside repoPath, relative or absolute. */
  envTemplate: string;
  /** Path to write rendered env file inside the worktree, relative to worktree root. */
  envOutput: string;
  /** Where the SQLite db lives. */
  dbPath: string;
}

const defaults: Config = {
  repoPath: process.cwd(),
  baseBranch: 'main',
  remote: 'origin',
  worktreesRoot: join(homedir(), 'tix-worktrees'),
  branchPrefix: 'agent/issue-',
  worktreePrefix: 'tix-issue-',
  tmuxSessionPrefix: 'tix-agent-',
  slotCount: 4,
  ports: { api: 3000, frontend: 5170 },
  postgres: {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    template: 'tix_template',
    prefix: 'tix_agent_',
  },
  redis: { dbBase: 0 },
  agentCommand: 'claude',
  envTemplate: '.env.template',
  envOutput: '.env',
  dbPath: join(homedir(), '.local/share/tix/tix.db'),
};

let cached: Config | null = null;

/**
 * Three-layer config: defaults < project < user. The user layer (at
 * `$TIX_CONFIG` or `~/.config/tix/config.json`) is the only one that can
 * set `repoPath` — everything else loads relative to it. Once `repoPath` is
 * known, `<repoPath>/.tix/config.json` is read as the project layer (lets
 * a team commit shared values like slotCount, postgres template, etc.).
 * User layer wins on conflict.
 */
export function getConfig(): Config {
  if (cached) return cached;
  const userPath = process.env.TIX_CONFIG ?? join(homedir(), '.config/tix/config.json');
  const userParsed = loadConfigFile(userPath);

  // Resolve repoPath using only defaults + user config, since the project
  // config lives inside repoPath.
  const tentative = mergeConfig(defaults, userParsed);
  const projectPath = join(tentative.repoPath, '.tix/config.json');
  const projectParsed = loadConfigFile(projectPath);

  let merged = mergeConfig(mergeConfig(defaults, projectParsed), userParsed);
  if (process.env.TIX_DB) merged.dbPath = process.env.TIX_DB;
  validateConfig(merged);
  cached = merged;
  return merged;
}

function loadConfigFile(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as Partial<Config>;
  } catch (err) {
    throw new Error(`failed to parse tix config at ${path}: ${(err as Error).message}`);
  }
}

function mergeConfig(base: Config, over: Partial<Config>): Config {
  return {
    ...base,
    ...over,
    ports: { ...base.ports, ...(over.ports ?? {}) },
    postgres: { ...base.postgres, ...(over.postgres ?? {}) },
    redis: { ...base.redis, ...(over.redis ?? {}) },
  };
}

function validateConfig(cfg: Config): void {
  // envOutput must be relative — every slot's worktree is a different
  // directory, so an absolute path means every slot writes the same file
  // and they race / leak each other's secrets.
  if (cfg.envOutput.startsWith('/')) {
    throw new Error(
      `tix config: envOutput must be a relative path (got '${cfg.envOutput}'). ` +
        `Each slot's worktree needs its own .env; an absolute path forces all slots to share one.`,
    );
  }
}

/**
 * Check that `repoPath` is a real git repo. Called from provision-time
 * paths only — read-only commands like `list`, `show`, `timeline` don't need
 * a configured repo. The default `repoPath = process.cwd()` is harmless if
 * the user is just inspecting issues.
 */
export function assertRepoPathIsGitRepo(): void {
  const cfg = getConfig();
  if (!existsSync(join(cfg.repoPath, '.git'))) {
    throw new Error(
      `tix config: repoPath '${cfg.repoPath}' is not a git repository. ` +
        `Set repoPath in $TIX_CONFIG (or ~/.config/tix/config.json) to your project's root.`,
    );
  }
}

export function resetConfigForTests(): void {
  cached = null;
}
