import { getConfig } from '../config.js';
import { run } from './sh.js';

/**
 * Tmux session name for an issue. Per-issue (not per-slot) so a release-then-
 * claim sequence within a few seconds — where a stale detached respawn is
 * still pending — can never deliver keystrokes to the next issue's session.
 */
export function sessionName(issueId: number): string {
  return `${getConfig().tmuxSessionPrefix}${issueId}`;
}

export function hasSession(name: string): boolean {
  const r = run('tmux', ['has-session', '-t', name], { allowFail: true });
  return r.status === 0;
}

/** Create a detached session with the given starting cwd. No-op if already exists. */
export function ensureSession(name: string, cwd: string): void {
  if (hasSession(name)) return;
  run('tmux', ['new-session', '-d', '-s', name, '-c', cwd]);
}

/** Type a command into the session and press Enter.
 *
 * Uses two `send-keys` invocations: `-l` (literal mode) for the command so
 * tmux doesn't try to interpret any substring as a named key, then a second
 * call to send the Enter keypress. Combining text + `Enter` in one call has
 * been observed to occasionally swallow the Enter when the command is long.
 */
export function sendCommand(name: string, command: string): void {
  run('tmux', ['send-keys', '-t', `${name}:0`, '-l', command]);
  run('tmux', ['send-keys', '-t', `${name}:0`, 'Enter']);
}

/** Send raw keys without Enter (e.g. control sequences). */
export function sendKeys(name: string, ...keys: string[]): void {
  run('tmux', ['send-keys', '-t', `${name}:0`, ...keys]);
}

/** Capture the current pane buffer (visible + history). */
export function capturePane(name: string, lines = 200): string {
  const r = run('tmux', [
    'capture-pane',
    '-t', `${name}:0`,
    '-p',
    '-S', `-${lines}`,
  ], { allowFail: true });
  return r.stdout;
}

export function killSession(name: string): void {
  if (hasSession(name)) {
    run('tmux', ['kill-session', '-t', name], { allowFail: true });
  }
}

/**
 * Switch the user's tmux client to the given session, or attach if not
 * already inside tmux. Returns the command line so the caller can shell out
 * with stdio: 'inherit' rather than calling here.
 */
export function attachCommand(name: string): { cmd: string; args: string[] } {
  const inside = !!process.env.TMUX;
  if (inside) {
    return { cmd: 'tmux', args: ['switch-client', '-t', name] };
  }
  return { cmd: 'tmux', args: ['attach-session', '-t', name] };
}
