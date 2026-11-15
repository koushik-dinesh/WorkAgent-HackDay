// meeting_transcript_imports (migration 011): which synced meeting records have had their
// transcript imported, are still waiting for one, have none, or failed. Written only by
// services/transcripts/importer.js.
import { pool } from '../db/pool.js';

export const toImport = (row) => ({
  recordId: row.record_id,
  status: row.status,
  attempts: row.attempts,
  meetingId: row.meeting_id ?? null,
  transcriptRef: row.transcript_ref ?? null,
  lastError: row.last_error ?? null,
  nextCheckAt: row.next_check_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function find(recordId, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT * FROM meeting_transcript_imports WHERE record_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [recordId]);
  return rows[0] ? toImport(rows[0]) : null;
}

const COLUMNS = { status: 'status', attempts: 'attempts', meetingId: 'meeting_id', transcriptRef: 'transcript_ref', lastError: 'last_error', nextCheckAt: 'next_check_at' };

/** Inserts or updates the row for a record. */
export async function save(conn, recordId, fields) {
  const entries = Object.entries(fields).filter(([k, v]) => COLUMNS[k] && v !== undefined);
  const cols = entries.map(([k]) => COLUMNS[k]);
  const values = entries.map(([k, v]) => (k === 'lastError' && v ? String(v).slice(0, 500) : v));
  await conn.query(
    `INSERT INTO meeting_transcript_imports (record_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?${cols.map(() => ', ?').join('')})
     ${cols.length ? `ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}` : 'ON DUPLICATE KEY UPDATE record_id = record_id'}`,
    [recordId, ...values],
  );
}

// Meeting end time from the record's metadata (ISO 8601 UTC written by the connectors).
const END_SQL = "CAST(REPLACE(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.end')), 'T', ' '), 'Z', '') AS DATETIME)";

/**
 * Synced meeting records whose transcript should be looked for now: of the given provider/record
 * types, from an enabled resource of an active connection, ended at least 5 minutes ago and within
 * the lookback window, not cancelled or deleted, and not finished (imported/none/failed).
 * @param kinds [{ provider, recordType }]
 */
export async function findDue({ kinds, lookbackDays, limit = 20 }, conn = pool) {
  if (!kinds.length) return [];
  const [rows] = await conn.query(
    `SELECT r.id FROM external_records r
     JOIN integration_resources res ON res.id = r.resource_id
     JOIN integration_connections c ON c.id = r.connection_id
     LEFT JOIN meeting_transcript_imports i ON i.record_id = r.id
     WHERE (${kinds.map(() => '(r.provider = ? AND r.record_type = ?)').join(' OR ')})
       AND res.is_enabled = TRUE AND res.access_status = 'accessible'
       AND c.status = 'active' AND c.is_enabled = TRUE
       AND r.source_deleted_at IS NULL
       AND COALESCE(JSON_EXTRACT(r.metadata, '$.cancelled'), FALSE) = FALSE
       AND JSON_TYPE(JSON_EXTRACT(r.metadata, '$.end')) = 'STRING'
       AND ${END_SQL} <= UTC_TIMESTAMP() - INTERVAL 5 MINUTE
       AND ${END_SQL} >= UTC_TIMESTAMP() - INTERVAL ? DAY
       AND (i.record_id IS NULL OR (i.status = 'waiting' AND (i.next_check_at IS NULL OR i.next_check_at <= UTC_TIMESTAMP())))
     ORDER BY r.id
     LIMIT ?`,
    [...kinds.flatMap((k) => [k.provider, k.recordType]), lookbackDays, limit],
  );
  return rows.map((r) => r.id);
}

/** Import states of the given records (for the meeting/record pages). */
export async function listForRecords(recordIds, conn = pool) {
  if (!recordIds.length) return [];
  const [rows] = await conn.query('SELECT * FROM meeting_transcript_imports WHERE record_id IN (?)', [recordIds]);
  return rows.map(toImport);
}
