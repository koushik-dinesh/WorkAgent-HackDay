// Action Center: every action item from every source in one place, scoped to what each person may
// see, with the complete evidence trail behind each item and the same review rules as the meeting
// review screen (services/review.js).
//
// Visibility (mirrors records/access.js and extends it to teams):
//   admins                 everything
//   project owners         every item of their projects (incl. pending review)
//   team leads             approved items assigned to members of the teams they lead, or to the team
//   everyone               their own approved items (meeting items once the meeting's review is done)
// Review (edit, approve, reject, reopen): admins, and managers who own the item's project.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as actionItems from '../../repositories/actionItemsRepository.js';
import * as users from '../../repositories/usersRepository.js';
import { localDate, addDays } from '../../utils/dates.js';
import { AppError, badRequest, notFound } from '../../utils/errors.js';
import { config } from '../../config/index.js';
import { recordAudit } from '../audit.js';
import { FLAGS } from '../ai/validator.js';
import { accessScope, canManageProjectId } from '../records/access.js';
import { REVIEWABLE_MEETING_STATUSES, ReviewRuleError, applyEdit, approvalProblems, transition } from '../review.js';
import { VISIBLE_MEETING_STATUSES } from '../tasks.js';
import { CATEGORY_LABELS } from './intelligence.js';
import { linkedWork, workStatus } from './progress.js';

export const VIEWS = ['all', 'mine', 'team', 'review', 'overdue', 'upcoming', 'blocked', 'completed', 'unassigned', 'awaiting_execution'];
export const SOURCE_TYPES = ['meeting', 'teams_message', 'jira_comment', 'github_comment', 'figma_comment', 'outlook_email', 'manual', 'assistant'];
export const SOURCE_LABELS = {
  meeting: 'Meeting transcript',
  teams_message: 'Microsoft Teams',
  jira_comment: 'Jira',
  github_comment: 'GitHub',
  figma_comment: 'Figma',
  outlook_email: 'Outlook',
  manual: 'Added manually',
  assistant: 'Assistant',
};

const today = () => localDate(new Date(), config.features.orgTimeZone);

/** Lifecycle shown in the UI: extracted, needs_review, approved, scheduled, executing, completed, failed, retry_required, rejected. */
export function lifecycleOf(item) {
  if (item.reviewStatus === 'rejected') return 'rejected';
  if (item.reviewStatus === 'pending') return approvalProblems(item).length ? 'needs_review' : 'extracted';
  if (item.taskStatus === 'done') return 'completed';
  if (item.executionStatus === 'executing') return 'executing';
  if (item.executionStatus === 'retry_required') return 'retry_required';
  if (item.executionStatus === 'failed') return 'failed';
  if (['awaiting_approval', 'scheduled'].includes(item.executionStatus)) return 'scheduled';
  return 'approved';
}

async function teamContext(userId) {
  const [led] = await pool.query('SELECT id FROM teams WHERE lead_user_id = ?', [userId]);
  const [mine] = await pool.query('SELECT team_id AS id FROM team_members WHERE user_id = ?', [userId]);
  const ledIds = led.map((r) => r.id);
  const [ledMembers] = ledIds.length ? await pool.query('SELECT DISTINCT user_id FROM team_members WHERE team_id IN (?)', [ledIds]) : [[]];
  const myTeamIds = [...new Set([...mine.map((r) => r.id), ...ledIds])];
  const [teammates] = myTeamIds.length ? await pool.query('SELECT DISTINCT user_id FROM team_members WHERE team_id IN (?)', [myTeamIds]) : [[]];
  return { ledIds, ledMemberIds: ledMembers.map((r) => r.user_id), myTeamIds, teammateIds: teammates.map((r) => r.user_id) };
}

/** WHERE fragment for what `scope` may see (alias ai = action_items, m = meetings LEFT JOINed). */
function visibilitySql(scope, teams) {
  if (scope.admin) return { sql: 'TRUE', params: [] };
  const parts = ["(ai.assignee_user_id = ? AND ai.review_status = 'approved' AND (ai.meeting_id IS NULL OR m.status IN (?)))"];
  const params = [scope.user.id, VISIBLE_MEETING_STATUSES];
  if (scope.managed.length) {
    parts.push('ai.project_id IN (?)');
    params.push(scope.managed);
  }
  if (teams.ledIds.length) {
    parts.push("(ai.review_status = 'approved' AND (ai.meeting_id IS NULL OR m.status IN (?)) AND (ai.assignee_team_id IN (?)" + (teams.ledMemberIds.length ? ' OR ai.assignee_user_id IN (?)' : '') + '))');
    params.push(VISIBLE_MEETING_STATUSES, teams.ledIds, ...(teams.ledMemberIds.length ? [teams.ledMemberIds] : []));
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

function viewSql(view, user, teams) {
  const d = today();
  switch (view) {
    case 'mine':
      return { sql: 'ai.assignee_user_id = ?', params: [user.id] };
    case 'team':
      if (!teams.myTeamIds.length) return { sql: 'FALSE', params: [] };
      return { sql: `(ai.assignee_team_id IN (?)${teams.teammateIds.length ? ' OR ai.assignee_user_id IN (?)' : ''})`, params: [teams.myTeamIds, ...(teams.teammateIds.length ? [teams.teammateIds] : [])] };
    case 'review':
      return { sql: "ai.review_status = 'pending'", params: [] };
    case 'overdue':
      return { sql: "ai.review_status = 'approved' AND ai.task_status <> 'done' AND ai.due_date < ?", params: [d] };
    case 'upcoming':
      return { sql: "ai.review_status = 'approved' AND ai.task_status <> 'done' AND ai.due_date BETWEEN ? AND ?", params: [d, addDays(d, 7)] };
    case 'blocked':
      return { sql: "ai.review_status <> 'rejected' AND ai.task_status <> 'done' AND (ai.task_status = 'blocked' OR JSON_CONTAINS(COALESCE(ai.flags, JSON_ARRAY()), '\"blocker_reported\"'))", params: [] };
    case 'completed':
      return { sql: "ai.task_status = 'done' AND ai.review_status = 'approved'", params: [] };
    case 'unassigned':
      return { sql: "ai.assignee_user_id IS NULL AND ai.review_status <> 'rejected'", params: [] };
    case 'awaiting_execution':
      return { sql: "ai.execution_status IN ('awaiting_approval','scheduled','executing','failed','retry_required')", params: [] };
    default:
      return { sql: 'TRUE', params: [] };
  }
}

const SELECT = `
  SELECT ai.*, DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date,
         u.full_name AS assignee_full_name, u.email AS assignee_email, u.is_active AS assignee_is_active,
         p.name AS project_name, tm.name AS assignee_team_name,
         m.title AS meeting_title, m.status AS meeting_status, m.scheduled_at AS meeting_scheduled_at,
         er.provider AS source_provider, er.record_type AS source_record_type, er.title AS source_title, er.url AS source_url, er.external_key AS source_key
  FROM action_items ai
  LEFT JOIN meetings m ON m.id = ai.meeting_id
  LEFT JOIN users u ON u.id = ai.assignee_user_id
  LEFT JOIN projects p ON p.id = ai.project_id
  LEFT JOIN teams tm ON tm.id = ai.assignee_team_id
  LEFT JOIN external_records er ON er.id = ai.source_record_id`;

function toListItem(row) {
  const item = actionItems.toActionItem(row);
  const flags = item.flags ?? [];
  return {
    ...item,
    evidence: undefined,
    categoryLabel: item.category ? CATEGORY_LABELS[item.category] : null,
    sourceLabel: SOURCE_LABELS[item.sourceType] ?? item.sourceType,
    meeting: row.meeting_id ? { id: row.meeting_id, title: row.meeting_title, status: row.meeting_status, scheduledAt: row.meeting_scheduled_at } : null,
    sourceRecord: row.source_record_id ? { id: row.source_record_id, provider: row.source_provider, recordType: row.source_record_type, title: row.source_title, url: row.source_url, key: row.source_key } : null,
    lifecycle: lifecycleOf({ ...item, flags }),
    overdue: Boolean(item.dueDate && item.taskStatus !== 'done' && item.reviewStatus === 'approved' && item.dueDate < today()),
  };
}

function filterSql(f) {
  const parts = [];
  const params = [];
  const add = (sql, ...p) => {
    parts.push(sql);
    params.push(...p);
  };
  if (f.projectId) add('ai.project_id = ?', f.projectId);
  if (f.teamId) add('(ai.team_id = ? OR ai.assignee_team_id = ? OR ai.assignee_user_id IN (SELECT user_id FROM team_members WHERE team_id = ?))', f.teamId, f.teamId, f.teamId);
  if (f.ownerId) add('ai.assignee_user_id = ?', f.ownerId);
  if (f.priority) add('ai.priority = ?', f.priority);
  if (f.source) add('ai.source_type = ?', f.source);
  if (f.category) add('ai.category = ?', f.category);
  if (f.reviewStatus) add('ai.review_status = ?', f.reviewStatus);
  if (f.taskStatus) add('ai.task_status = ?', f.taskStatus);
  if (f.meetingId) add('ai.meeting_id = ?', f.meetingId);
  if (f.since) add('ai.created_at >= ?', new Date(f.since));
  if (f.until) add('ai.created_at < ?', new Date(f.until));
  // Items of meetings held in a period ("yesterday's meetings"): by the meeting's own time.
  if (f.meetingsFrom) add('COALESCE(m.started_at, m.scheduled_at) >= ?', new Date(f.meetingsFrom));
  if (f.meetingsUntil) add('COALESCE(m.started_at, m.scheduled_at) < ?', new Date(f.meetingsUntil));
  if (f.categories?.length) add('ai.category IN (?)', f.categories);
  if (f.ids?.length) add('ai.id IN (?)', f.ids);
  if (f.q) add('(ai.title LIKE ? OR ai.description LIKE ?)', `%${f.q}%`, `%${f.q}%`);
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

/** GET /actions */
export async function list(user, { view = 'all', limit = 50, offset = 0, ...filters } = {}) {
  const scope = await accessScope(user);
  const teams = await teamContext(user.id);
  const vis = visibilitySql(scope, teams);
  const v = viewSql(view, user, teams);
  const f = filterSql(filters);
  const where = `${vis.sql} AND ${v.sql} AND ${f.sql}`;
  const params = [...vis.params, ...v.params, ...f.params];
  const [rows] = await pool.query(
    `${SELECT} WHERE ${where}
     ORDER BY (ai.review_status = 'pending') DESC, ai.due_date IS NULL, ai.due_date, FIELD(ai.priority, 'high', 'medium', 'low'), ai.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM action_items ai LEFT JOIN meetings m ON m.id = ai.meeting_id WHERE ${where}`, params);
  return { items: rows.map(toListItem), total: Number(n), view, limit, offset };
}

/** Counts per view (tabs), for what the person may see. */
export async function summary(user) {
  const scope = await accessScope(user);
  const teams = await teamContext(user.id);
  const vis = visibilitySql(scope, teams);
  const out = {};
  for (const view of VIEWS) {
    const v = viewSql(view, user, teams);
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM action_items ai LEFT JOIN meetings m ON m.id = ai.meeting_id WHERE ${vis.sql} AND ${v.sql}`, [...vis.params, ...v.params]);
    out[view] = Number(n);
  }
  return { counts: out, canReview: scope.admin || scope.managed.length > 0 };
}

async function loadVisible(user, id, conn = pool) {
  const scope = await accessScope(user, conn);
  const teams = await teamContext(user.id);
  const vis = visibilitySql(scope, teams);
  const [[row]] = await conn.query(`${SELECT} WHERE ai.id = ? AND ${vis.sql}`, [id, ...vis.params]);
  if (!row) throw notFound('Action item not found');
  return { row, scope };
}

const canReview = (scope, item) => scope.admin || (item.projectId !== null && canManageProjectId(scope, item.projectId));

/** GET /actions/:id — the item with its full evidence trail, related work, executions and history. */
export async function detail(user, id) {
  const { row, scope } = await loadVisible(user, id);
  const item = toListItem(row);
  const full = await actionItems.findById(id);
  const [evidence] = await pool.query(
    `SELECT e.*, er.provider, er.record_type, er.title AS record_title, er.url AS record_url, er.external_key, ts.text AS segment_text
       FROM action_item_evidence e
       LEFT JOIN external_records er ON er.id = e.record_id
       LEFT JOIN transcript_segments ts ON ts.id = e.segment_id
      WHERE e.action_item_id = ? ORDER BY FIELD(e.relation, 'origin', 'supporting', 'progress', 'completion'), e.occurred_at IS NULL, e.occurred_at, e.start_sec, e.id`,
    [id],
  );
  const linked = (await linkedWork([id])).get(id) ?? [];
  const [related] = await pool.query(
    `SELECT l.id, l.link_type, l.status, l.origin, l.confidence, IF(l.from_type = 'action_item', l.to_type, l.from_type) AS other_type, IF(l.from_type = 'action_item', l.to_id, l.from_id) AS other_id,
            er.provider, er.record_type, er.title, er.url, er.external_key, er.state
       FROM record_links l
       LEFT JOIN external_records er ON er.id = IF(l.from_type = 'action_item', l.to_id, l.from_id) AND IF(l.from_type = 'action_item', l.to_type, l.from_type) = 'external_record'
      WHERE ((l.from_type = 'action_item' AND l.from_id = ?) OR (l.to_type = 'action_item' AND l.to_id = ?)) AND l.status <> 'rejected'
      ORDER BY l.status = 'confirmed' DESC, l.id DESC LIMIT 50`,
    [id, id],
  );
  const [executions] = await pool.query(
    `SELECT x.id, x.plan_id, x.kind, x.provider, x.status, x.attempts, x.last_error, x.external_key, x.external_url, x.executed_at, x.verified_at, x.created_at, x.payload, p.status AS plan_status, p.cancel_until, p.approved_by, ua.full_name AS approved_by_name
       FROM action_executions x JOIN action_plans p ON p.id = x.plan_id LEFT JOIN users ua ON ua.id = p.approved_by
      WHERE x.action_item_id = ? OR JSON_CONTAINS(COALESCE(JSON_EXTRACT(x.payload, '$.itemIds'), JSON_ARRAY()), CAST(? AS JSON)) ORDER BY x.id DESC`,
    [id, String(id)],
  );
  const execIds = executions.map((x) => x.id);
  const [history] = await pool.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json, a.created_at, u.full_name AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE (a.entity_type = 'action_item' AND a.entity_id = ?)${execIds.length ? " OR (a.entity_type = 'action_execution' AND a.entity_id IN (?))" : ''}
      ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    execIds.length ? [id, execIds] : [id],
  );
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const reviewer = canReview(scope, item);
  return {
    actionItem: {
      ...item,
      reviewDetails: reviewer ? full.reviewDetails : undefined,
      flags: reviewer ? full.flags : full.flags.filter((f) => ['completion_evidence', 'blocker_reported', 'merged_sources'].includes(f)),
      flagLabels: Object.fromEntries((full.flags ?? []).map((f) => [f, FLAGS[f] ?? f.replaceAll('_', ' ')])),
    },
    evidence: evidence.map((e) => ({
      id: e.id,
      relation: e.relation,
      excerpt: e.excerpt,
      speaker: e.speaker,
      startSec: e.start_sec === null ? null : Number(e.start_sec),
      segmentId: e.segment_id,
      segmentText: e.segment_text ?? null,
      occurredAt: e.occurred_at,
      record: e.record_id ? { id: e.record_id, provider: e.provider, recordType: e.record_type, title: e.record_title, url: e.record_url ?? e.source_url, key: e.external_key } : null,
      meeting: e.segment_id && row.meeting_id ? { id: row.meeting_id, title: row.meeting_title } : null,
    })),
    workStatus: workStatus(item, linked),
    related: related.map((r) => ({ id: r.id, linkType: r.link_type, status: r.status, origin: r.origin, confidence: r.confidence === null ? null : Number(r.confidence), type: r.other_type, otherId: r.other_id, record: r.provider ? { provider: r.provider, recordType: r.record_type, title: r.title, url: r.url, key: r.external_key, state: r.state } : null })),
    executions: executions.map((x) => ({ id: x.id, planId: x.plan_id, kind: x.kind, provider: x.provider, status: x.status, planStatus: x.plan_status, attempts: x.attempts, lastError: x.last_error, externalKey: x.external_key, externalUrl: x.external_url, executedAt: x.executed_at, verifiedAt: x.verified_at, createdAt: x.created_at, cancelUntil: x.cancel_until, approvedBy: x.approved_by_name, payload: parse(x.payload) })),
    history: history.map((h) => ({ id: h.id, action: h.action, entityType: h.entity_type, entityId: h.entity_id, actor: h.actor ?? 'WorkAgent', at: h.created_at, before: parse(h.before_json), after: parse(h.after_json) })),
    permissions: { canReview: reviewer, canExecute: item.reviewStatus === 'approved' && (reviewer || item.assignee?.id === user.id), approvalProblems: item.reviewStatus === 'pending' ? approvalProblems(full) : [] },
  };
}

// ---- review (shared rules with the meeting review screen) ------------------------------------------

async function lockForReview(conn, user, id) {
  const { scope } = await loadVisible(user, id, conn);
  const item = await actionItems.findById(id, { conn });
  if (!canReview(scope, item)) throw new AppError(403, 'FORBIDDEN', 'Only admins and the project’s manager can review this item');
  if (item.meetingId) {
    const [[m]] = await conn.query('SELECT status FROM meetings WHERE id = ? FOR UPDATE', [item.meetingId]);
    if (!REVIEWABLE_MEETING_STATUSES.includes(m.status)) throw new AppError(409, 'REVIEW_LOCKED', `Items of this meeting can’t be changed while it is "${m.status.replaceAll('_', ' ')}"; use the meeting page`);
  }
  return actionItems.findById(id, { conn, forUpdate: true });
}

const snapshot = (i) => i && { title: i.title, assigneeUserId: i.assignee?.id ?? null, dueDate: i.dueDate, priority: i.priority, reviewStatus: i.reviewStatus, category: i.category, flags: i.flags };

/** PATCH /actions/:id (pending items): content, owner, deadline, category, resolved flags. */
export async function edit(user, id, changes, { ip = null } = {}) {
  if (changes.assigneeUserId) {
    const [active] = await users.findActiveIds([changes.assigneeUserId]);
    if (!active) throw badRequest('Invalid assignee', [{ field: 'assigneeUserId', message: 'Choose an active registered user' }]);
  }
  const { before, after } = await withTransaction(async (conn) => {
    const item = await lockForReview(conn, user, id);
    if (item.reviewStatus !== 'pending') throw new AppError(409, 'ITEM_NOT_PENDING', `This item is ${item.reviewStatus}. Reopen it to make changes.`);
    let fields;
    try {
      fields = applyEdit(item, changes, { actorId: user.id });
    } catch (err) {
      if (err instanceof ReviewRuleError) throw badRequest(err.message, [{ field: 'resolveFlags', message: err.message }]);
      throw err;
    }
    if (changes.assigneeUserId !== undefined) {
      fields.assigneeKind = changes.assigneeUserId ? 'explicit' : item.assigneeTeam ? 'team' : 'unassigned';
      if (changes.assigneeUserId) fields.flags = (fields.flags ?? item.flags).filter((f) => !['team_owner', 'ambiguous_team'].includes(f));
    }
    if (changes.dueDate !== undefined) fields.deadlineStatus = changes.dueDate ? 'resolved' : item.dueDateRaw ? 'needs_clarification' : 'none';
    if (changes.dueDate) fields.dueTimezone = config.features.orgTimeZone;
    if (changes.category !== undefined) fields.category = changes.category;
    await actionItems.update(conn, id, fields);
    const after = await actionItems.findById(id, { conn });
    await recordAudit(conn, { actorUserId: user.id, action: 'action_item.updated', entityType: 'action_item', entityId: id, before: snapshot(item), after: snapshot(after), ip });
    return { before: item, after };
  });
  return { before, actionItem: after };
}

/** POST /actions/:id/{approve,reject,reopen} */
export async function review(user, id, action, { reason = null, ip = null } = {}) {
  return withTransaction(async (conn) => {
    const item = await lockForReview(conn, user, id);
    let to;
    try {
      to = transition(action, item.reviewStatus);
    } catch (err) {
      if (err instanceof ReviewRuleError) throw new AppError(409, 'INVALID_TRANSITION', err.message, err.details);
      throw err;
    }
    if (action === 'approve') {
      const problems = approvalProblems(item);
      if (problems.length) throw new AppError(409, 'NOT_APPROVABLE', 'This item can’t be approved yet', problems.map((message) => ({ field: '', message })));
    }
    const details = { ...(item.reviewDetails ?? {}) };
    const stamp = { by: user.id, at: new Date().toISOString() };
    if (action === 'reject') details.rejection = { ...stamp, reason };
    if (action === 'reopen') details.reopenedAt = [...(details.reopenedAt ?? []), stamp];
    await actionItems.setReviewStatus(conn, id, to, { actorId: user.id, reviewDetails: details });
    const after = await actionItems.findById(id, { conn });
    const verb = { approve: 'approved', reject: 'rejected', reopen: 'reopened' }[action];
    await recordAudit(conn, { actorUserId: user.id, action: `action_item.${verb}`, entityType: 'action_item', entityId: id, before: snapshot(item), after: snapshot(after), ip });
    return { actionItem: after };
  });
}

/** POST /actions/:id/status (owner or reviewer): todo / in_progress / blocked / done for approved items. */
export async function setTaskStatus(user, id, status, { ip = null } = {}) {
  return withTransaction(async (conn) => {
    const { scope } = await loadVisible(user, id, conn);
    const item = await actionItems.findById(id, { conn, forUpdate: true });
    if (item.reviewStatus !== 'approved') throw new AppError(409, 'NOT_APPROVED', 'Only approved items have a work status');
    if (item.assignee?.id !== user.id && !canReview(scope, item)) throw new AppError(403, 'FORBIDDEN', 'Only the owner or the project’s manager can change the status');
    if (item.taskStatus === status) return { actionItem: item };
    await conn.execute('UPDATE action_items SET task_status = ? WHERE id = ?', [status, id]);
    await recordAudit(conn, { actorUserId: user.id, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: item.taskStatus }, after: { taskStatus: status }, ip });
    return { actionItem: await actionItems.findById(id, { conn }) };
  });
}

/** Items (list shape) the person may see, in the order asked, plus whether they may review each. */
export async function visibleItems(user, ids, conn = pool) {
  if (!ids.length) return { items: [], scope: await accessScope(user, conn) };
  const scope = await accessScope(user, conn);
  const teams = await teamContext(user.id);
  const vis = visibilitySql(scope, teams);
  const [rows] = await conn.query(`${SELECT} WHERE ai.id IN (?) AND ${vis.sql}`, [ids, ...vis.params]);
  const byId = new Map(rows.map((r) => [r.id, toListItem(r)]));
  const items = ids.map((id) => byId.get(id)).filter(Boolean).map((i) => ({ ...i, canReview: canReview(scope, i) }));
  return { items, scope };
}
