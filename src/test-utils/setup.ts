import { beforeEach } from 'vitest';
import { resetConfigForTests } from '../config.js';
import { closeDb } from '../db/index.js';

/**
 * Each test gets a fresh in-memory SQLite db and a clean config.
 * `:memory:` databases are per-connection: closing the singleton drops
 * everything, the next `getDb()` opens an empty one.
 */
beforeEach(() => {
  process.env.TIX_DB = ':memory:';
  // Point at a path that doesn't exist so getConfig() falls through to defaults.
  // /dev/null exists and reads as empty string — JSON.parse would crash on it.
  process.env.TIX_CONFIG = '/tmp/tix-test-nonexistent.json';
  resetConfigForTests();
  closeDb();
});
