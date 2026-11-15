// Executors: perform one approved write with the approver's rights and report exactly what the
// provider confirmed. `idempotent: true` means a retry after an unknown outcome cannot create a
// second object (labels/markers are looked up first); otherwise an interrupted run is left as
// retry_required for a person to check. `verify` reads the object back.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import * as records from '../../repositories/externalRecordsRepository.js';
import { AppError } from '../../utils/errors.js';
import { assertJiraPermissions, jiraContext } from '../assistant/executor.js';
import { email } from '../email/index.js';
import { sanitize } from '../email/errors.js';
import { buildContext } from '../integrations/context.js';
import { ingest } from '../integrations/ingest.js';
import { createLink } from '../integrations/links.js';
import { registry } from '../integrations/registry.js';
import * as resources from '../../repositories/integrationResourcesRepository.js';
import { notify } from '../notifications/inbox.js';
import { scheduleMeeting } from '../scheduling/index.js';

const marker = (x) => `workagent:exec:${x.idempotency_key.slice(0, 24)}`;

/** Links the created/affected external record to every action item of the execution (confirmed: WorkAgent made it). */
async function linkToItems(conn, x, recordId, linkType = 'tracks') {
  if (!recordId) return;
  for (const itemId of x.payload.itemIds ?? (x.action_item_id ? [x.action_item_id] : [])) {
    await createLink(conn, { from: { type: 'action_item', id: itemId }, to: { type: 'external_record', id: recordId }, linkType, origin: 'source', evidence: { executionId: x.id, kind: x.kind } });
  }
}

async function jiraFor(x, approver, perms) {
  const j = await jiraContext(x.resource_id ?? x.target?.resourceId);
  await assertJiraPermissions(j, approver.id, perms);
  return j;
}

const jiraCreate = {
  idempotent: true, // the issue carries the label workagent-item-<id>; createIssue finds it again
  async run(x, { approver, requester }) {
    const j = await jiraFor(x, approver, ['CREATE_ISSUES', ...(x.payload.assigneeAccountId ? ['ASSIGN_ISSUES'] : [])]);
    const p = x.payload;
    const result = await j.connector.createIssue(j.ctx, {
      resource: j.resource,
      item: { id: p.itemIds[0], label: p.label, title: p.summary, description: p.description, priority: p.priority, jiraPriority: p.jiraPriority, dueDate: p.dueDate, assigneeAccountId: p.assigneeAccountId, assigneeName: null, requestedBy: requester?.fullName ?? approver.fullName },
    });
    const recordId = await withTransaction(async (conn) => {
      await ingest(conn, { connector: j.connector, connection: j.connection, resource: j.resource, envelopes: result.envelopes, origin: 'sync' });
      const rec = await records.findBySource(conn, { provider: 'jira', sourceInstance: j.connector.sourceInstance, recordType: 'issue', externalId: result.externalId });
      await linkToItems(conn, x, rec?.id ?? null);
      // Keep the older per-item export view (JiraExport) consistent with the engine.
      await conn.execute(
        `INSERT INTO action_item_exports (action_item_id, provider, connection_id, resource_id, status, external_key, external_url, external_record_id, assignee_set, requested_by)
         VALUES (?, 'jira', ?, ?, 'created', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = 'created', external_key = VALUES(external_key), external_url = VALUES(external_url), external_record_id = VALUES(external_record_id)`,
        [p.itemIds[0], j.connection.id, j.resource.id, result.key, result.url, rec?.id ?? null, Boolean(result.assigneeSet), approver.id],
      );
      if (p.assigneeUserId) {
        await notify(conn, { userId: p.assigneeUserId, kind: 'task_assigned', title: `${requester?.fullName ?? approver.fullName} created ${result.key} for you: ${p.summary}`, link: `/actions/${p.itemIds[0]}`, entityType: 'action_item', entityId: p.itemIds[0], dedupeKey: `exec:${x.id}` });
      }
      return rec?.id ?? null;
    });
    return { externalId: result.externalId, externalKey: result.key, externalUrl: result.url, externalRecordId: recordId, details: { assigneeSet: result.assigneeSet, existed: result.existed } };
  },
  async verify(x, r, { approver }) {
    const j = await jiraContext(x.resource_id ?? x.target?.resourceId);
    const f = await j.connector.issueFields(j.ctx, r.externalKey);
    return f?.key === r.externalKey;
  },
};

const jiraComment = {
  idempotent: true, // marker in the comment
  async run(x, { approver }) {
    const j = await jiraFor(x, approver, ['ADD_COMMENTS']);
    const res = await j.connector.addComment(j.ctx, { key: x.target.key, text: x.payload.text, marker: `[${marker(x)}]` });
    return { externalId: res.id, externalKey: x.target.key, externalRecordId: x.target.recordId, details: { existed: res.existed } };
  },
};

const jiraUpdate = {
  idempotent: true, // setting the same values twice is harmless
  async run(x, { approver }) {
    const changes = x.payload.changes;
    const j = await jiraFor(x, approver, ['EDIT_ISSUES', ...('assigneeAccountId' in changes ? ['ASSIGN_ISSUES'] : [])]);
    const res = await j.connector.updateIssue(j.ctx, { key: x.target.key, changes });
    await withTransaction((conn) => ingest(conn, { connector: j.connector, connection: j.connection, resource: j.resource, envelopes: res.envelopes, origin: 'sync' }));
    return { externalKey: x.target.key, externalRecordId: x.target.recordId, details: { changes } };
  },
  async verify(x, r) {
    const j = await jiraContext(x.resource_id ?? x.target?.resourceId);
    const f = await j.connector.issueFields(j.ctx, x.target.key);
    const c = x.payload.changes;
    return (!('priority' in c) || f.priority === c.priority) && (!('dueDate' in c) || (f.dueDate ?? null) === (c.dueDate ?? null)) && (!('assigneeAccountId' in c) || f.assigneeAccountId === c.assigneeAccountId);
  },
};

const jiraTransition = {
  idempotent: true,
  async run(x, { approver }) {
    const j = await jiraFor(x, approver, ['TRANSITION_ISSUES']);
    const before = await j.connector.issueFields(j.ctx, x.target.key);
    if (String(before.status).toLowerCase() === String(x.payload.statusName).toLowerCase()) return { externalKey: x.target.key, externalRecordId: x.target.recordId, verified: true, details: { alreadyThere: true } };
    const res = await j.connector.transitionIssue(j.ctx, { key: x.target.key, statusName: x.payload.statusName });
    return { externalKey: x.target.key, externalRecordId: x.target.recordId, details: res };
  },
  async verify(x) {
    const j = await jiraContext(x.resource_id ?? x.target?.resourceId);
    const f = await j.connector.issueFields(j.ctx, x.target.key);
    return String(f.status).toLowerCase() === String(x.payload.statusName).toLowerCase();
  },
};

const jiraLink = {
  idempotent: true,
  async run(x, { approver }) {
    const j = await jiraFor(x, approver, ['LINK_ISSUES']);
    const res = await j.connector.linkIssues(j.ctx, { fromKey: x.target.key, toKey: x.payload.toKey });
    return { externalKey: `${x.target.key}↔${x.payload.toKey}`, externalRecordId: x.target.recordId, verified: true, details: res };
  },
};

// ---- e-mail ---------------------------------------------------------------------------------------

const emailSend = {
  // Resend honours the Idempotency-Key; SMTP does not, so an interrupted SMTP send is not re-run.
  get idempotent() {
    return email.isConfigured() && email.getProvider().name === 'resend';
  },
  async run(x) {
    const p = x.payload;
    const [[u]] = await pool.query('SELECT id, email, is_active FROM users WHERE id = ?', [p.recipientUserId]);
    if (!u?.is_active) throw new AppError(409, 'RECIPIENT_INACTIVE', 'The recipient is no longer active');
    if (String(u.email).toLowerCase() !== String(p.recipientEmail).toLowerCase()) throw new AppError(409, 'RECIPIENT_CHANGED', 'The recipient’s e-mail address changed since the e-mail was approved');
    let provider;
    try {
      provider = email.getProvider();
    } catch (err) {
      throw new AppError(409, 'EMAIL_NOT_CONFIGURED', `E-mail is not configured: ${err.message}`);
    }
    // History row (Operations → E-mail) linked to the execution and to its action items.
    const messageId = await withTransaction(async (conn) => {
      const [[existing]] = await conn.query('SELECT id, status, provider_message_id FROM email_messages WHERE action_execution_id = ? FOR UPDATE', [x.id]);
      if (existing) return existing.id;
      const [r] = await conn.execute(
        `INSERT INTO email_messages (meeting_id, action_execution_id, kind, recipient_user_id, recipient_email, subject, html_body, text_body, idempotency_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
        [p.meetingId ?? null, x.id, `action_${p.template}`.slice(0, 32), u.id, u.email, p.subject, p.html, p.text, x.idempotency_key],
      );
      if (p.itemIds?.length) await conn.query('INSERT IGNORE INTO email_message_items (email_message_id, action_item_id) VALUES ?', [p.itemIds.map((i) => [r.insertId, i])]);
      return r.insertId;
    });
    const [[msg]] = await pool.query('SELECT status, provider_message_id FROM email_messages WHERE id = ?', [messageId]);
    if (msg.status === 'sent') return { externalId: msg.provider_message_id, externalKey: `email:${u.email}`, verified: true, details: { emailMessageId: messageId, existed: true } };
    await pool.execute("UPDATE email_messages SET status = 'sending', provider = ?, attempt_count = attempt_count + 1 WHERE id = ?", [provider.name, messageId]);
    try {
      const res = await provider.send({ from: email.from(), to: u.email, subject: p.subject, html: p.html, text: p.text, idempotencyKey: x.idempotency_key });
      await pool.execute("UPDATE email_messages SET status = 'sent', provider_message_id = ?, sent_at = NOW(), last_error = NULL WHERE id = ?", [res.messageId ?? null, messageId]);
      // "Sent" = the provider accepted it with a message id; inbox delivery is not observable.
      return { externalId: res.messageId ?? null, externalKey: `email:${u.email}`, verified: Boolean(res.messageId), details: { emailMessageId: messageId, provider: provider.name } };
    } catch (err) {
      await pool.execute("UPDATE email_messages SET status = 'failed', last_error = ? WHERE id = ?", [sanitize(err.message).slice(0, 1000), messageId]);
      throw err;
    }
  },
};

// ---- Teams ----------------------------------------------------------------------------------------

const teamsMessage = {
  idempotent: true, // marker looked up in the channel first
  async run(x) {
    const resource = await resources.findById(x.resource_id ?? x.target.resourceId);
    const connection = resource && (await connectionsRepo.findById(resource.connectionId));
    const connector = registry.getAvailable('microsoft_teams');
    if (!resource || !connection || connection.status !== 'active' || !connector) throw new AppError(409, 'TEAMS_UNAVAILABLE', 'The Teams channel is not available any more');
    const ctx = buildContext(connector, connection, { resource });
    const res = await connector.sendChannelMessage(ctx, { teamId: x.target.teamId, channelId: x.target.channelId, html: x.payload.html, marker: marker(x), executionId: x.id });
    if (!res.id) throw new AppError(502, 'TEAMS_NO_ID', 'Microsoft Teams did not return the message id');
    return { externalId: res.id, externalKey: `teams:${resource.name}`, externalUrl: res.url, verified: true, details: { existed: res.existed, mock: Boolean(res.mock) } };
  },
};

// ---- GitHub ---------------------------------------------------------------------------------------

async function githubCtx(x) {
  const connection = await connectionsRepo.findById(x.connection_id);
  const connector = registry.getAvailable('github');
  if (!connection || connection.status !== 'active' || !connector) throw new AppError(409, 'GITHUB_UNAVAILABLE', 'The GitHub connection is not available any more');
  return { connector, ctx: buildContext(connector, connection, {}) };
}

const githubIssue = {
  idempotent: true, // hidden marker searched before creating
  async run(x) {
    const { connector, ctx } = await githubCtx(x);
    const p = x.payload;
    const res = await connector.createIssue(ctx, { repo: p.repo, title: p.title, body: p.body, assignees: p.assignees, marker: marker(x) });
    return { externalId: String(res.number), externalKey: `${p.repo}#${res.number}`, externalUrl: res.url, details: { existed: res.existed } };
  },
  async verify(x, r) {
    const { connector, ctx } = await githubCtx(x);
    const issue = await connector.getIssue(ctx, { repo: x.payload.repo, number: Number(r.externalId) });
    return issue?.number === Number(r.externalId);
  },
};

const githubComment = {
  idempotent: true,
  async run(x) {
    const { connector, ctx } = await githubCtx(x);
    const res = await connector.addComment(ctx, { repo: x.target.repo, number: x.target.number, body: x.payload.body, marker: marker(x) });
    return { externalId: res.id, externalKey: `${x.target.repo}#${x.target.number}`, externalUrl: res.url, externalRecordId: x.target.recordId, verified: Boolean(res.id), details: { existed: res.existed } };
  },
};

// ---- calendar ---------------------------------------------------------------------------------------

const calendarSchedule = {
  idempotent: false, // a meeting is created in WorkAgent first; the invitation job is itself idempotent
  async run(x, { approver, plan }) {
    const p = x.payload;
    const r = await scheduleMeeting(approver, { ...p.input, confirm: true, recipientsHash: p.recipientsHash, largeConfirmed: Boolean(plan.large_confirmed) }, { commandId: plan.command_id ?? null });
    return { externalId: String(r.meetingId), externalKey: `meeting:${r.meetingId}`, externalUrl: `/meetings/scheduled/${r.meetingId}`, details: { meetingId: r.meetingId, recipients: r.recipients } };
  },
  /** Verified once the calendar event (or WorkAgent invitations) went out. */
  async verify(x, r) {
    const meetingId = Number(r.details?.meetingId ?? r.externalId);
    const [[s]] = await pool.query('SELECT status FROM meeting_schedules WHERE meeting_id = ?', [meetingId]);
    if (s?.status === 'sent') return true;
    if (s?.status === 'failed') return 'failed';
    return false;
  },
};

// ---- in-app ---------------------------------------------------------------------------------------

const workagentNotify = {
  idempotent: true, // notification dedupe key
  async run(x, { requester, approver }) {
    const p = x.payload;
    const kind = p.template === 'reminder' ? 'action_reminder' : 'task_assigned';
    const created = await notify(pool, { userId: p.userId, kind, title: p.title, body: p.note ?? `From ${requester?.fullName ?? approver.fullName}`, link: `/actions/${p.itemIds[0]}`, entityType: 'action_item', entityId: p.itemIds[0], dedupeKey: `exec:${x.id}` });
    return { externalKey: `notification:user:${p.userId}`, verified: true, details: { created, note: created ? null : 'Already notified, or the person turned this notification off' } };
  },
};

export const EXECUTORS = {
  'jira.create_issue': jiraCreate,
  'jira.comment': jiraComment,
  'jira.update': jiraUpdate,
  'jira.transition': jiraTransition,
  'jira.link': jiraLink,
  'email.send': emailSend,
  'teams.message': teamsMessage,
  'github.create_issue': githubIssue,
  'github.comment': githubComment,
  'calendar.schedule': calendarSchedule,
  'workagent.notify': workagentNotify,
};
