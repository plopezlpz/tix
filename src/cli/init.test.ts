import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from '../config.js';
import { runInit } from './init.js';

let projectDir: string;
let userCfgPath: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tix-init-'));
  // Pretend the project is a real git repo so any provision-side validation
  // would pass — though `tix init` itself doesn't require it.
  mkdirSync(join(projectDir, '.git'));

  userCfgPath = join(projectDir, 'user-config.json');
  writeFileSync(userCfgPath, JSON.stringify({ repoPath: projectDir }));
  process.env.TIX_CONFIG = userCfgPath;
  resetConfigForTests();
});

afterEach(() => {
  delete process.env.TIX_CONFIG;
  resetConfigForTests();
});

describe('tix init', () => {
  it('creates .tix/config.json and .tix/README.md inside the project', () => {
    const { created } = runInit();
    expect(existsSync(join(projectDir, '.tix/config.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.tix/README.md'))).toBe(true);
    expect(created.length).toBe(2);
  });

  it('skips existing files unless --force', () => {
    runInit();
    const before = readFileSync(join(projectDir, '.tix/config.json'), 'utf8');
    writeFileSync(join(projectDir, '.tix/config.json'), '{"slotCount":99}');
    runInit();
    const after = readFileSync(join(projectDir, '.tix/config.json'), 'utf8');
    expect(after).toBe('{"slotCount":99}');
    expect(after).not.toBe(before);
  });

  it('--force overwrites', () => {
    runInit();
    writeFileSync(join(projectDir, '.tix/config.json'), '{"slotCount":99}');
    runInit({ force: true });
    expect(readFileSync(join(projectDir, '.tix/config.json'), 'utf8')).not.toBe('{"slotCount":99}');
  });

  it('--with-prompts copies tix baseline prompts into .tix/prompts/', () => {
    runInit({ withPrompts: true });
    expect(existsSync(join(projectDir, '.tix/prompts/plan.md'))).toBe(true);
    expect(existsSync(join(projectDir, '.tix/prompts/code.md'))).toBe(true);
    // Should be the actual baseline content, not a placeholder.
    const plan = readFileSync(join(projectDir, '.tix/prompts/plan.md'), 'utf8');
    expect(plan).toMatch(/Role: planner/);
  });
});

describe('project config layer', () => {
  it('values from <repo>/.tix/config.json are picked up', () => {
    runInit();
    writeFileSync(
      join(projectDir, '.tix/config.json'),
      JSON.stringify({ slotCount: 7, baseBranch: 'develop' }),
    );
    resetConfigForTests();
    const cfg = getConfig();
    expect(cfg.slotCount).toBe(7);
    expect(cfg.baseBranch).toBe('develop');
  });

  it('user config overrides project config on conflict', () => {
    runInit();
    writeFileSync(
      join(projectDir, '.tix/config.json'),
      JSON.stringify({ slotCount: 7 }),
    );
    writeFileSync(userCfgPath, JSON.stringify({ repoPath: projectDir, slotCount: 2 }));
    resetConfigForTests();
    expect(getConfig().slotCount).toBe(2);
  });
});
