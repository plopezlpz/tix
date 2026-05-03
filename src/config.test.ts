import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from './config.js';

let configDir: string;
let configPath: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tix-cfg-'));
  configPath = join(configDir, 'tix.json');
  process.env.TIX_CONFIG = configPath;
  resetConfigForTests();
});

afterEach(() => {
  delete process.env.TIX_CONFIG;
  resetConfigForTests();
});

describe('config loading', () => {
  it('falls through to defaults when the config file does not exist', () => {
    process.env.TIX_CONFIG = join(configDir, 'missing.json');
    const cfg = getConfig();
    expect(cfg.baseBranch).toBe('main');
    expect(cfg.remote).toBe('origin');
  });

  it('falls through to defaults when the config file is empty', () => {
    writeFileSync(configPath, '');
    expect(() => getConfig()).not.toThrow();
  });

  it('throws a clear error on malformed JSON', () => {
    writeFileSync(configPath, '{ not valid json');
    expect(() => getConfig()).toThrow(/failed to parse tix config/);
  });
});

describe('config validation', () => {
  it('rejects an absolute envOutput — every slot would race on the same file', () => {
    writeFileSync(configPath, JSON.stringify({ envOutput: '/etc/dac.env' }));
    expect(() => getConfig()).toThrow(/envOutput must be a relative path/);
  });

  it('accepts a relative envOutput', () => {
    writeFileSync(configPath, JSON.stringify({ envOutput: '.env.local' }));
    expect(getConfig().envOutput).toBe('.env.local');
  });
});
