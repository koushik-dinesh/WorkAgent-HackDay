// Creating approved action items as Jira issues (the first external write WorkAgent makes).
//
// Human approval is enforced twice: the item must already be approved in review, and an admin
// must explicitly ask for the issue (choosing the Jira project). Nothing is created automatically.
//
//   POST /action-items/:id/exports  ──▶ action_item_exports row (queued) + job 'action_item.export'
//   worker ──▶ jira.createIssue()  (idempotent: label workagent-item-<id>)
//         ──▶ ingest the created issue (same path as sync) ──▶ record link action_item ─tracks▶ issue
//
// One export per item and provider. A failed export can be requested again; a created one cannot
// (it already has its issue). Requires a Jira connection whose grant includes write:jira-work.
import { withTransaction } from '../db/transaction.js';
import { pool } from '../db/pool.js';
import * as queue from '../jobs/queue.js';
import { RescheduleJob } from '../jobs/queue.js';
import * as exportsRepo from '../repositories/actionItemExportsRepository.js';
import * as actionItems from '../repositories/actionItemsRepository.js';
import * as connections from '../repositories/integrationConnectionsRepository.js';
import * as records from '../repositories/externalRecordsRepository.js';
import * as resources from '../repositories/integrationResourcesRepository.js';
import * as meetings from '../repositories/meetingsRepository.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { audit } from './audit.js';
import { buildContext } from './integrations/context.js';
import { ProviderError } from './integrations/errors.js';
import { ingest } from './integrations/ingest.js';
import { createLink } from './integrations/links.js';
import { canWrite } from './integrations/providers/jira/index.js';
import { registry as defaultRegistry } from './integrations/registry.js';

export const JOB_TYPE = 'action_item.export';
export const PROVIDER = 'jira';
const jobKey = (exportId) => `${JOB_TYPE}:${exportId}`;

/** Jira projects an admin can create issues in: enabled project resources of active connections. */
export async function exportTargets() {
  const [rows] = await pool.query(
    `SELECT r.id, r.connection_id, r.name, r.metadata, r.project_id, p.name AS project_name, c.settings, c.display_name
     FROM integration_resources r
     JOIN integration_connections c ON c.id = r.connection_id
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE c.provider = 'jira' AND c.status = 'active' AND c.is_enabled = TRUE
       AND r.resource_type = 'project' AND r.is_enabled = TRUE AND r.access_status = 'accessible'
     ORDER BY r.name`,
  );
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
  return rows.map((r) => ({
    resourceId: r.id,
    connectionId: r.connection_id,
    connection: r.display_name,
    name: r.name,
    key: parse(r.metadata)?.key ?? null,
    project: r.project_id ? { id: r.project_id, name: r.project_name } : null,
    canWrite: canWrite({ settings: parse(r.settings) }),
  }));
}

/** Admin request: create the approved item as a Jira issue in the chosen project. */
export async function requestExport(itemId, { resourceId, actorId, ip, registry = defaultRegistry }) {
  const item = await actionItems.findById(itemId);
  if (!item) throw notFound('Action item not found');
  if (item.reviewStatus !== 'approved') throw new AppError(409, 'ITEM_NOT_APPROVED', 'Only approved action items can be created in Jira');
  const resource = await resources.findById(resourceId);
  const connection = resource && (await connections.findById(resource.connectionId));
  if (!resource || !connection || connection.provider !== PROVIDER || resource.resourceType !== 'project') throw notFound('Jira project not found');
  if (connection.status !== 'active' || !connection.isEnabled || !resource.isEnabled || resource.accessStatus !== 'accessible') {
    throw conflict('This Jira project is not available (enable it on the Jira connection first)');
  }
  if (!registry.getAvailable(PROVIDER)) throw new AppError(503, 'JIRA_NOT_CONFIGURED', 'Jira is not configured on the server');
  if (!canWrite(connection)) {
    throw new AppError(409, 'JIRA_WRITE_SCOPE_MISSING', 'This Jira connection can only read. Turn on JIRA_ISSUE_CREATION, add write:jira-work to the Atlassian app, then connect Jira again (runbook §11.6).');
  }

  const exportId = await withTransaction(async (conn) => {
    const existing = await exportsRepo.findForItem(conn, itemId, PROVIDER, { forUpdate: true });
    if (existing?.status === 'created') throw new AppError(409, 'ALREADY_EXPORTED', `This item is already Jira issue ${existing.externalKey}`);
    if (existing?.status === 'queued') throw new AppError(409, 'EXPORT_IN_PROGRESS', 'The Jira issue is already being created');
    let id;
    if (existing) {
      id = existing.id;
      await exportsRepo.update(conn, id, { status: 'queued', connectionId: connection.id, resourceId: resource.id, requestedBy: actorId, lastError: null });
    } else {
      id = await exportsRepo.create(conn, { actionItemId: itemId, provider: PROVIDER, connectionId: connection.id, resourceId: resource.id, requestedBy: actorId });
    }
    await queue.enqueue(JOB_TYPE, { exportId: id }, { dedupeKey: jobKey(id), conn });
    return id;
  });
  await audit({ actorUserId: actorId, action: 'action_item.export_requested', entityType: 'action_item', entityId: itemId, after: { provider: PROVIDER, resourceId: resource.id, project: resource.metadata?.key ?? resource.name, exportId }, ip });
  return exportsRepo.findById(exportId);
}

/** The Jira account mapped to a WorkAgent user on this site, if any. */
async function jiraAccountFor(sourceInstance, userId) {
  if (!userId) return null;
  const [rows] = await pool.query(
    `SELECT external_user_id FROM external_identities
     WHERE provider = 'jira' AND source_instance = ? AND user_id = ? AND is_bot = FALSE ORDER BY updated_at DESC LIMIT 1`,
    [sourceInstance, userId],
  );
  return rows[0]?.external_user_id ?? null;
}

async function fail(exp, message, actorId = null) {
  await withTransaction((conn) => exportsRepo.update(conn, exp.id, { status: 'failed', lastError: message }));
  await audit({ actorUserId: actorId, action: 'action_item.export_failed', entityType: 'action_item', entityId: exp.actionItemId, after: { provider: exp.provider, exportId: exp.id, error: message } });
  return 'failed';
}

/** Worker: creates the issue for a queued export. Returns 'created' | 'failed' | 'skipped'. */
export async function runExport(exportId, { registry = defaultRegistry } = {}) {
  const exp = await exportsRepo.findById(exportId);
  if (!exp || exp.status !== 'queued') return 'skipped';
  const item = await actionItems.findById(exp.actionItemId);
  if (!item || item.reviewStatus !== 'approved') return fail(exp, 'The action item is no longer approved');
  const connection = await connections.findById(exp.connectionId);
  const resource = await resources.findById(exp.resourceId);
  if (!connection || connection.status !== 'active' || !resource) return fail(exp, 'The Jira connection or project is no longer available');
  const connector = registry.getAvailable(exp.provider);
  if (!connector?.createIssue) return fail(exp, `Provider ${exp.provider} cannot create issues right now: ${registry.problem(exp.provider) ?? 'not supported'}`);

  const meeting = await meetings.findById(item.meetingId);
  const when = meeting?.scheduled_at ?? meeting?.started_at ?? null;
  const assigneeAccountId = await jiraAccountFor(connector.sourceInstance, item.assignee?.id);
  let result;
  try {
    result = await connector.createIssue(buildContext(connector, connection, { resource }), {
      resource,
      item: {
        id: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        dueDate: item.dueDate ?? null,
        assigneeAccountId,
        assigneeName: item.assignee?.fullName ?? null,
        meetingTitle: meeting?.title ?? null,
        meetingDate: when ? new Date(when).toISOString().slice(0, 10) : null,
      },
    });
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === 'rate_limited') throw new RescheduleJob(err.waitMs(), 'provider rate limit');
    if (err.kind === 'transient') throw err; // retried by the queue; final failure -> onFailure
    logger.warn('jira issue creation failed', { exportId, kind: err.kind, error: err.message });
    return fail(exp, err.publicMessage);
  }

  const linked = await withTransaction(async (conn) => {
    await ingest(conn, { connector, connection, resource, envelopes: result.envelopes, origin: 'sync' });
    const rec = await records.findBySource(conn, { provider: connector.id, sourceInstance: connector.sourceInstance, recordType: 'issue', externalId: result.externalId });
    if (rec) await createLink(conn, { from: { type: 'action_item', id: item.id }, to: { type: 'external_record', id: rec.id }, linkType: 'tracks', origin: 'manual', createdBy: exp.requestedBy });
    await exportsRepo.update(conn, exp.id, { status: 'created', externalKey: result.key, externalUrl: result.url, externalRecordId: rec?.id ?? null, assigneeSet: result.assigneeSet, lastError: null });
    return rec?.id ?? null;
  });
  await audit({
    actorUserId: exp.requestedBy,
    action: 'action_item.exported',
    entityType: 'action_item',
    entityId: item.id,
    after: { provider: exp.provider, key: result.key, recordId: linked, assigneeSet: result.assigneeSet, reusedExisting: result.existed },
  });
  logger.info('jira issue created for action item', { exportId, actionItemId: item.id, key: result.key, reusedExisting: result.existed });
  return 'created';
}

/** After the job gave up on retryable errors. */
export async function markExportFailed(exportId, err) {
  const exp = await exportsRepo.findById(exportId);
  if (exp?.status === 'queued') await fail(exp, err?.publicMessage ?? 'Jira was unavailable; try again later');
}
