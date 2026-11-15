// What actually happened to a commitment, from the work graph (deterministic, no AI).
//
// An action item is linked to Jira issues, GitHub issues/PRs/commits and Figma files through
// record_links (explicit references found by the correlation engine, links people confirmed, and
// the external objects WorkAgent created for it). Their state is evidence:
//   Jira issue done / GitHub PR merged or issue closed          -> completion evidence
//   Jira issue in progress / PR open / commit / Figma version    -> progress evidence
//   a Teams message classified as a blocker about the same work  -> blocker evidence (sourceExtraction)
// Evidence is added to the item's trail and flagged for the reviewer/owner. The item's own status
// is never changed here: a person confirms that the work is done.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as actionItems from '../../repositories/actionItemsRepository.js';
import { recordAudit } from '../audit.js';

const WORK_TYPES = ['issue', 'pull_request', 'commit', 'design_file', 'version'];

/** Linked work records of the given items (links not rejected), with their state. */
export async function linkedWork(itemIds, conn = pool) {
  if (!itemIds.length) return new Map();
  const [rows] = await conn.query(
    `SELECT l.id AS link_id, l.link_type, l.status AS link_status, l.origin,
            IF(l.from_type = 'action_item', l.from_id, l.to_id) AS item_id,
            er.id, er.provider, er.record_type, er.external_key, er.title, er.url, er.state, er.status_category,
            COALESCE(er.source_updated_at, er.source_created_at) AS updated_at
       FROM record_links l
       JOIN external_records er ON er.id = IF(l.from_type = 'action_item', l.to_id, l.from_id)
      WHERE l.status <> 'rejected' AND er.source_deleted_at IS NULL AND er.record_type IN (?)
        AND ((l.from_type = 'action_item' AND l.from_id IN (?) AND l.to_type = 'external_record')
          OR (l.to_type = 'action_item' AND l.to_id IN (?) AND l.from_type = 'external_record'))`,
    [WORK_TYPES, itemIds, itemIds],
  );
  return Map.groupBy(rows, (r) => r.item_id);
}

/** completion | progress | null for one linked record. */
export function signalOf(r) {
  if (r.record_type === 'pull_request') return r.state === 'merged' || r.status_category === 'done' ? 'completion' : 'progress';
  if (r.record_type === 'issue') return r.status_category === 'done' ? 'completion' : r.status_category === 'in_progress' ? 'progress' : null;
  if (['commit', 'version'].includes(r.record_type)) return 'progress';
  if (r.record_type === 'design_file') return 'progress';
  return null;
}

const describe = (r) => {
  const name = `${r.external_key ? `${r.external_key} ` : ''}${r.title ?? ''}`.trim() || r.record_type;
  if (r.record_type === 'pull_request') return `${r.provider === 'github' ? 'GitHub pull request' : 'Pull request'} “${name}” is ${r.state ?? r.status_category}`;
  if (r.record_type === 'issue') return `${r.provider === 'jira' ? 'Jira issue' : 'GitHub issue'} ${name} is ${r.state ?? r.status_category}`;
  if (r.record_type === 'commit') return `Commit “${name}”`;
  return `${r.provider} ${r.record_type.replaceAll('_', ' ')} “${name}”`;
};

/**
 * Summary of the real state of the work behind an item:
 *   { status: 'not_started'|'in_progress'|'implementation_complete'|'blocked'|'done', signals: [...] }
 */
export function workStatus(item, linked = []) {
  const signals = linked.map((r) => ({ recordId: r.id, provider: r.provider, recordType: r.record_type, key: r.external_key, title: r.title, url: r.url, state: r.state, signal: signalOf(r), linkStatus: r.link_status, text: describe(r) }));
  if (item.taskStatus === 'done') return { status: 'done', signals };
  if (item.taskStatus === 'blocked' || (item.flags ?? []).includes('blocker_reported')) return { status: 'blocked', signals };
  if (signals.some((s) => s.signal === 'completion')) return { status: 'implementation_complete', signals };
  if (signals.some((s) => s.signal === 'progress') || item.taskStatus === 'in_progress') return { status: 'in_progress', signals };
  return { status: 'not_started', signals };
}

/** Adds progress/completion evidence for open items with linked work. Idempotent. */
export async function refresh({ limit = 500 } = {}) {
  const [items] = await pool.query("SELECT id, flags FROM action_items WHERE review_status <> 'rejected' AND task_status <> 'done' ORDER BY id DESC LIMIT ?", [limit]);
  if (!items.length) return { checked: 0, evidence: 0 };
  const links = await linkedWork(items.map((i) => i.id));
  let evidence = 0;
  for (const item of items) {
    const linked = links.get(item.id) ?? [];
    const rows = linked.map((r) => ({ r, signal: signalOf(r) })).filter((x) => x.signal);
    if (!rows.length) continue;
    await withTransaction(async (conn) => {
      let added = 0;
      for (const { r, signal } of rows) {
        added += await actionItems.addEvidence(conn, item.id, [{ excerpt: describe(r), speaker: null, recordId: r.id, sourceUrl: r.url, occurredAt: r.updated_at, relation: signal }]);
      }
      if (added) {
        const flags = typeof item.flags === 'string' ? JSON.parse(item.flags) : item.flags ?? [];
        if (rows.some((x) => x.signal === 'completion')) await actionItems.setFlags(conn, item.id, [...flags, 'completion_evidence']);
        await recordAudit(conn, { action: 'action_item.progress_evidence', entityType: 'action_item', entityId: item.id, after: { records: rows.map((x) => ({ id: x.r.id, signal: x.signal })) } });
        evidence += added;
      }
    });
  }
  return { checked: items.length, evidence };
}
