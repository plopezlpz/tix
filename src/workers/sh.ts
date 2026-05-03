import { spawnSync } from 'node:child_process';

/**
 * Quote a string for safe inclusion in a single-quoted shell argument.
 * Standard POSIX trick: close-quote, escape any embedded `'`, re-open-quote.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit stdio (live to user's terminal). */
  inherit?: boolean;
  /** Don't throw on non-zero exit. */
  allowFail?: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command without invoking a shell (no injection risk). */
export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const result: RunResult = {
    status: r.status ?? -1,
    stdout: opts.inherit ? '' : r.stdout ?? '',
    stderr: opts.inherit ? '' : r.stderr ?? '',
  };
  if (!opts.allowFail && result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}
