// Small helper for organisation settings stored as JSON in app_settings (one row per feature).
// Values are merged over code defaults, so a new option never needs a migration.
import { pool } from '../db/pool.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export async function readSetting(key, defaults = {}, conn = pool) {
  const [[row]] = await conn.query('SELECT value, updated_by, updated_at FROM app_settings WHERE setting_key = ?', [key]);
  return { ...defaults, ...(row ? parse(row.value) : {}) };
}

export async function writeSetting(key, value, actorId = null, conn = pool) {
  await conn.execute(
    'INSERT INTO app_settings (setting_key, value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)',
    [key, JSON.stringify(value), actorId],
  );
}
