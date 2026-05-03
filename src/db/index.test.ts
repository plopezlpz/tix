/**
 * syncSlots behaviour: grow silently, refuse to shrink past in-use slots,
 * shrink past free ones.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../config.js';
import { givenIssue } from '../test-utils/given.js';
import { closeDb, getDb } from './index.js';
import { listSlots } from './queries.js';

let dir: string;

beforeEach(() => {
  // Override the global :memory: setup with a real file so close/reopen
  // sequences in these tests preserve state.
  dir = mkdtempSync(join(tmpdir(), 'tix-syncslots-'));
  process.env.TIX_DB = join(dir, 'tix.db');
});

afterEach(() => {
  closeDb();
});

function reopenDbWithSlotCount(n: number): void {
  closeDb();
  resetConfigForTests();
  const cfgPath = join(dir, `cfg-${n}.json`);
  writeFileSync(cfgPath, JSON.stringify({ slotCount: n }));
  process.env.TIX_CONFIG = cfgPath;
  getDb(); // triggers seed / sync
}

describe('syncSlots', () => {
  it('grows when slotCount increases', () => {
    reopenDbWithSlotCount(2);
    expect(listSlots().map((s) => s.slot)).toEqual([1, 2]);
    reopenDbWithSlotCount(5);
    expect(listSlots().map((s) => s.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it('shrinks freely past unoccupied slots', () => {
    reopenDbWithSlotCount(5);
    reopenDbWithSlotCount(3);
    expect(listSlots().map((s) => s.slot)).toEqual([1, 2, 3]);
  });

  it('refuses to shrink past an in-use slot — would silently orphan running issues', () => {
    reopenDbWithSlotCount(5);
    const { id } = givenIssue();
    getDb().prepare('UPDATE slots SET issue_id = ? WHERE slot = 4').run(id);
    expect(() => reopenDbWithSlotCount(2)).toThrow(/slotCount=2 would orphan in-use slot/);
  });
});
