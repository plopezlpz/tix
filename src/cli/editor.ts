import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../workers/sh.js';

/** Open $EDITOR (or vi) on the given content; return the edited content. */
export function editInEditor(initial: string, suffix = '.md'): string {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const dir = mkdtempSync(join(tmpdir(), 'tix-'));
  const path = join(dir, `edit${suffix}`);
  try {
    writeFileSync(path, initial);
    // editor may be like "code -w" — split on whitespace.
    const [cmd, ...args] = editor.split(/\s+/);
    if (!cmd) throw new Error('empty $EDITOR');
    run(cmd, [...args, path], { inherit: true });
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEMPLATE = `# Title goes on the first line, body below.
#
# Lines starting with # are stripped on save.
# Save and exit to create the issue. Quit without saving (or leave empty) to abort.

`;

export function newIssueViaEditor(): { title: string; body: string } | null {
  const raw = editInEditor(TEMPLATE);
  const lines = raw.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  // First non-blank line is title, the rest is body.
  const firstNonBlank = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonBlank === -1) return null;
  const title = lines[firstNonBlank]!.trim();
  if (!title) return null;
  const body = lines.slice(firstNonBlank + 1).join('\n').trim();
  return { title, body };
}
