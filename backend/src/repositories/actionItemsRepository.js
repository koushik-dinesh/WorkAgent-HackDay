import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

export const toActionItem = (row) => ({
  id: row.id,
  meetingId: row.meeting_id,
  // Project association (Phase 2). Defaults to the meeting's project; independent of review/task status.
  projectId: row.project_id ?? null,
  project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
  extractionRunId: row.extraction_run_id,
  // AI items come from an extraction run; manual items have none (and no AI confidence/evidence).
  // Items analysed from Teams/Jira/GitHub/Figma/Outlook have no run but are AI-derived too.
  source: row.extraction_run_id || (row.source_type && !['meeting', 'manual', 'assistant'].includes(row.source_type) && row.ai_confidence !== null) ? 'ai' : 'manual',
  // Where the commitment was found: meeting | teams_message | jira_comment | github | figma_comment | outlook_email | manual | assistant
  sourceType: row.source_type ?? 'meeting',
  sourceRecordId: row.source_record_id ?? null,
  category: row.category ?? null,
  teamId: row.team_id ?? null,
  departmentId: row.department_id ?? null,
  assigneeKind: row.assignee_kind ?? (row.assignee_user_id ? 'explicit' : 'unassigned'),
  assigneeTeam: row.assignee_team_id ? { id: row.assignee_team_id, name: row.assignee_team_name ?? null } : null,
  deadlineStatus: row.deadline_status ?? (row.due_date ? 'resolved' : row.due_date_raw ? 'needs_clarification' : 'none'),
  dueTimezone: row.due_timezone ?? null,
  executionStatus: row.execution_status ?? 'none',
  createdBy: row.created_by ?? null,
  title: row.title,
  description: row.description,
  assigneeNameRaw: row.assignee_name_raw,
  assignee: row.assignee_user_id
    ? { id: row.assignee_user_id, fullName: row.assignee_full_name, email: row.assignee_email, isActive: Boolean(row.assignee_is_active) }
    : null,
  assigneeMatch: row.assignee_match,
  dueDate: row.due_date,
  dueDateRaw: row.due_date_raw,
  priority: row.priority,
  reviewStatus: row.review_status,
  taskStatus: row.task_status,
  flags: parseJson(row.flags) ?? [],
  reviewDetails: parseJson(row.review_details),
  aiConfidence: toNumber(row.ai_confidence),
  approvedAt: row.approved_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toEvidence = (row) => ({
  id: row.id,
  excerpt: row.excerpt,
  speaker: row.speaker,
  startSec: toNumber(row.start_sec),
  segmentId: row.segment_id,
  // Evidence from a synced record (Teams message, Jira/GitHub/Figma comment, e-mail).
  recordId: row.record_id ?? null,
  sourceUrl: row.source_url ?? null,
  occurredAt: row.occurred_at ?? null,
  relation: row.relation ?? 'origin',
});

// DATE_FORMAT keeps due_date a plain calendar date (no timezone shifting).
const ITEM_SELECT = `
  SELECT ai.*, DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date,
         u.full_name AS assignee_full_name, u.email AS assignee_email, u.is_active AS assignee_is_active,
         p.name AS project_name, tm.name AS assignee_team_name
  FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id LEFT JOIN projects p ON p.id = ai.project_id
       LEFT JOIN teams tm ON tm.id = ai.assignee_team_id`;

async function withEvidence(rows, conn = pool) {
  if (rows.length === 0) return [];
  const [evidence] = await conn.query(
    'SELECT * FROM action_item_evidence WHERE action_item_id IN (?) ORDER BY start_sec IS NULL, start_sec, id',
    [rows.map((r) => r.id)],
  );
  const byItem = Map.groupBy(evidence, (e) => e.action_item_id);
  return rows.map((r) => ({ ...toActionItem(r), evidence: (byItem.get(r.id) ?? []).map(toEvidence) }));
}

export async function listForMeeting(meetingId) {
  const [rows] = await pool.execute(`${ITEM_SELECT} WHERE ai.meeting_id = ? ORDER BY ai.id`, [meetingId]);
  return withEvidence(rows);
}

/** One item in API shape, or null. With `conn` + forUpdate, locks the item row. */
export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`${ITEM_SELECT} WHERE ai.id = ?${forUpdate ? ' FOR UPDATE OF ai' : ''}`, [id]);
  return (await withEvidence(rows, conn))[0] ?? null;
}

/** Pending items of a meeting, locked, in API shape. */
export async function listPendingForUpdate(conn, meetingId) {
  const [rows] = await conn.query(`${ITEM_SELECT} WHERE ai.meeting_id = ? AND ai.review_status = 'pending' ORDER BY ai.id FOR UPDATE OF ai`, [meetingId]);
  return withEvidence(rows, conn);
}

const EDITABLE = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assigneeUserId: 'assignee_user_id',
  assigneeMatch: 'assignee_match',
  dueDate: 'due_date',
  flags: 'flags',
  reviewDetails: 'review_details',
  // Action intelligence (018)
  category: 'category',
  assigneeKind: 'assignee_kind',
  assigneeTeamId: 'assignee_team_id',
  teamId: 'team_id',
  deadlineStatus: 'deadline_status',
  dueTimezone: 'due_timezone',
};
const JSON_COLUMNS = new Set(['flags', 'reviewDetails']);

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => EDITABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${EDITABLE[key]} = ?`).join(', ');
  const values = entries.map(([key, v]) => (JSON_COLUMNS.has(key) ? JSON.stringify(v) : v));
  await conn.execute(`UPDATE action_items SET ${sets} WHERE id = ?`, [...values, id]);
}

/** approved: records approver; pending/rejected: clears it. */
export async function setReviewStatus(conn, id, status, { actorId, reviewDetails }) {
  await conn.execute(
    `UPDATE action_items SET review_status = ?, approved_by = ?, approved_at = IF(? = 'approved', NOW(), NULL),
            review_details = ?
     WHERE id = ?`,
    [status, status === 'approved' ? actorId : null, status, JSON.stringify(reviewDetails ?? null), id],
  );
}

/** Manual item: no extraction run, no AI confidence, no evidence. Project defaults to the meeting's. */
export async function createManual(conn, meetingId, { title, description, priority, assigneeUserId, dueDate, projectId, actorId }) {
  const [result] = await conn.execute(
    `INSERT INTO action_items
       (meeting_id, project_id, extraction_run_id, title, description, assignee_user_id, assignee_match, due_date, priority, flags, review_details)
     VALUES (?, COALESCE(?, (SELECT project_id FROM meetings WHERE id = ?)), NULL, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [
      meetingId, projectId ?? null, meetingId, title, description ?? null, assigneeUserId ?? null, assigneeUserId ? 'manual' : 'none', dueDate ?? null,
      priority ?? 'medium', JSON.stringify({ source: 'manual', createdBy: actorId }),
    ],
  );
  return result.insertId;
}

/** Items an admin already decided on; new extractions must not duplicate them. */
export async function listReviewed(meetingId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT id, title, assignee_user_id, assignee_name_raw FROM action_items
     WHERE meeting_id = ? AND review_status <> 'pending'`,
    [meetingId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, assigneeUserId: r.assignee_user_id, assigneeNameRaw: r.assignee_name_raw }));
}

/**
 * Replaces the meeting's AI-generated pending items with a new set (PLANNING.md: re-extraction
 * "replaces pending items only"). Approved/rejected items and manually added items are kept.
 */
export async function replacePendingExtracted(conn, meetingId, runId, items) {
  const [deleted] = await conn.execute(
    "DELETE FROM action_items WHERE meeting_id = ? AND review_status = 'pending' AND extraction_run_id IS NOT NULL",
    [meetingId],
  );
  for (const item of items) {
    const [result] = await conn.execute(
      // Extracted items take the meeting's project (never an AI guess); NULL when it has none.
      `INSERT INTO action_items
         (meeting_id, project_id, extraction_run_id, title, description, category, assignee_name_raw, assignee_user_id, assignee_match,
          assignee_kind, assignee_team_id, due_date, due_date_raw, deadline_status, due_timezone, priority, flags, review_details,
          ai_confidence, fingerprint)
       VALUES (?, (SELECT project_id FROM meetings WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meetingId, meetingId, runId, item.title, item.description, item.category ?? null, item.assigneeNameRaw, item.assigneeUserId, item.assigneeMatch,
        item.assigneeKind ?? (item.assigneeUserId ? 'explicit' : 'unassigned'), item.assigneeTeamId ?? null, item.dueDate, item.dueDateRaw,
        item.deadlineStatus ?? (item.dueDate ? 'resolved' : item.dueDateRaw ? 'needs_clarification' : 'none'), item.dueTimezone ?? null,
        item.priority, JSON.stringify(item.flags), JSON.stringify(item.reviewDetails), item.aiConfidence, item.fingerprint ?? null,
      ],
    );
    if (item.evidence.length) {
      await conn.query('INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec, segment_id) VALUES ?', [
        item.evidence.map((e) => [result.insertId, e.excerpt, e.speaker, e.startSec, e.segmentId]),
      ]);
    }
  }
  return { deleted: deleted.affectedRows, inserted: items.length };
}

export async function setProject(conn, id, projectId) {
  await conn.execute('UPDATE action_items SET project_id = ? WHERE id = ?', [projectId, id]);
}

// ---- items from other sources (services/actions/sourceExtraction.js) -------------------------------

/**
 * An AI item found in a synced record (no meeting). Pending review like meeting items.
 * evidence: [{ excerpt, speaker, recordId, sourceUrl, occurredAt, relation }]
 */
export async function createFromSource(conn, item, { sourceType, sourceRecordId, projectId = null, teamId = null }) {
  const [result] = await conn.execute(
    `INSERT INTO action_items
       (meeting_id, project_id, team_id, department_id, extraction_run_id, source_type, source_record_id, title, description, category,
        assignee_name_raw, assignee_user_id, assignee_match, assignee_kind, assignee_team_id, due_date, due_date_raw, deadline_status,
        due_timezone, priority, flags, review_details, ai_confidence, fingerprint)
     VALUES (NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId, teamId, item.departmentId ?? null, sourceType, sourceRecordId, item.title, item.description, item.category ?? null,
      item.assigneeNameRaw, item.assigneeUserId, item.assigneeMatch, item.assigneeKind ?? 'unassigned', item.assigneeTeamId ?? null,
      item.dueDate, item.dueDateRaw, item.deadlineStatus ?? 'none', item.dueTimezone ?? null, item.priority, JSON.stringify(item.flags),
      JSON.stringify(item.reviewDetails), item.aiConfidence, item.fingerprint ?? null,
    ],
  );
  await addEvidence(conn, result.insertId, item.evidence);
  return result.insertId;
}

/** Adds evidence rows, skipping ones already recorded for the same record/segment and excerpt. */
export async function addEvidence(conn, itemId, evidence) {
  let added = 0;
  for (const e of evidence ?? []) {
    const [[dup]] = await conn.query(
      'SELECT id FROM action_item_evidence WHERE action_item_id = ? AND ((record_id IS NOT NULL AND record_id = ?) OR (segment_id IS NOT NULL AND segment_id = ?)) AND relation = ? LIMIT 1',
      [itemId, e.recordId ?? null, e.segmentId ?? null, e.relation ?? 'origin'],
    );
    if (dup) continue;
    await conn.execute(
      'INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec, segment_id, record_id, source_url, occurred_at, relation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [itemId, String(e.excerpt).slice(0, 2000), e.speaker ?? null, e.startSec ?? null, e.segmentId ?? null, e.recordId ?? null, e.sourceUrl ?? null, e.occurredAt ?? null, e.relation ?? 'origin'],
    );
    added++;
  }
  return added;
}

/** Open (not rejected, not done) items with this fingerprint, newest first. */
export async function findOpenByFingerprint(conn, fp) {
  const [rows] = await conn.query("SELECT id, title, assignee_user_id, review_status, flags FROM action_items WHERE fingerprint = ? AND review_status <> 'rejected' AND task_status <> 'done' ORDER BY id DESC LIMIT 5", [fp]);
  return rows;
}

/** Open items of the same owner from the last `days` days (for near-duplicate checks). */
export async function listRecentOpenForOwner(conn, { assigneeUserId, assigneeTeamId, days = 30 }) {
  if (!assigneeUserId && !assigneeTeamId) return [];
  const [rows] = await conn.query(
    `SELECT id, title, assignee_user_id, review_status, flags FROM action_items
      WHERE ${assigneeUserId ? 'assignee_user_id = ?' : 'assignee_team_id = ?'} AND review_status <> 'rejected' AND task_status <> 'done'
        AND created_at >= NOW() - INTERVAL ? DAY ORDER BY id DESC LIMIT 200`,
    [assigneeUserId ?? assigneeTeamId, days],
  );
  return rows;
}

export async function setFlags(conn, id, flags) {
  await conn.execute('UPDATE action_items SET flags = ? WHERE id = ?', [JSON.stringify([...new Set(flags)]), id]);
}

export async function setExecutionStatus(conn, id, status) {
  await conn.execute('UPDATE action_items SET execution_status = ? WHERE id = ?', [status, id]);
}
