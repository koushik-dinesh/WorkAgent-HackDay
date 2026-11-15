// The nightly-job guard: claimed once per local day across workers, never before the hour.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { claimDaily } from '../src/services/featureSchedule.js';
import { closeDatabase, resetDatabase } from './helpers.js';

describe('claimDaily', () => {
  before(resetDatabase);
  after(closeDatabase);
  it('claims once per day, not before the hour, again the next day', async () => {
    const day1 = new Date('2026-11-16T03:00:00Z');
    assert.equal(await claimDaily('test.job', 4, day1), false, 'before the hour');
    const later = new Date('2026-11-16T05:00:00Z');
    assert.equal(await claimDaily('test.job', 4, later), true);
    assert.equal(await claimDaily('test.job', 4, later), false);
    assert.equal(await claimDaily('test.job', 4, new Date('2026-11-16T23:00:00Z')), false, 'same day, later tick');
    assert.equal(await claimDaily('test.job', 4, new Date('2026-11-17T05:00:00Z')), true, 'next day');
    await pool.query("DELETE FROM app_settings WHERE setting_key = 'daily:test.job'");
  });
});
