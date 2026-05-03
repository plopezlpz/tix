/**
 * `tix init` — scaffold the project's `.tix/` directory.
 *
 * Everything tix needs from a project lives under `<repoPath>/.tix/`:
 *
 * - `.tix/config.json` — project-shared overrides (slotCount, baseBranch,
 *   postgres template, etc.). User-level config still wins on conflict.
 * - `.tix/prompts/<state>.md` — project's prompt overrides; only the ones
 *   the project wants to customise need to exist. Missing files fall back
 *   to tix's baseline.
 * - `.tix/README.md` — explains the layout for new contributors.
 *
 * Generated artifacts (`current.md`, `plan.md`, `agent.log`, etc.) also live
 * under `.tix/` but are gitignored via the managed block in
 * `.git/info/exclude`.
 *
 * Removing tix from a project = `rm -rf .tix/` and the gitignore block.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { getConfig } from '../config.js';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prompts');

interface InitResult {
  created: string[];
  skipped: string[];
}

export function runInit(opts: { withPrompts?: boolean; force?: boolean } = {}): InitResult {
  const cfg = getConfig();
  const tixDir = join(cfg.repoPath, '.tix');
  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(tixDir, { recursive: true });

  writeIfMissing(join(tixDir, 'config.json'), CONFIG_TEMPLATE, opts.force ?? false, created, skipped);
  writeIfMissing(join(tixDir, 'README.md'), README_TEMPLATE, opts.force ?? false, created, skipped);

  if (opts.withPrompts) {
    const promptsDir = join(tixDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    for (const name of readdirSync(PROMPTS_DIR)) {
      if (!name.endsWith('.md')) continue;
      const src = join(PROMPTS_DIR, name);
      const dst = join(promptsDir, name);
      writeIfMissing(dst, readFileSync(src, 'utf8'), opts.force ?? false, created, skipped);
    }
  }

  return { created, skipped };
}

function writeIfMissing(
  path: string,
  content: string,
  force: boolean,
  created: string[],
  skipped: string[],
): void {
  if (!force && existsSync(path)) {
    skipped.push(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  created.push(path);
}

export function reportInit(result: InitResult): void {
  for (const p of result.created) console.log(`${pc.green('+')} ${p}`);
  for (const p of result.skipped) console.log(`${pc.dim(`= ${p} (exists; pass --force to overwrite)`)}`);
}

const CONFIG_TEMPLATE = `{
  "$comment": "Project-level tix config. Committed to the repo so the team shares it. User-level (~/.config/tix/config.json) overrides on conflict. See https://example.invalid/tix#config for fields.",
  "slotCount": 3,
  "baseBranch": "main",
  "remote": "origin"
}
`;

const README_TEMPLATE = `# .tix/

This directory holds everything **tix** (the multi-agent orchestrator) needs from this project.

## Tracked (committed)

- \`config.json\` — project-shared tix config (slotCount, baseBranch, etc.). User-level config overrides on conflict.
- \`prompts/<state>.md\` — project-specific prompt overrides. Only state files you want to override need to exist; the rest fall back to tix's baseline.
- \`README.md\` — this file.

## Generated (gitignored)

When an agent is running on an issue, tix writes these per-worktree:

- \`current.md\` — hot cache for the current agent (state, role, valid exits).
- \`plan.md\` — written by the planner.
- \`plan-critique.md\` — accumulated critique rounds.
- \`code-review.md\` — accumulated review rounds.
- \`validation/test-plan.md\` — written by the validator for human review.
- \`validation/test-results.md\` — written by the human.
- \`agent.log\` (and rotated \`agent.<timestamp>.log\`) — tee'd agent stream.

These are excluded via a managed block in \`.git/info/exclude\` (added by tix at provision time).

## Removing tix from this project

\`\`\`sh
rm -rf .tix/
# and remove the "--- tix orchestration artifacts (managed) ---" block from .git/info/exclude
\`\`\`
`;
