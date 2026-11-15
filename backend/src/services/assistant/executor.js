// Executes confirmed assistant commands and undoes them. Only called after the person confirmed
// the card (services/assistant/index.js). Every write runs with the requesting person's rights:
//   Jira        through the org's Jira connection, and only if the person's linked Jira account
//               holds the project permission (CREATE/EDIT/ASSIGN/DELETE_ISSUES) — WorkAgent never
//               does in Jira what the person could not do themselves
//   calendars   the person's own Outlook/Google connection (services/scheduling)
//   WorkAgent   admins, or managers of the task's project; an assignee may change the status only
// Undo is offered only where the change can be reversed safely, and is reported truthfully.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as actionItems from '../../repositories/actionItemsRepository.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import * as records from '../../repositories/externalRecordsRepository.js';
import * as resources from '../../repositories/integrationResourcesRepository.js';
import { AppError } from '../../utils/errors.js';
import { recordAudit } from '../audit.js';
import { buildContext } from '../integrations/context.js';
import { ProviderError } from '../integrations/errors.js';
import { ingest } from '../integrations/ingest.js';
import { registry as defaultRegistry } from '../integrations/registry.js';
import { notify } from '../notifications/inbox.js';
import { isAdmin } from '../permissions.js';
import { accessScope, canManageProjectId } from '../records/access.js';
import { cancelMeeting, scheduleMeeting } from '../scheduling/index.js';
import { canTransition } from '../tasks.js';

export const JIRA_PRIORITY = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest' };
// WorkAgent tasks have low/medium/high only; the card shows this mapping before confirmation.
export const TASK_PRIORITY = { critical: 'high', high: 'high', medium: 'medium', low: 'low', lowest: 'low' };

const fail = (code, message) => new AppError(409, code, message);

/** The Jira account linked to a WorkAgent user on this site, or null. */
export async function jiraAccountOf(sourceInstance, userId) {
  if (!userId) return null;
  const [[r]] = await pool.query(
    "SELECT external_user_id FROM external_identities WHERE provider = 'jira' AND source_instance = ? AND user_id = ? AND is_bot = FALSE ORDER BY updated_at DESC LIMIT 1",
    [sourceInstance, userId],
  );
  return r?.external_user_id ?? null;
}

/** { connector, connection, resource, ctx } for a Jira project resource, or throws a clear 409. */
export async function jiraContext(resourceId, { registry = defaultRegistry } = {}) {
  const resource = await resources.findById(resourceId);
  const connection = resource && (await connectionsRepo.findById(resource.connectionId));
  if (!resource || !connection || connection.provider !== 'jira' || connection.status !== 'active' || !resource.isEnabled) throw fail('JIRA_UNAVAILABLE', 'That Jira project is not available any more');
  const connector = registry.getAvailable('jira');
  if (!connector) throw fail('JIRA_UNAVAILABLE', `Jira is not configured on the server: ${registry.problem('jira')}`);
  return { connector, connection, resource, ctx: buildContext(connector, connection, { resource }) };
}

/** Jira context for an ingested issue record. */
async function jiraContextForRecord(recordId) {
  const [[r]] = await pool.query('SELECT id, external_key, resource_id, connection_id, metadata FROM external_records WHERE id = ?', [recordId]);
  if (!r?.resource_id) throw fail('JIRA_UNAVAILABLE', 'The Jira issue is not linked to an enabled Jira project');
  return { ...(await jiraContext(r.resource_id)), key: r.external_key };
}

/** Throws unless the person's linked Jira account holds every permission in `permissions`. */
export async function assertJiraPermissions(j, userId, permissions) {
  const accountId = await jiraAccountOf(j.connector.sourceInstance, userId);
  if (!accountId) throw fail('JIRA_ACCOUNT_NOT_LINKED', 'Your WorkAgent account is not linked to a Jira account, so WorkAgent cannot check what you may do in Jira. Ask an admin to link your Jira identity.');
  const projectKey = j.resource.metadata?.key;
  for (const permission of permissions) {
    if (!(await j.connector.userHasPermission(j.ctx, { accountId, projectKey, permission }))) {
      throw fail('JIRA_PERMISSION_DENIED', `You do not have the Jira permission ${permission} in ${projectKey}, so WorkAgent will not do it for you.`);
    }
  }
  return accountId;
}

const providerFail = (err) => {
  if (!(err instanceof ProviderError)) throw err;
  return new AppError(502, 'PROVIDER_ERROR', err.publicMessage ?? err.message);
};

// ---- create a Jira issue (assign_task) ------------------------------------------------------------

async function createJiraIssue(user, cmd, plan) {
  const j = await jiraContext(plan.jira.resourceId);
  const assigneeAccountId = plan.assignee ? await jiraAccountOf(j.connector.sourceInstance, plan.assignee.userId) : null;
  await assertJiraPermissions(j, user.id, ['CREATE_ISSUES', ...(assigneeAccountId ? ['ASSIGN_ISSUES'] : [])]);
  let result;
  try {
    result = await j.connector.createIssue(j.ctx, {
      resource: j.resource,
      item: {
        id: cmd.id,
        label: `workagent-command-${cmd.id}`,
        title: plan.title,
        description: plan.description,
        priority: plan.priority ?? 'medium',
        jiraPriority: plan.priority ? JIRA_PRIORITY[plan.priority] : null,
        dueDate: plan.dueDate ?? null,
        assigneeAccountId,
        assigneeName: plan.assignee?.label ?? null,
        requestedBy: user.fullName,
      },
    });
  } catch (err) {
    throw providerFail(err);
  }
  const recordId = await withTransaction(async (conn) => {
    await ingest(conn, { connector: j.connector, connection: j.connection, resource: j.resource, envelopes: result.envelopes, origin: 'sync' });
    const rec = await records.findBySource(conn, { provider: 'jira', sourceInstance: j.connector.sourceInstance, recordType: 'issue', externalId: result.externalId });
    if (plan.assignee) {
      // The requesting person's name, not WorkAgent's, is on the notification.
      await notify(conn, { userId: plan.assignee.userId, kind: 'task_assigned', title: `${user.fullName} assigned you ${result.key}: ${plan.title}`, body: plan.dueDate ? `Due ${plan.dueDate}` : null, link: rec ? `/records/${rec.id}` : null, entityType: 'external_record', entityId: rec?.id ?? null, dedupeKey: `assistant:${cmd.id}` });
    }
    return rec?.id ?? null;
  });
  let canDelete = false;
  try {
    await assertJiraPermissions(j, user.id, ['DELETE_ISSUES']);
    canDelete = true;
  } catch {
    canDelete = false;
  }
  return {
    provider: 'jira',
    externalId: result.externalId,
    externalKey: result.key,
    externalUrl: result.url,
    externalRecordId: recordId,
    summary: `Created ${result.key}${plan.assignee ? ` for ${plan.assignee.label}${result.assigneeSet ? '' : ' (Jira did not accept the assignee; the issue is unassigned)'}` : ''}.`,
    undo: canDelete ? { kind: 'jira_delete', key: result.key, resourceId: plan.jira.resourceId } : null,
    undoUnavailable: canDelete ? null : 'You cannot delete issues in this Jira project, so this cannot be undone here.',
  };
}

// ---- update a task (update_task / set_deadline) ---------------------------------------------------

async function updateWorkAgentTask(user, cmd, plan, ip) {
  const id = plan.task.ref.id;
  const changes = plan.changes;
  return withTransaction(async (conn) => {
    const item = await actionItems.findById(id, { conn, forUpdate: true });
    if (!item || item.reviewStatus !== 'approved') throw fail('TASK_UNAVAILABLE', 'The task is not available any more');
    const scope = await accessScope(user, conn);
    const manages = isAdmin(user) || canManageProjectId(scope, item.projectId);
    const ownsStatusOnly = item.assignee?.id === user.id && Object.keys(changes).every((k) => k === 'taskStatus');
    if (!manages && !ownsStatusOnly) throw new AppError(403, 'FORBIDDEN', 'Only an admin or the project’s manager can change this task (assignees can change its status)');
    const before = { priority: item.priority, dueDate: item.dueDate ? (item.dueDate instanceof Date ? item.dueDate.toISOString().slice(0, 10) : String(item.dueDate).slice(0, 10)) : null, assigneeUserId: item.assignee?.id ?? null, taskStatus: item.taskStatus };
    if (changes.taskStatus && !canTransition(item.taskStatus, changes.taskStatus)) throw fail('INVALID_TRANSITION', `A task can’t move from “${item.taskStatus}” to “${changes.taskStatus}”`);
    const fields = {};
    if ('priority' in changes) fields.priority = changes.priority;
    if ('dueDate' in changes) fields.dueDate = changes.dueDate;
    if ('assigneeUserId' in changes) {
      fields.assigneeUserId = changes.assigneeUserId;
      fields.assigneeMatch = 'manual';
    }
    if (Object.keys(fields).length) {
      await actionItems.update(conn, id, fields);
      await recordAudit(conn, { actorUserId: user.id, action: 'action_item.updated', entityType: 'action_item', entityId: id, before, after: { ...before, ...changes, via: 'assistant', commandId: cmd.id }, ip });
    }
    if (changes.taskStatus) {
      await conn.execute('UPDATE action_items SET task_status = ? WHERE id = ?', [changes.taskStatus, id]);
      await recordAudit(conn, { actorUserId: user.id, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: before.taskStatus }, after: { taskStatus: changes.taskStatus }, ip });
    }
    return {
      provider: 'workagent',
      actionItemId: id,
      summary: `Updated “${item.title}”.`,
      undo: { kind: 'task_revert', id, before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k]])) },
    };
  });
}

async function updateJiraIssue(user, cmd, plan) {
  const j = await jiraContextForRecord(plan.task.ref.id);
  const changes = {};
  if ('priority' in plan.changes) changes.priority = JIRA_PRIORITY[plan.changes.priority];
  if ('dueDate' in plan.changes) changes.dueDate = plan.changes.dueDate;
  if ('assigneeUserId' in plan.changes) {
    changes.assigneeAccountId = await jiraAccountOf(j.connector.sourceInstance, plan.changes.assigneeUserId);
    if (!changes.assigneeAccountId) throw fail('ASSIGNEE_NOT_IN_JIRA', `${plan.assignee?.label ?? 'That person'} has no linked Jira account`);
  }
  await assertJiraPermissions(j, user.id, ['EDIT_ISSUES', ...('assigneeAccountId' in changes ? ['ASSIGN_ISSUES'] : [])]);
  let before;
  let result;
  try {
    before = await j.connector.issueFields(j.ctx, j.key);
    result = await j.connector.updateIssue(j.ctx, { key: j.key, changes });
  } catch (err) {
    throw providerFail(err);
  }
  await withTransaction((conn) => ingest(conn, { connector: j.connector, connection: j.connection, resource: j.resource, envelopes: result.envelopes, origin: 'sync' }));
  const revert = {};
  if ('priority' in changes) revert.priority = before.priority;
  if ('dueDate' in changes) revert.dueDate = before.dueDate;
  if ('assigneeAccountId' in changes) revert.assigneeAccountId = before.assigneeAccountId;
  return { provider: 'jira', externalKey: j.key, externalRecordId: plan.task.ref.id, summary: `Updated ${j.key}.`, undo: { kind: 'jira_revert', recordId: plan.task.ref.id, key: j.key, changes: revert } };
}

// ---- entry points ---------------------------------------------------------------------------------

/** Executes a confirmed plan. Returns { provider, summary, undo, external ids… }. */
export async function execute(user, cmd, plan, { ip = null } = {}) {
  switch (plan.action) {
    case 'jira_create':
      return createJiraIssue(user, cmd, plan);
    case 'task_update':
      return plan.task.ref.type === 'action_item' ? updateWorkAgentTask(user, cmd, plan, ip) : updateJiraIssue(user, cmd, plan);
    case 'meeting_create': {
      const { meetingId } = await scheduleMeeting(user, { ...plan.meetingInput, confirm: true, recipientsHash: plan.recipientsHash, largeConfirmed: plan.largeConfirmed === true }, { ip, commandId: cmd.id });
      return { provider: plan.meetingInput.provider, meetingId, summary: `Scheduled “${plan.meetingInput.title}” for ${plan.recipientCount} ${plan.recipientCount === 1 ? 'person' : 'people'}${plan.meetingInput.provider === 'workagent' ? ' (in-app invitations)' : ''}.`, undo: { kind: 'meeting_cancel', meetingId } };
    }
    default:
      throw fail('NOT_EXECUTABLE', 'This command has nothing to execute');
  }
}

/** Reverses an executed command. Returns { undone: boolean, message }. Never claims success it did not get. */
export async function undo(user, undoData, { ip = null } = {}) {
  switch (undoData.kind) {
    case 'jira_delete': {
      const j = await jiraContext(undoData.resourceId);
      await assertJiraPermissions(j, user.id, ['DELETE_ISSUES']);
      try {
        await j.connector.deleteIssue(j.ctx, { key: undoData.key });
      } catch (err) {
        throw providerFail(err);
      }
      await pool.execute("UPDATE external_records SET source_deleted_at = NOW(3) WHERE provider = 'jira' AND external_key = ?", [undoData.key]);
      return { undone: true, message: `Deleted ${undoData.key} in Jira.` };
    }
    case 'jira_revert': {
      const j = await jiraContextForRecord(undoData.recordId);
      await assertJiraPermissions(j, user.id, ['EDIT_ISSUES', ...('assigneeAccountId' in undoData.changes ? ['ASSIGN_ISSUES'] : [])]);
      try {
        const result = await j.connector.updateIssue(j.ctx, { key: undoData.key, changes: undoData.changes });
        await withTransaction((conn) => ingest(conn, { connector: j.connector, connection: j.connection, resource: j.resource, envelopes: result.envelopes, origin: 'sync' }));
      } catch (err) {
        throw providerFail(err);
      }
      return { undone: true, message: `Restored the previous values of ${undoData.key}.` };
    }
    case 'task_revert':
      await updateWorkAgentTask(user, { id: null }, { task: { ref: { type: 'action_item', id: undoData.id } }, changes: undoData.before }, ip);
      return { undone: true, message: 'Restored the task’s previous values.' };
    case 'meeting_cancel': {
      const r = await cancelMeeting(user, undoData.meetingId, { ip, reason: 'Undone in WorkAgent' });
      const message = r.providerCancelled
        ? 'Cancelled the meeting; the calendar sent attendees a cancellation.'
        : r.previousStatus === 'sending'
          ? 'Cancelled the meeting before any invitation went out.'
          : 'Cancelled the meeting; invitees were told in WorkAgent.';
      return { undone: true, message };
    }
    default:
      return { undone: false, message: 'This command cannot be undone' };
  }
}
