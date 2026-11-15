// Periodic work of features 2-6, driven by the existing worker loop (no second scheduler).
// Each entry only enqueues jobs; the jobs table (dedupe keys, retries with backoff, dead jobs,
// Operations page) does the rest. Daily entries are claimed once per day across all workers
// through app_settings, so several workers never run the same nightly job twice.
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import * as queue from '../jobs/queue.js';
import { wallClock } from './scheduling/calendars.js';
import * as digest from './digest/index.js';
import * as directory from './groups/directorySync.js';
import * as scheduling from './scheduling/index.js';
import { localDate as dateIn } from '../utils/dates.js';

const enqueueOnce = async (type, payload = {}) => {
  try {
    await queue.enqueue(type, payload, { dedupeKey: type });
    return 1;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return 0;
    throw err;
  }
};

/** True for exactly one caller per local day once `hour` has passed (atomic claim). */
export async function claimDaily(name, hour, now = new Date()) {
  const tz = config.features.orgTimeZone;
  if (Number(wallClock(now, tz).slice(11, 13)) < hour) return false;
  const today = dateIn(now, tz);
  const key = `daily:${name}`;
  // mysql2 reports found (not changed) rows, so INSERT ... ON DUPLICATE KEY UPDATE cannot tell
  // "claimed" from "already claimed". Insert first; otherwise move the date only if it is not today.
  try {
    await pool.execute("INSERT INTO app_settings (setting_key, value) VALUES (?, JSON_OBJECT('date', ?))", [key, today]);
    return true;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  const [r] = await pool.execute(
    "UPDATE app_settings SET value = JSON_OBJECT('date', ?) WHERE setting_key = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(value, '$.date')), '') <> ?",
    [today, key, today],
  );
  return r.changedRows > 0;
}

/** One tick (every few minutes). Returns what was queued. */
export async function tick(handlers, now = new Date()) {
  const out = {};
  const has = (t) => Boolean(handlers[t]);
  if (has('duplicates.scan')) out.duplicateScan = await enqueueOnce('duplicates.scan');
  // Action items from synced records, progress evidence, execution verification.
  if (has('actions.source_scan')) out.actionSources = await enqueueOnce('actions.source_scan');
  if (has('digest.generate')) out.digest = await digest.enqueueDue(now);
  if (has('meeting.attendees_refresh')) out.attendeeRefresh = await scheduling.enqueueDueRefreshes();
  if (has('directory.sync')) out.directory = await directory.enqueueDue(queue);
  if (has('duplicates.sweep') && (await claimDaily('duplicates.sweep', 2, now))) out.duplicateSweep = await enqueueOnce('duplicates.sweep');
  if (has('kpi.compute') && (await claimDaily('kpi.compute', 1, now))) out.kpi = await enqueueOnce('kpi.compute');
  return out;
}

