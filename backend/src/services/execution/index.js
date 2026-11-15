// Central action execution engine. Every external write WorkAgent makes for an action item —
// Jira issues/comments/updates/transitions, e-mail, Teams messages, GitHub issues/comments, calendar
// invitations, in-app notifications — goes through here, whichever page or the assistant asked.
//
//   prepare   kind + items + options -> planner (services/execution/planners.js): target provider,
//             recipients, exact content, warnings, blockers, permission checks
//             -> action_plans (awaiting_approval) + action_executions, each with an idempotency key
//   approve   the person who reviews it confirms the exact preview (hash must match; large plans
//             need an extra confirmation); permissions are checked again
//             -> scheduled; nothing is written for ACTION_CANCEL_SECONDS (cancel window, default 60 s)
//   execute   job 'action.execute' (restart-safe, one job per plan): claims each execution,
//             runs its executor with the approver's rights, records the external object, verifies
//             it by reading it back, retries transient failures with backoff, and leaves the rest
//             visible as failed / retry_required for a manual retry
//   audit     every transition is in audit_logs (entity action_plan / action_execution)
//
// An execution is "succeeded" only when the provider confirmed the object (id/key returned), and
// "verified" when WorkAgent could read it back; an attempted request is never reported as done.
import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import { RescheduleJob, backoffMs } from '../../jobs/queue.js';
import { AppError, badRequest, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit.js';
import { visibleItems } from '../actions/center.js';
import { notify } from '../notifications/inbox.js';
import { EXECUTORS } from './executors.js';
import { KINDS, PLANNERS } from './planners.js';

export const JOB_TYPE = 'action.execute';
export { KINDS };
export const engineSettings = {
  cancelSeconds: () => config.features.actionCancelSeconds,
  largeThreshold: () => config.features.actionLargeThreshold,
};

const sha = (s) => createHash('sha256').update(s).digest('hex');
const stable = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const jobKey = (planId) => `${JOB_TYPE}:plan:${planId}`;

function idempotencyKey(kind, provider, d) {
  return sha([kind, provider, stable(d.target ?? {}), d.actionItemId ?? '', sha(stable(d.payload))].join('|'));
}

// ---- prepare ---------------------------------------------------------------------------------------

/**
 * Builds and stores a plan awaiting approval.
 * @param input { kind, actionItemIds, options, origin, commandId }
 * @returns preview (with planId, or planId null when nothing can be executed)
 */
export async function prepare(user, { kind, actionItemIds = [], options = {}, origin = 'action_center', commandId = null }) {
  const def = KINDS[kind];
  if (!def) throw badRequest(`Unknown action kind ${kind}`);
  const ids = [...new Set(actionItemIds.map(Number))];
  const { items } = await visibleItems(user, ids);
  if (items.length !== ids.length) throw notFound('Some action items were not found');
  for (const i of items) {
    if (!i.canReview && !(def.ownItemsAllowed && i.assignee?.id === user.id)) throw new AppError(403, 'FORBIDDEN', `You cannot execute actions for “${i.title}”: only admins and the project’s manager can`);
    if (def.needsApproved !== false && i.reviewStatus !== 'approved') throw new AppError(409, 'NOT_APPROVED', `“${i.title}” is not approved yet; review it first`);
  }
  if (def.needsItems && !items.length) throw badRequest('Choose at least one action item');

  const planned = await PLANNERS[kind](user, items, options);
  const drafts = planned.drafts;
  const provider = planned.provider ?? def.provider;
  const blockers = [...(planned.blockers ?? [])];
  const warnings = [...(planned.warnings ?? [])];

  // Already done or already planned: never twice.
  for (const d of drafts) {
    if (d.skip) continue;
    d.idempotencyKey = idempotencyKey(kind, provider, d);
    const [[dup]] = await pool.query('SELECT id, plan_id, status, external_key FROM action_executions WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (dup && !['cancelled', 'rejected'].includes(dup.status)) {
      d.skip = { reason: ['succeeded', 'verified'].includes(dup.status) ? `Already done${dup.external_key ? ` (${dup.external_key})` : ''}` : `Already planned (plan #${dup.plan_id}, ${dup.status.replaceAll('_', ' ')})`, executionId: dup.id };
    }
  }
  const runnable = drafts.filter((d) => !d.skip && !d.blockers?.length);
  const people = new Set(runnable.flatMap((d) => d.affectedUserIds ?? []));
  const affected = { records: runnable.length, people: people.size };
  const requiresLargeConfirmation = Math.max(affected.records, affected.people) > engineSettings.largeThreshold();
  const preview = {
    kind,
    label: def.label,
    provider,
    providerLabel: planned.providerLabel ?? def.providerLabel,
    summary: planned.summary ?? def.label,
    affected,
    recipients: planned.recipients ?? [],
    drafts: drafts.map((d) => ({ actionItemId: d.actionItemId ?? null, itemIds: d.payload?.itemIds ?? (d.actionItemId ? [d.actionItemId] : []), title: d.title, target: d.targetLabel ?? null, content: d.preview ?? null, warnings: d.warnings ?? [], blockers: d.blockers ?? [], skipped: d.skip?.reason ?? null })),
    warnings,
    blockers,
    requiresLargeConfirmation,
    largeThreshold: engineSettings.largeThreshold(),
    cancelSeconds: engineSettings.cancelSeconds(),
    canApprove: runnable.length > 0 && blockers.length === 0,
  };
  if (!preview.canApprove) return { planId: null, previewHash: null, preview };

  const previewHash = sha(stable({ kind, provider, drafts: runnable.map((d) => [d.idempotencyKey, d.target, d.payload]) }));
  const planId = await withTransaction(async (conn) => {
    const [p] = await conn.execute(
      'INSERT INTO action_plans (kind, title, origin, command_id, status, preview, preview_hash, item_count, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [kind, String(planned.summary ?? def.label).slice(0, 255), origin, commandId, 'awaiting_approval', JSON.stringify(preview), previewHash, runnable.length, user.id],
    );
    for (const d of runnable) {
      // A cancelled/rejected earlier plan must not block planning the same write again.
      const [[old]] = await conn.query("SELECT id FROM action_executions WHERE idempotency_key = ? AND status IN ('cancelled','rejected') FOR UPDATE", [d.idempotencyKey]);
      if (old) await conn.execute('UPDATE action_executions SET idempotency_key = ? WHERE id = ?', [sha(`${d.idempotencyKey}:void:${old.id}`), old.id]);
      await conn.execute(
        `INSERT INTO action_executions (plan_id, action_item_id, kind, provider, connection_id, resource_id, target, payload, payload_hash, idempotency_key, status, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?)`,
        [p.insertId, d.actionItemId ?? null, kind, provider, d.connectionId ?? null, d.resourceId ?? null, JSON.stringify(d.target ?? null), JSON.stringify(d.payload), sha(stable(d.payload)), d.idempotencyKey, def.maxAttempts ?? 5],
      );
    }
    await setItemsStatus(conn, runnable.flatMap(itemIdsOf), 'awaiting_approval');
    await recordAudit(conn, { actorUserId: user.id, action: 'action_plan.prepared', entityType: 'action_plan', entityId: p.insertId, after: { kind, provider, origin, commandId, records: affected.records, people: affected.people, itemIds: ids } });
    return p.insertId;
  });
  return { planId, previewHash, preview };
}

const itemIdsOf = (d) => d.payload?.itemIds ?? (d.actionItemId ? [d.actionItemId] : []);

async function setItemsStatus(conn, itemIds, status) {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length) await conn.query('UPDATE action_items SET execution_status = ? WHERE id IN (?)', [status, ids]);
}

/** Recomputes the execution status of items from all their executions. */
async function refreshItemsStatus(conn, itemIds) {
  for (const id of [...new Set(itemIds)].filter(Boolean)) {
    const [rows] = await conn.query(
      "SELECT status FROM action_executions WHERE action_item_id = ? OR JSON_CONTAINS(COALESCE(JSON_EXTRACT(payload, '$.itemIds'), JSON_ARRAY()), CAST(? AS JSON))",
      [id, String(id)],
    );
    const s = rows.map((r) => r.status);
    let status = 'none';
    if (s.includes('executing')) status = 'executing';
    else if (s.includes('retry_required')) status = 'retry_required';
    else if (s.includes('failed')) status = 'failed';
    else if (s.includes('scheduled')) status = 'scheduled';
    else if (s.includes('awaiting_approval')) status = 'awaiting_approval';
    else if (s.some((x) => ['succeeded', 'verified'].includes(x))) status = 'completed';
    await conn.execute('UPDATE action_items SET execution_status = ? WHERE id = ?', [status, id]);
  }
}

// ---- approval, cancel, reject, retry ---------------------------------------------------------------

async function lockPlan(conn, planId) {
  const [[p]] = await conn.query('SELECT * FROM action_plans WHERE id = ? FOR UPDATE', [planId]);
  if (!p) throw notFound('Plan not found');
  const [execs] = await conn.query('SELECT * FROM action_executions WHERE plan_id = ? ORDER BY id FOR UPDATE', [planId]);
  return { plan: { ...p, preview: parse(p.preview) }, execs: execs.map((x) => ({ ...x, target: parse(x.target), payload: parse(x.payload), result: parse(x.result) })) };
}

async function assertMayDecide(user, plan, execs) {
  const ids = [...new Set(execs.flatMap((x) => x.payload?.itemIds ?? (x.action_item_id ? [x.action_item_id] : [])))];
  if (!ids.length) {
    if (plan.requested_by !== user.id && user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only the person who prepared this plan or an admin can decide it');
    return;
  }
  const { items } = await visibleItems(user, ids);
  const def = KINDS[plan.kind];
  if (items.length !== ids.length || items.some((i) => !i.canReview && !(def?.ownItemsAllowed && i.assignee?.id === user.id))) {
    throw new AppError(403, 'FORBIDDEN', 'You may not approve actions for all of these items');
  }
}

/** POST /execution/plans/:id/approve */
export async function approve(user, planId, { previewHash, largeConfirmed = false } = {}, { ip = null } = {}) {
  const out = await withTransaction(async (conn) => {
    const { plan, execs } = await lockPlan(conn, planId);
    if (plan.status !== 'awaiting_approval') throw new AppError(409, 'PLAN_NOT_PENDING', `This plan is ${plan.status.replaceAll('_', ' ')}`);
    if (previewHash !== plan.preview_hash) throw new AppError(409, 'PREVIEW_CHANGED', 'What you reviewed is not what would be executed. Prepare the action again.');
    if (plan.preview?.requiresLargeConfirmation && largeConfirmed !== true) {
      throw new AppError(409, 'LARGE_CONFIRMATION_REQUIRED', `This affects ${plan.preview.affected.records} records and ${plan.preview.affected.people} people. Confirm the bulk operation explicitly.`, plan.preview.affected);
    }
    await assertMayDecide(user, plan, execs);
    // Provider permissions with the approver's own rights, now (not when the plan was drafted).
    await PLANNERS.check?.(plan.kind, user, execs);
    // Whole seconds: DATETIME rounds, and a rounded-up instant would delay a zero-second window.
    const seconds = engineSettings.cancelSeconds();
    const cancelUntil = seconds > 0 ? new Date(Math.floor((Date.now() + seconds * 1000) / 1000) * 1000) : null;
    await conn.execute("UPDATE action_plans SET status = 'scheduled', approved_by = ?, approved_at = NOW(), cancel_until = ?, approval_basis = 'user', large_confirmed = ? WHERE id = ?", [user.id, cancelUntil, Boolean(largeConfirmed), planId]);
    await conn.execute("UPDATE action_executions SET status = 'scheduled', next_attempt_at = NULL WHERE plan_id = ? AND status = 'awaiting_approval'", [planId]);
    await refreshItemsStatus(conn, execs.flatMap((x) => x.payload?.itemIds ?? [x.action_item_id]));
    await queue.enqueue(JOB_TYPE, { planId }, { dedupeKey: jobKey(planId), conn, delayMs: seconds * 1000 });
    await recordAudit(conn, { actorUserId: user.id, action: 'action_plan.approved', entityType: 'action_plan', entityId: planId, after: { kind: plan.kind, executions: execs.length, cancelUntil: cancelUntil?.toISOString() ?? null, largeConfirmed: Boolean(largeConfirmed) }, ip });
    return { cancelUntil };
  });
  return { ...(await getPlan(user, planId)), cancelUntil: out.cancelUntil };
}

/** POST /execution/plans/:id/cancel — within the cancel window, or before approval. */
export async function cancel(user, planId, { ip = null } = {}) {
  await withTransaction(async (conn) => {
    const { plan, execs } = await lockPlan(conn, planId);
    if (plan.status === 'awaiting_approval' || (plan.status === 'scheduled' && plan.cancel_until && new Date(plan.cancel_until) > new Date())) {
      if (plan.requested_by !== user.id && plan.approved_by !== user.id && user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only the requester, the approver or an admin can cancel');
      await conn.execute("UPDATE action_plans SET status = 'cancelled' WHERE id = ?", [planId]);
      await conn.execute("UPDATE action_executions SET status = 'cancelled' WHERE plan_id = ? AND status IN ('awaiting_approval','scheduled')", [planId]);
      await refreshItemsStatus(conn, execs.flatMap((x) => x.payload?.itemIds ?? [x.action_item_id]));
      await recordAudit(conn, { actorUserId: user.id, action: 'action_plan.cancelled', entityType: 'action_plan', entityId: planId, before: { status: plan.status }, ip });
      return;
    }
    throw new AppError(409, 'TOO_LATE_TO_CANCEL', plan.status === 'scheduled' ? 'The cancel window has passed; execution has started' : `This plan is ${plan.status.replaceAll('_', ' ')}`);
  });
  return getPlan(user, planId);
}

/** POST /execution/plans/:id/reject — a reviewer declines a plan someone else prepared. */
export async function reject(user, planId, { reason = null, ip = null } = {}) {
  await withTransaction(async (conn) => {
    const { plan, execs } = await lockPlan(conn, planId);
    if (plan.status !== 'awaiting_approval') throw new AppError(409, 'PLAN_NOT_PENDING', `This plan is ${plan.status.replaceAll('_', ' ')}`);
    await assertMayDecide(user, plan, execs);
    await conn.execute("UPDATE action_plans SET status = 'rejected' WHERE id = ?", [planId]);
    await conn.execute("UPDATE action_executions SET status = 'rejected' WHERE plan_id = ?", [planId]);
    await refreshItemsStatus(conn, execs.flatMap((x) => x.payload?.itemIds ?? [x.action_item_id]));
    await recordAudit(conn, { actorUserId: user.id, action: 'action_plan.rejected', entityType: 'action_plan', entityId: planId, after: { reason }, ip });
  });
  return getPlan(user, planId);
}

/** POST /execution/executions/:id/retry — after a failure, once the cause is fixed. */
export async function retry(user, executionId, { ip = null } = {}) {
  const planId = await withTransaction(async (conn) => {
    const [[x]] = await conn.query('SELECT * FROM action_executions WHERE id = ? FOR UPDATE', [executionId]);
    if (!x) throw notFound('Execution not found');
    if (!['failed', 'retry_required'].includes(x.status)) throw new AppError(409, 'NOT_RETRYABLE', `This execution is ${x.status.replaceAll('_', ' ')}`);
    const { plan, execs } = await lockPlan(conn, x.plan_id);
    await assertMayDecide(user, plan, execs.filter((e) => e.id === x.id));
    await PLANNERS.check?.(plan.kind, user, execs.filter((e) => e.id === x.id));
    await conn.execute("UPDATE action_executions SET status = 'scheduled', next_attempt_at = NULL, max_attempts = attempts + 3, last_error = NULL WHERE id = ?", [x.id]);
    await conn.execute("UPDATE action_plans SET status = 'executing', cancel_until = NULL WHERE id = ?", [x.plan_id]);
    await refreshItemsStatus(conn, parse(x.payload)?.itemIds ?? [x.action_item_id]);
    await recordAudit(conn, { actorUserId: user.id, action: 'action_execution.retry_requested', entityType: 'action_execution', entityId: x.id, ip });
    return x.plan_id;
  });
  await queue.enqueue(JOB_TYPE, { planId }, { dedupeKey: jobKey(planId) }).catch((err) => {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  });
  return getPlan(user, planId);
}

/**
 * Plans approved by an organisation policy (automated follow-ups an admin switched on): recorded
 * with approval_basis 'policy' and executed without the cancel window.
 */
export async function approveByPolicy(planId, { policy }) {
  await withTransaction(async (conn) => {
    const { plan, execs } = await lockPlan(conn, planId);
    if (plan.status !== 'awaiting_approval') return;
    await conn.execute("UPDATE action_plans SET status = 'scheduled', approved_at = NOW(), cancel_until = NULL, approval_basis = 'policy' WHERE id = ?", [planId]);
    await conn.execute("UPDATE action_executions SET status = 'scheduled' WHERE plan_id = ? AND status = 'awaiting_approval'", [planId]);
    await refreshItemsStatus(conn, execs.flatMap((x) => x.payload?.itemIds ?? [x.action_item_id]));
    await queue.enqueue(JOB_TYPE, { planId }, { dedupeKey: jobKey(planId), conn });
    await recordAudit(conn, { action: 'action_plan.approved_by_policy', entityType: 'action_plan', entityId: planId, after: { policy } });
  });
}

// ---- execution (worker) ------------------------------------------------------------------------------

const RETRYABLE_KINDS = new Set(['rate_limited', 'unavailable', 'network', 'timeout', 'server']);
const isRetryable = (err) => err?.retryable === true || RETRYABLE_KINDS.has(err?.kind);

async function userById(id) {
  if (!id) return null;
  const [[u]] = await pool.query('SELECT id, email, full_name AS fullName, role, is_active FROM users WHERE id = ?', [id]);
  return u ?? null;
}

/** Job 'action.execute' { planId }. */
export async function runPlan(planId, { now = new Date() } = {}) {
  const [[plan]] = await pool.query('SELECT * FROM action_plans WHERE id = ?', [planId]);
  // Only approved plans run; cancelled/rejected/finished ones are left alone (a retry re-opens one).
  if (!plan || !['scheduled', 'executing'].includes(plan.status)) return { status: plan?.status ?? 'missing' };
  if (plan.cancel_until && new Date(plan.cancel_until) > now) throw new RescheduleJob(new Date(plan.cancel_until) - now + 50, 'cancel window');
  if (plan.status === 'scheduled') await pool.execute("UPDATE action_plans SET status = 'executing' WHERE id = ? AND status = 'scheduled'", [planId]);

  const approver = (await userById(plan.approved_by)) ?? (await userById(plan.requested_by));
  const requester = (await userById(plan.requested_by)) ?? approver;
  const [execs] = await pool.query("SELECT * FROM action_executions WHERE plan_id = ? AND status IN ('scheduled','executing') ORDER BY id", [planId]);
  let waitMs = null;
  for (const row of execs) {
    const x = { ...row, target: parse(row.target), payload: parse(row.payload) };
    if (x.next_attempt_at && new Date(x.next_attempt_at) > now) {
      waitMs = Math.min(waitMs ?? Infinity, new Date(x.next_attempt_at) - now);
      continue;
    }
    const executor = EXECUTORS[x.kind];
    if (x.status === 'executing' && !executor.idempotent) {
      // A worker stopped mid-request: we cannot know whether the provider accepted it.
      await finish(x, 'retry_required', { error: 'Execution was interrupted (worker stopped). It may or may not have happened; check before retrying.' });
      continue;
    }
    const [claim] = await pool.execute("UPDATE action_executions SET status = 'executing', attempts = attempts + 1 WHERE id = ? AND status IN ('scheduled','executing')", [x.id]);
    if (!claim.affectedRows) continue;
    try {
      const r = await executor.run(x, { approver, requester, plan });
      let verified = r.verified ?? false;
      if (!verified && executor.verify) {
        verified = await executor.verify(x, r, { approver }).catch((err) => {
          logger.warn('execution verification failed', { executionId: x.id, error: err.message });
          return false;
        });
      }
      await finish(x, verified ? 'verified' : 'succeeded', { result: r });
    } catch (err) {
      const attempts = x.attempts + 1;
      const message = String(err.publicMessage ?? err.message ?? 'Unknown error').slice(0, 990);
      if (isRetryable(err) && attempts < x.max_attempts) {
        const delay = err.retryAfterMs ?? backoffMs(attempts);
        await pool.execute("UPDATE action_executions SET status = 'scheduled', next_attempt_at = ?, last_error = ? WHERE id = ?", [new Date(now.getTime() + delay), message, x.id]);
        await recordAudit(pool, { action: 'action_execution.retry_scheduled', entityType: 'action_execution', entityId: x.id, after: { attempt: attempts, error: message, delayMs: delay } });
        waitMs = Math.min(waitMs ?? Infinity, delay);
      } else {
        await finish(x, isRetryable(err) ? 'retry_required' : 'failed', { error: message });
      }
    }
  }
  if (waitMs !== null) throw new RescheduleJob(Math.max(1000, waitMs), 'execution retry');
  return finalizePlan(planId);
}

async function finish(x, status, { result = null, error = null }) {
  await withTransaction(async (conn) => {
    await conn.execute(
      `UPDATE action_executions SET status = ?, last_error = ?, result = COALESCE(?, result), external_id = COALESCE(?, external_id), external_key = COALESCE(?, external_key),
              external_url = COALESCE(?, external_url), external_record_id = COALESCE(?, external_record_id),
              executed_at = IF(? IN ('succeeded','verified'), NOW(), executed_at), verified_at = IF(? = 'verified', NOW(), verified_at)
        WHERE id = ?`,
      [status, error, result ? JSON.stringify(result.details ?? {}) : null, result?.externalId ?? null, result?.externalKey ?? null, result?.externalUrl ?? null, result?.externalRecordId ?? null, status, status, x.id],
    );
    await refreshItemsStatus(conn, x.payload?.itemIds ?? [x.action_item_id]);
    await recordAudit(conn, {
      action: `action_execution.${status}`,
      entityType: 'action_execution',
      entityId: x.id,
      after: { kind: x.kind, provider: x.provider, externalKey: result?.externalKey ?? null, externalUrl: result?.externalUrl ?? null, error, mock: result?.details?.mock ?? undefined },
    });
  });
}

async function finalizePlan(planId) {
  const [execs] = await pool.query('SELECT status FROM action_executions WHERE plan_id = ?', [planId]);
  const s = execs.map((e) => e.status);
  if (s.some((x) => ['scheduled', 'executing'].includes(x))) return { status: 'executing' };
  const ok = s.filter((x) => ['succeeded', 'verified'].includes(x)).length;
  const bad = s.filter((x) => ['failed', 'retry_required'].includes(x)).length;
  const status = bad === 0 ? 'completed' : ok === 0 ? 'failed' : 'partially_failed';
  await pool.execute('UPDATE action_plans SET status = ? WHERE id = ?', [status, planId]);
  await recordAudit(pool, { action: `action_plan.${status}`, entityType: 'action_plan', entityId: planId, after: { succeeded: ok, failed: bad } });
  if (bad) {
    const [[p]] = await pool.query('SELECT requested_by, approved_by, title FROM action_plans WHERE id = ?', [planId]);
    for (const userId of new Set([p.requested_by, p.approved_by].filter(Boolean))) {
      await notify(pool, { userId, kind: 'action_execution', title: `${bad} of ${s.length} actions failed: ${p.title}`, body: 'Open the plan to see the error and retry.', link: `/approvals?plan=${planId}`, entityType: 'action_plan', entityId: planId, dedupeKey: `plan-failed:${planId}:${bad}` });
    }
  }
  return { status, succeeded: ok, failed: bad };
}

/** Executions that succeeded but could not be read back yet (e.g. calendar invitations): check again. */
export async function verifyPending({ limit = 50 } = {}) {
  const [rows] = await pool.query("SELECT * FROM action_executions WHERE status = 'succeeded' AND verified_at IS NULL AND executed_at >= NOW() - INTERVAL 2 DAY ORDER BY id LIMIT ?", [limit]);
  let verified = 0;
  for (const row of rows) {
    const x = { ...row, target: parse(row.target), payload: parse(row.payload), result: parse(row.result) };
    const ex = EXECUTORS[x.kind];
    if (!ex?.verify) continue;
    const [[plan]] = await pool.query('SELECT approved_by, requested_by FROM action_plans WHERE id = ?', [x.plan_id]);
    const approver = (await userById(plan?.approved_by)) ?? (await userById(plan?.requested_by));
    const ok = await ex.verify(x, { externalId: x.external_id, externalKey: x.external_key, details: x.result }, { approver }).catch(() => false);
    if (ok === true) {
      await pool.execute("UPDATE action_executions SET status = 'verified', verified_at = NOW() WHERE id = ? AND status = 'succeeded'", [x.id]);
      await recordAudit(pool, { action: 'action_execution.verified', entityType: 'action_execution', entityId: x.id });
      verified++;
    } else if (ok === 'failed') {
      await finish(x, 'failed', { error: 'The provider reported that the action did not complete' });
    }
  }
  return { checked: rows.length, verified };
}

// ---- reads -----------------------------------------------------------------------------------------

function planView(p, execs) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    origin: p.origin,
    status: p.status,
    commandId: p.command_id,
    preview: parse(p.preview),
    previewHash: p.status === 'awaiting_approval' ? p.preview_hash : undefined,
    itemCount: p.item_count,
    requestedBy: p.requested_by ? { id: p.requested_by, fullName: p.requester_name } : null,
    approvedBy: p.approved_by ? { id: p.approved_by, fullName: p.approver_name } : null,
    approvalBasis: p.approval_basis,
    approvedAt: p.approved_at,
    cancelUntil: p.cancel_until,
    createdAt: p.created_at,
    executions: execs.map((x) => ({
      id: x.id,
      actionItemId: x.action_item_id,
      itemIds: parse(x.payload)?.itemIds ?? (x.action_item_id ? [x.action_item_id] : []),
      kind: x.kind,
      provider: x.provider,
      status: x.status,
      attempts: x.attempts,
      maxAttempts: x.max_attempts,
      nextAttemptAt: x.next_attempt_at,
      lastError: x.last_error,
      externalId: x.external_id,
      externalKey: x.external_key,
      externalUrl: x.external_url,
      externalRecordId: x.external_record_id,
      executedAt: x.executed_at,
      verifiedAt: x.verified_at,
      target: parse(x.target),
    })),
  };
}

const PLAN_SELECT = `SELECT p.*, ur.full_name AS requester_name, ua.full_name AS approver_name FROM action_plans p
  LEFT JOIN users ur ON ur.id = p.requested_by LEFT JOIN users ua ON ua.id = p.approved_by`;

/** Plans the person requested or may decide (admins: all). */
export async function listPlans(user, { status, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status IN (?)');
    params.push(String(status).split(','));
  }
  if (user.role !== 'admin') {
    // Requested by them, or touching items of projects they own.
    where.push(`(p.requested_by = ? OR p.approved_by = ? OR EXISTS (SELECT 1 FROM action_executions x JOIN action_items ai ON ai.id = x.action_item_id JOIN projects pr ON pr.id = ai.project_id WHERE x.plan_id = p.id AND pr.owner_user_id = ?))`);
    params.push(user.id, user.id, user.id);
  }
  const [plans] = await pool.query(`${PLAN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.status = 'awaiting_approval' DESC, p.id DESC LIMIT ?`, [...params, limit]);
  if (!plans.length) return [];
  const [execs] = await pool.query('SELECT * FROM action_executions WHERE plan_id IN (?) ORDER BY id', [plans.map((p) => p.id)]);
  const byPlan = Map.groupBy(execs, (x) => x.plan_id);
  return plans.map((p) => planView(p, byPlan.get(p.id) ?? []));
}

export async function getPlan(user, planId) {
  const [[p]] = await pool.query(`${PLAN_SELECT} WHERE p.id = ?`, [planId]);
  if (!p) throw notFound('Plan not found');
  const [execs] = await pool.query('SELECT * FROM action_executions WHERE plan_id = ? ORDER BY id', [planId]);
  if (user.role !== 'admin' && p.requested_by !== user.id && p.approved_by !== user.id) {
    await assertMayDecide(user, p, execs.map((x) => ({ ...x, payload: parse(x.payload) }))).catch(() => {
      throw notFound('Plan not found');
    });
  }
  const [history] = await pool.query(
    `SELECT a.action, a.entity_type, a.entity_id, a.after_json, a.created_at, u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE (a.entity_type = 'action_plan' AND a.entity_id = ?)${execs.length ? " OR (a.entity_type = 'action_execution' AND a.entity_id IN (?))" : ''} ORDER BY a.id`,
    execs.length ? [planId, execs.map((x) => x.id)] : [planId],
  );
  return { plan: { ...planView(p, execs), history: history.map((h) => ({ action: h.action, entityType: h.entity_type, entityId: h.entity_id, actor: h.actor ?? 'WorkAgent', at: h.created_at, detail: parse(h.after_json) })) } };
}

/** The kinds this person can use now, with why others are unavailable (for the UI). */
export async function capabilities(user) {
  const out = [];
  for (const [kind, def] of Object.entries(KINDS)) {
    const problem = (await PLANNERS.availability?.(kind, user)) ?? null;
    out.push({ kind, label: def.label, provider: def.provider, providerLabel: def.providerLabel, available: !problem, problem, needsItems: Boolean(def.needsItems), options: def.options ?? [], targets: await PLANNERS.targets(kind) });
  }
  return { kinds: out, cancelSeconds: engineSettings.cancelSeconds(), largeThreshold: engineSettings.largeThreshold() };
}
