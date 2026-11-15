// action_item_exports (migration 011): approved action items an admin chose to create in an
// external tracker. Written only by services/externalTasks.js.
import { pool } from '../db/pool.js';

export const toExport = (row) => ({
  id: row.id,
  actionItemId: row.action_item_id,
  provider: row.provider,
  connectionId: row.connection_id,
  resourceId: row.resource_id,
  resourceName: row.resource_name ?? undefined,
  status: row.status,
  externalKey: row.external_key ?? null,
  externalUrl: row.external_url ?? null,
  externalRecordId: row.external_record_id ?? null,
  assigneeSet: row.assignee_set === null || row.assignee_set === undefined ? null : Boolean(row.assignee_set),
  lastError: row.last_error ?? null,
  requestedBy: row.requested_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `SELECT e.*, r.name AS resource_name FROM action_item_exports e JOIN integration_resources r ON r.id = e.resource_id`;

export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`${SELECT} WHERE e.id = ?${forUpdate ? ' FOR UPDATE OF e' : ''}`, [id]);
  return rows[0] ? toExport(rows[0]) : null;
}

export async function findForItem(conn, actionItemId, provider, { forUpdate = false } = {}) {
  const [rows] = await conn.query(`${SELECT} WHERE e.action_item_id = ? AND e.provider = ?${forUpdate ? ' FOR UPDATE OF e' : ''}`, [actionItemId, provider]);
  return rows[0] ? toExport(rows[0]) : null;
}

export async function listForMeeting(meetingId) {
  const [rows] = await pool.query(`${SELECT} JOIN action_items ai ON ai.id = e.action_item_id WHERE ai.meeting_id = ? ORDER BY e.id`, [meetingId]);
  return rows.map(toExport);
}

export async function listForItem(actionItemId) {
  const [rows] = await pool.query(`${SELECT} WHERE e.action_item_id = ? ORDER BY e.id`, [actionItemId]);
  return rows.map(toExport);
}

export async function create(conn, { actionItemId, provider, connectionId, resourceId, requestedBy }) {
  const [res] = await conn.execute(
    `INSERT INTO action_item_exports (action_item_id, provider, connection_id, resource_id, requested_by, status) VALUES (?, ?, ?, ?, ?, 'queued')`,
    [actionItemId, provider, connectionId, resourceId, requestedBy],
  );
  return res.insertId;
}

const COLUMNS = {
  status: 'status',
  connectionId: 'connection_id',
  resourceId: 'resource_id',
  externalKey: 'external_key',
  externalUrl: 'external_url',
  externalRecordId: 'external_record_id',
  assigneeSet: 'assignee_set',
  lastError: 'last_error',
  requestedBy: 'requested_by',
};

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([k, v]) => COLUMNS[k] && v !== undefined);
  if (!entries.length) return;
  await conn.execute(
    `UPDATE action_item_exports SET ${entries.map(([k]) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`,
    [...entries.map(([k, v]) => (k === 'lastError' && v ? String(v).slice(0, 500) : v)), id],
  );
}
