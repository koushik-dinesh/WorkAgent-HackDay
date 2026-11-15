// Automated follow-up on approved action items (hourly, deterministic, no AI):
//   reminder      owner, N days before the due date
//   overdue       manager (project owner, else team lead) after N days overdue (the owner already
//                 gets the hourly overdue notification from services/notifications/triggers.js)
//   no progress   owner, when an approved commitment had no activity for N days
//   blocker       manager, when a blocked item stayed blocked for N days
//
// Channels follow the organisation's policy (app_settings 'actions.followups', admins only):
// in-app notifications by default; e-mail only when an admin turned it on. Automated e-mails are
// plans in the execution engine approved by that policy (approval_basis 'policy'), so they are
// audited, idempotent and visible on the Approvals page like any other write. Everyone's own
// notification preferences still apply (notify() honours them). Each follow-up happens once per
// item, rule and day (dedupe keys).
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { addDays, localDate } from '../../utils/dates.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit.js';
import { notify } from '../notifications/inbox.js';
import { readSetting, writeSetting } from '../settings.js';

export const SETTINGS_KEY = 'actions.followups';
export const DEFAULTS = {
  enabled: true,
  reminderDaysBefore: 1,
  overdueEscalationDays: 2,
  noProgressDays: 7,
  blockerEscalationDays: 2,
  channels: { inApp: true, email: false },
};

export const getSettings = () => readSetting(SETTINGS_KEY, DEFAULTS);
export async function updateSettings(actor, patch, { ip = null } = {}) {
  const s = await getSettings();
  const next = { ...s, ...patch, channels: { ...s.channels, ...(patch.channels ?? {}) } };
  await writeSetting(SETTINGS_KEY, next, actor.id);
  await recordAudit(pool, { actorUserId: actor.id, action: 'actions.followup_settings_updated', entityType: 'app_settings', before: s, after: next, ip });
  return next;
}

const SELECT = `
  SELECT ai.id, ai.title, ai.project_id, ai.assignee_user_id, ai.assignee_team_id, ai.task_status, ai.updated_at,
         DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date, p.owner_user_id, p.name AS project_name
    FROM action_items ai LEFT JOIN projects p ON p.id = ai.project_id LEFT JOIN meetings m ON m.id = ai.meeting_id
   WHERE ai.review_status = 'approved' AND ai.task_status <> 'done' AND (ai.meeting_id IS NULL OR m.status IN ('approved','emails_sent'))`;

async function managerFor(t) {
  if (t.owner_user_id && t.owner_user_id !== t.assignee_user_id) return t.owner_user_id;
  if (t.assignee_user_id) {
    const [[l]] = await pool.query('SELECT t.lead_user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? AND t.lead_user_id IS NOT NULL AND t.lead_user_id <> ? ORDER BY t.id LIMIT 1', [t.assignee_user_id, t.assignee_user_id]);
    if (l) return l.lead_user_id;
  }
  return null;
}

/** Last activity on the item: its own audit trail and any evidence added to it. */
async function lastActivity(itemId) {
  const [[a]] = await pool.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(created_at) FROM audit_logs WHERE entity_type = 'action_item' AND entity_id = ?), '1970-01-01'),
                     COALESCE((SELECT MAX(COALESCE(occurred_at, '1970-01-01')) FROM action_item_evidence WHERE action_item_id = ? AND relation IN ('progress','completion')), '1970-01-01')) AS at`,
    [itemId, itemId],
  );
  return a?.at ? new Date(a.at) : null;
}

/**
 * One pass. Returns counts. With e-mail on, prepares policy-approved e-mail plans per recipient.
 */
export async function run(now = new Date()) {
  const s = await getSettings();
  const out = { enabled: s.enabled, reminders: 0, overdueEscalations: 0, noProgress: 0, blockerEscalations: 0, emailPlans: 0 };
  if (!s.enabled) return out;
  const tz = config.features.orgTimeZone;
  const today = localDate(now, tz);
  const emails = new Map(); // `${template}:${userId}` -> item ids
  const queueEmail = (template, userId, itemId) => {
    if (!s.channels?.email || !userId) return;
    const k = `${template}:${userId}`;
    emails.set(k, [...(emails.get(k) ?? []), itemId]);
  };

  // Reminders before the due date (owner).
  const soon = addDays(today, s.reminderDaysBefore);
  const [dueSoon] = await pool.query(`${SELECT} AND ai.due_date BETWEEN ? AND ? AND ai.assignee_user_id IS NOT NULL LIMIT 500`, [today, soon]);
  for (const t of dueSoon) {
    if (s.channels?.inApp !== false && (await notify(pool, { userId: t.assignee_user_id, kind: 'action_reminder', title: `Due ${t.due_date === today ? 'today' : t.due_date}: ${t.title}`, link: `/actions/${t.id}`, entityType: 'action_item', entityId: t.id, dedupeKey: `reminder:${t.id}:${t.due_date}` }))) out.reminders++;
    queueEmail('reminder', t.assignee_user_id, t.id);
  }

  // Overdue for N days: the manager.
  const [overdue] = await pool.query(`${SELECT} AND ai.due_date <= ? LIMIT 500`, [addDays(today, -s.overdueEscalationDays)]);
  for (const t of overdue) {
    const manager = await managerFor(t);
    if (!manager) continue;
    if (s.channels?.inApp !== false && (await notify(pool, { userId: manager, kind: 'action_escalation', title: `Overdue since ${t.due_date}: ${t.title}`, body: t.project_name ? `In ${t.project_name}` : null, link: `/actions/${t.id}`, entityType: 'action_item', entityId: t.id, dedupeKey: `overdue-escalation:${t.id}:${t.due_date}` }))) out.overdueEscalations++;
    queueEmail('overdue_escalation', manager, t.id);
  }

  // Commitments without progress (owner).
  const [open] = await pool.query(`${SELECT} AND ai.task_status IN ('todo','in_progress') AND ai.assignee_user_id IS NOT NULL AND ai.approved_at <= ? LIMIT 500`, [new Date(now.getTime() - s.noProgressDays * 86_400_000)]);
  for (const t of open) {
    const last = await lastActivity(t.id);
    if (last && now - last < s.noProgressDays * 86_400_000) continue;
    if (s.channels?.inApp !== false && (await notify(pool, { userId: t.assignee_user_id, kind: 'action_reminder', title: `No progress for ${s.noProgressDays} days: ${t.title}`, body: 'Update its status, or say what is in the way.', link: `/actions/${t.id}`, entityType: 'action_item', entityId: t.id, dedupeKey: `no-progress:${t.id}:${today}` }))) out.noProgress++;
  }

  // Blockers unresolved for N days: the manager.
  const [blocked] = await pool.query(`${SELECT} AND (ai.task_status = 'blocked' OR JSON_CONTAINS(COALESCE(ai.flags, JSON_ARRAY()), '"blocker_reported"')) LIMIT 500`);
  for (const t of blocked) {
    const [[since]] = await pool.query("SELECT MAX(created_at) AS at FROM audit_logs WHERE entity_type = 'action_item' AND entity_id = ? AND action IN ('task.status_changed','action_item.evidence_added','action_item.created_from_source')", [t.id]);
    if (since?.at && now - new Date(since.at) < s.blockerEscalationDays * 86_400_000) continue;
    const manager = await managerFor(t);
    if (!manager) continue;
    if (s.channels?.inApp !== false && (await notify(pool, { userId: manager, kind: 'action_escalation', title: `Still blocked: ${t.title}`, body: `Blocked for ${s.blockerEscalationDays}+ days${t.project_name ? ` in ${t.project_name}` : ''}.`, link: `/actions/${t.id}`, entityType: 'action_item', entityId: t.id, dedupeKey: `blocker-escalation:${t.id}:${today}` }))) out.blockerEscalations++;
    queueEmail('blocker_escalation', manager, t.id);
  }

  // Policy-approved e-mail follow-ups through the execution engine (one per recipient and day).
  if (emails.size) {
    const engine = await import('../execution/index.js');
    for (const [key, itemIds] of emails) {
      const [template, userId] = key.split(':');
      const [[actor]] = await pool.query("SELECT id, email, full_name AS fullName, role FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1");
      if (!actor) break;
      try {
        const r = await engine.prepare(actor, { kind: 'email.send', actionItemIds: [...new Set(itemIds)], options: { template, recipientUserIds: [Number(userId)] }, origin: 'followup' });
        if (r.planId) {
          await engine.approveByPolicy(r.planId, { policy: `${SETTINGS_KEY}.channels.email` });
          out.emailPlans++;
        }
      } catch (err) {
        logger.warn('follow-up e-mail not planned', { template, userId, error: err.message });
      }
    }
  }
  return out;
}
