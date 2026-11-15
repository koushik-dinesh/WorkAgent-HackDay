// Deterministic KPI and profile computation from the work graph (Feature 5). No LLM is involved:
// every number is a count, ratio, median or weighted sum of stored events, and keeps the
// references of the events it came from.
//
// Missing data is explicit, never a zero: a metric is 'not_observable' when WorkAgent cannot see
// the underlying activity for this person (e.g. no linked GitHub account for reviews) and
// 'insufficient_data' when there are too few events to say anything. Events the person flagged as
// misattributed (kpi_corrections) are excluded.
import { pool } from '../../db/pool.js';
import { addDays } from '../../utils/dates.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const METRICS = {
  commitment_reliability: { label: 'Commitment reliability', unit: 'ratio', description: 'Commitments (tasks with a due date) completed on or before their due date' },
  cycle_time: { label: 'Cycle time', unit: 'hours', description: 'Median time from assignment to completion' },
  blocker_resolution: { label: 'Blocker resolution time', unit: 'hours', description: 'Median time a task of yours stayed blocked' },
  review_contribution: { label: 'Review contribution', unit: 'count', description: 'Pull-request reviews, review comments and design (Figma) comments' },
  collaboration_breadth: { label: 'Collaboration breadth', unit: 'count', description: 'Distinct colleagues worked with (meetings, reviews)' },
  rework_rate: { label: 'Rework rate', unit: 'ratio', description: 'Reopened tasks and reverted commits relative to completed work' },
  meeting_to_action: { label: 'Meeting-to-action conversion', unit: 'ratio', description: 'Meeting action items assigned to you that are done' },
  load_index: { label: 'Load index', unit: 'index', description: 'Open assigned work weighted by priority and age' },
};
export const MIN_SAMPLES = { commitment_reliability: 3, cycle_time: 3, blocker_resolution: 2, rework_rate: 3, meeting_to_action: 3 };

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 4) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
const ref = (type, id) => ({ type, id });

function result(key, { value = null, numerator = null, denominator = null, sample = 0, refs = [], details = {}, status = null }) {
  const st = status ?? (MIN_SAMPLES[key] && sample < MIN_SAMPLES[key] ? 'insufficient_data' : value === null ? 'insufficient_data' : 'ok');
  return { metricKey: key, value: st === 'ok' ? round(value) : null, numerator, denominator, sampleSize: sample, status: st, details, sourceRefs: refs.slice(0, 500) };
}

/** Everything about one person needed by the metrics, loaded once per period. */
async function loadContext(userId, start, end) {
  const [[u]] = await pool.query('SELECT id, role, job_title, department_id FROM users WHERE id = ?', [userId]);
  const [idents] = await pool.query('SELECT id, provider, external_user_id FROM external_identities WHERE user_id = ?', [userId]);
  const [excl] = await pool.query("SELECT source_type, source_id FROM kpi_corrections WHERE user_id = ? AND status = 'excluded'", [userId]);
  const excluded = new Set(excl.map((e) => `${e.source_type}:${e.source_id}`));
  return { user: u, identityIds: idents.map((i) => i.id), providers: new Set(idents.map((i) => i.provider)), jiraAccounts: idents.filter((i) => i.provider === 'jira').map((i) => i.external_user_id), excluded, start, end };
}
const keep = (ctx, type, id) => !ctx.excluded.has(`${type}:${id}`);

// ---- individual metrics ---------------------------------------------------------------------------

async function commitmentReliability(ctx) {
  const [tasks] = await pool.query(
    `SELECT ai.id, ai.due_date, (SELECT MIN(a.occurred_at) FROM activities a WHERE a.entity_type = 'action_item' AND a.entity_id = ai.id AND a.activity_type = 'completed') AS done_at
     FROM action_items ai WHERE ai.assignee_user_id = ? AND ai.review_status = 'approved' AND ai.due_date BETWEEN ? AND ?`,
    [ctx.user.id, iso(ctx.start), iso(ctx.end)],
  );
  const rows = tasks.filter((t) => keep(ctx, 'action_item', t.id)).map((t) => ({ r: ref('action_item', t.id), due: iso(t.due_date), done: t.done_at }));
  if (ctx.jiraAccounts.length) {
    const [issues] = await pool.query("SELECT id, metadata FROM external_records WHERE provider = 'jira' AND record_type = 'issue' AND source_deleted_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.dueDate')) BETWEEN ? AND ?", [iso(ctx.start), iso(ctx.end)]);
    for (const i of issues) {
      const m = parse(i.metadata);
      if (!(m.assignees ?? []).some((a) => ctx.jiraAccounts.includes(a.id)) || !keep(ctx, 'external_record', i.id)) continue;
      rows.push({ r: ref('external_record', i.id), due: m.dueDate, done: m.resolvedAt ? new Date(m.resolvedAt) : null });
    }
  }
  const onTime = rows.filter((x) => x.done && iso(x.done) <= x.due);
  return result('commitment_reliability', { value: rows.length ? onTime.length / rows.length : null, numerator: onTime.length, denominator: rows.length, sample: rows.length, refs: rows.map((x) => x.r), details: { late: rows.filter((x) => x.done && iso(x.done) > x.due).length, open: rows.filter((x) => !x.done).length } });
}

async function cycleTime(ctx) {
  const [done] = await pool.query(
    `SELECT a.entity_id AS id, MIN(a.occurred_at) AS done_at,
            (SELECT MAX(b.occurred_at) FROM activities b WHERE b.entity_type = 'action_item' AND b.entity_id = a.entity_id AND b.activity_type IN ('created','assigned') AND b.occurred_at <= MIN(a.occurred_at)) AS assigned_at
     FROM activities a JOIN action_items ai ON ai.id = a.entity_id
     WHERE a.entity_type = 'action_item' AND a.activity_type = 'completed' AND ai.assignee_user_id = ? AND a.occurred_at BETWEEN ? AND ?
     GROUP BY a.entity_id`,
    [ctx.user.id, ctx.start, ctx.end],
  );
  const samples = done.filter((d) => d.assigned_at && keep(ctx, 'action_item', d.id)).map((d) => ({ r: ref('action_item', d.id), h: (new Date(d.done_at) - new Date(d.assigned_at)) / HOUR }));
  if (ctx.identityIds.length) {
    const [prs] = await pool.query(
      `SELECT r.id, r.source_created_at, JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.mergedAt')) AS merged_at FROM external_records r
       WHERE r.provider = 'github' AND r.record_type = 'pull_request' AND r.author_identity_id IN (?) AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.mergedAt')) BETWEEN ? AND ?`,
      [ctx.identityIds, ctx.start.toISOString(), ctx.end.toISOString()],
    );
    for (const p of prs) if (keep(ctx, 'external_record', p.id) && p.source_created_at) samples.push({ r: ref('external_record', p.id), h: (new Date(p.merged_at) - new Date(p.source_created_at)) / HOUR });
  }
  const valid = samples.filter((s) => s.h >= 0);
  return result('cycle_time', { value: median(valid.map((s) => s.h)), sample: valid.length, refs: valid.map((s) => s.r), details: { p75: valid.length ? round([...valid.map((s) => s.h)].sort((a, b) => a - b)[Math.floor(valid.length * 0.75)], 2) : null } });
}

async function blockerResolution(ctx) {
  const [rows] = await pool.query(
    `SELECT a.entity_id AS id, a.activity_type, a.occurred_at FROM activities a JOIN action_items ai ON ai.id = a.entity_id
     WHERE a.entity_type = 'action_item' AND ai.assignee_user_id = ? AND a.activity_type IN ('blocked','started','completed','reopened','status_changed') AND a.occurred_at BETWEEN ? AND ?
     ORDER BY a.entity_id, a.occurred_at`,
    [ctx.user.id, new Date(ctx.start.getTime() - 30 * DAY), ctx.end],
  );
  const samples = [];
  let open = null;
  for (const r of rows) {
    if (!keep(ctx, 'action_item', r.id)) continue;
    if (open && open.id !== r.id) open = null;
    if (r.activity_type === 'blocked') open = { id: r.id, at: r.occurred_at };
    else if (open && new Date(r.occurred_at) >= ctx.start) {
      samples.push({ r: ref('action_item', r.id), h: (new Date(r.occurred_at) - new Date(open.at)) / HOUR });
      open = null;
    }
  }
  return result('blocker_resolution', { value: median(samples.map((s) => s.h)), sample: samples.length, refs: samples.map((s) => s.r) });
}

async function reviewContribution(ctx) {
  if (!ctx.providers.has('github') && !ctx.providers.has('figma')) return result('review_contribution', { status: 'not_observable', details: { reason: 'No linked GitHub or Figma account' } });
  const [rows] = await pool.query(
    `SELECT a.id, a.provider, a.activity_type, a.external_record_id FROM activities a
     WHERE a.actor_identity_id IN (?) AND a.occurred_at BETWEEN ? AND ?
       AND ((a.provider = 'github' AND a.activity_type IN ('review_submitted','commented') AND EXISTS (SELECT 1 FROM external_records r WHERE r.id = a.external_record_id AND r.record_type IN ('review','review_comment','comment')))
         OR (a.provider = 'figma' AND a.activity_type = 'commented'))`,
    [ctx.identityIds, ctx.start, ctx.end],
  );
  const kept = rows.filter((r) => keep(ctx, 'external_record', r.external_record_id));
  return result('review_contribution', { value: kept.length, sample: kept.length, refs: kept.map((r) => ref('external_record', r.external_record_id)), details: { pullRequestReviews: kept.filter((r) => r.provider === 'github').length, designComments: kept.filter((r) => r.provider === 'figma').length }, status: 'ok' });
}

async function collaborationBreadth(ctx) {
  const [meetingPeers] = await pool.query(
    `SELECT DISTINCT p2.user_id, p1.meeting_id FROM meeting_participants p1 JOIN meeting_participants p2 ON p2.meeting_id = p1.meeting_id AND p2.user_id <> p1.user_id
     JOIN meetings m ON m.id = p1.meeting_id WHERE p1.user_id = ? AND COALESCE(m.started_at, m.scheduled_at, m.created_at) BETWEEN ? AND ?`,
    [ctx.user.id, ctx.start, ctx.end],
  );
  let reviewPeers = [];
  if (ctx.identityIds.length) {
    [reviewPeers] = await pool.query(
      `SELECT DISTINCT i2.user_id, pr.id AS pr_id FROM activities a JOIN external_records rv ON rv.id = a.external_record_id JOIN external_records pr ON pr.id = rv.parent_record_id
       JOIN external_identities i2 ON i2.id = pr.author_identity_id
       WHERE a.actor_identity_id IN (?) AND a.activity_type = 'review_submitted' AND a.occurred_at BETWEEN ? AND ? AND i2.user_id IS NOT NULL AND i2.user_id <> ?`,
      [ctx.identityIds, ctx.start, ctx.end, ctx.user.id],
    );
  }
  const peers = new Set([...meetingPeers.filter((m) => keep(ctx, 'meeting', m.meeting_id)).map((m) => m.user_id), ...reviewPeers.map((r) => r.user_id)]);
  const [teams] = peers.size ? await pool.query('SELECT COUNT(DISTINCT team_id) AS n FROM team_members WHERE user_id IN (?)', [[...peers]]) : [[{ n: 0 }]];
  return result('collaboration_breadth', { value: peers.size, sample: meetingPeers.length + reviewPeers.length, refs: [...new Set(meetingPeers.map((m) => m.meeting_id))].map((id) => ref('meeting', id)), details: { distinctTeams: Number(teams[0].n), viaMeetings: new Set(meetingPeers.map((m) => m.user_id)).size, viaReviews: new Set(reviewPeers.map((r) => r.user_id)).size }, status: 'ok' });
}

async function reworkRate(ctx) {
  const [acts] = await pool.query(
    `SELECT a.entity_id AS id, a.activity_type FROM activities a JOIN action_items ai ON ai.id = a.entity_id
     WHERE a.entity_type = 'action_item' AND ai.assignee_user_id = ? AND a.activity_type IN ('completed','reopened') AND a.occurred_at BETWEEN ? AND ?`,
    [ctx.user.id, ctx.start, ctx.end],
  );
  const kept = acts.filter((a) => keep(ctx, 'action_item', a.id));
  const reopened = kept.filter((a) => a.activity_type === 'reopened');
  const completed = kept.filter((a) => a.activity_type === 'completed');
  let commits = [];
  if (ctx.providers.has('github')) {
    [commits] = await pool.query("SELECT id, title FROM external_records WHERE provider = 'github' AND record_type = 'commit' AND author_identity_id IN (?) AND source_created_at BETWEEN ? AND ?", [ctx.identityIds, ctx.start, ctx.end]);
    commits = commits.filter((c) => keep(ctx, 'external_record', c.id));
  }
  const reverts = commits.filter((c) => /^revert\b/i.test(c.title ?? ''));
  const denominator = completed.length + commits.length;
  return result('rework_rate', { value: denominator ? (reopened.length + reverts.length) / denominator : null, numerator: reopened.length + reverts.length, denominator, sample: denominator, refs: [...reopened.map((a) => ref('action_item', a.id)), ...reverts.map((c) => ref('external_record', c.id))], details: { reopenedTasks: reopened.length, revertedCommits: reverts.length, commitsObservable: ctx.providers.has('github') } });
}

async function meetingToAction(ctx) {
  const [rows] = await pool.query(
    `SELECT ai.id, ai.task_status FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id
     WHERE ai.assignee_user_id = ? AND ai.review_status = 'approved' AND ai.approved_at BETWEEN ? AND ?`,
    [ctx.user.id, ctx.start, ctx.end],
  );
  const kept = rows.filter((r) => keep(ctx, 'action_item', r.id));
  const done = kept.filter((r) => r.task_status === 'done');
  return result('meeting_to_action', { value: kept.length ? done.length / kept.length : null, numerator: done.length, denominator: kept.length, sample: kept.length, refs: kept.map((r) => ref('action_item', r.id)) });
}

const PRIORITY_WEIGHT = { low: 1, medium: 2, high: 3, lowest: 1, highest: 4, critical: 4 };
async function loadIndex(ctx) {
  const [tasks] = await pool.query("SELECT id, priority, approved_at, created_at FROM action_items WHERE assignee_user_id = ? AND review_status = 'approved' AND task_status <> 'done'", [ctx.user.id]);
  const items = tasks.filter((t) => keep(ctx, 'action_item', t.id)).map((t) => ({ r: ref('action_item', t.id), priority: t.priority, since: t.approved_at ?? t.created_at }));
  if (ctx.jiraAccounts.length) {
    const [issues] = await pool.query("SELECT id, metadata, source_created_at FROM external_records WHERE provider = 'jira' AND record_type = 'issue' AND source_deleted_at IS NULL AND status_category IN ('todo','in_progress')");
    for (const i of issues) {
      const m = parse(i.metadata);
      if ((m.assignees ?? []).some((a) => ctx.jiraAccounts.includes(a.id)) && keep(ctx, 'external_record', i.id)) items.push({ r: ref('external_record', i.id), priority: String(m.priority ?? 'medium').toLowerCase(), since: i.source_created_at });
    }
  }
  const weight = (x) => (PRIORITY_WEIGHT[x.priority] ?? 2) * (1 + Math.min(Math.max(0, (ctx.end - new Date(x.since ?? ctx.end)) / DAY), 30) / 30);
  const value = items.reduce((s, x) => s + weight(x), 0);
  return result('load_index', { value, sample: items.length, refs: items.map((x) => x.r), details: { openItems: items.length, highPriority: items.filter((x) => ['high', 'highest', 'critical'].includes(x.priority)).length, olderThan30Days: items.filter((x) => (ctx.end - new Date(x.since ?? ctx.end)) / DAY > 30).length }, status: 'ok' });
}

/** All eight metrics for one person and period ending `endDate` (YYYY-MM-DD, inclusive). */
export async function computeMetrics(userId, endDate, periodDays) {
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const start = new Date(`${addDays(endDate, -(periodDays - 1))}T00:00:00Z`);
  const ctx = await loadContext(userId, start, end);
  return Promise.all([commitmentReliability(ctx), cycleTime(ctx), blockerResolution(ctx), reviewContribution(ctx), collaborationBreadth(ctx), reworkRate(ctx), meetingToAction(ctx), loadIndex(ctx)]);
}

// ---- profile dimensions ---------------------------------------------------------------------------

/** Activities by this person (internal: actor_user_id; external: their identities). */
async function ownActivities(userId, start, end) {
  const [idents] = await pool.query('SELECT id FROM external_identities WHERE user_id = ?', [userId]);
  const [rows] = await pool.query(
    `SELECT a.provider, a.activity_type, a.entity_type, a.entity_id, a.external_record_id, a.project_id, a.occurred_at FROM activities a
     WHERE (a.actor_user_id = ?${idents.length ? ' OR a.actor_identity_id IN (?)' : ''}) AND a.occurred_at BETWEEN ? AND ?`,
    [userId, ...(idents.length ? [idents.map((i) => i.id)] : []), start, end],
  );
  return rows;
}

const BUILD = new Set(['completed', 'committed', 'merged']);
const REVIEW = new Set(['review_submitted', 'commented']);
const COORD = new Set(['created', 'assigned', 'review_completed', 'scheduled', 'conducted']);

export async function computeProfile(userId, endDate, metricsByPeriod, peers) {
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const start28 = new Date(end.getTime() - 28 * DAY);
  const acts = await ownActivities(userId, start28, end);
  const out = [];
  // Work pattern: distinct items touched per active day.
  const byDay = new Map();
  for (const a of acts) {
    const d = new Date(a.occurred_at).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, new Set()).get(d)).add(a.external_record_id ? `r${a.external_record_id}` : `${a.entity_type}${a.entity_id}`);
  }
  const perDay = byDay.size ? [...byDay.values()].reduce((s, x) => s + x.size, 0) / byDay.size : null;
  out.push(byDay.size < 5 ? { dimension: 'work_pattern', value: 'insufficient_data', details: { activeDays: byDay.size } } : { dimension: 'work_pattern', value: perDay <= 2 ? 'focused' : perDay <= 4 ? 'mixed' : 'fragmented', details: { activeDays: byDay.size, itemsPerActiveDay: round(perDay, 2), basis: 'Distinct work items touched per active day (no time or activity tracking)' } });
  // Role tendency: the mix of what the person does.
  const counts = { builder: acts.filter((a) => BUILD.has(a.activity_type)).length, reviewer: acts.filter((a) => REVIEW.has(a.activity_type)).length, coordinator: acts.filter((a) => COORD.has(a.activity_type) && a.entity_type).length };
  const [[unblock]] = await pool.query(
    `SELECT COUNT(*) AS n FROM audit_logs al JOIN action_items ai ON ai.id = al.entity_id
     WHERE al.action = 'task.status_changed' AND al.actor_user_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(al.before_json, '$.taskStatus')) = 'blocked'
       AND (ai.assignee_user_id IS NULL OR ai.assignee_user_id <> ?) AND al.created_at BETWEEN ? AND ?`,
    [userId, userId, start28, end],
  );
  counts.unblocker = Number(unblock.n);
  const total = Object.values(counts).reduce((s, x) => s + x, 0);
  const projects = new Set(acts.map((a) => a.project_id).filter(Boolean));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  out.push(total < 5 ? { dimension: 'role_tendency', value: 'insufficient_data', details: { counts } } : { dimension: 'role_tendency', value: top[1] / total >= 0.5 ? (top[0] === 'builder' && projects.size === 1 ? 'specialist' : top[0]) : 'mixed', details: { counts, projects: projects.size } });
  // Reliability band, against the person's own team or role peers (never the company).
  const rel = metricsByPeriod[84]?.find((m) => m.metricKey === 'commitment_reliability');
  if (!rel || rel.status !== 'ok') out.push({ dimension: 'reliability_band', value: 'insufficient_data', details: {} });
  else if (peers.length >= 5) {
    const below = peers.filter((p) => p < rel.value).length;
    const pct = below / peers.length;
    out.push({ dimension: 'reliability_band', value: pct >= 2 / 3 ? 'consistent' : pct >= 1 / 3 ? 'typical' : 'variable', details: { comparedWith: 'team or role peers', peers: peers.length } });
  } else out.push({ dimension: 'reliability_band', value: rel.value >= 0.8 ? 'consistent' : rel.value >= 0.5 ? 'typical' : 'variable', details: { comparedWith: 'absolute thresholds (peer group smaller than 5)', value: rel.value } });
  // Growth trend: completed work and reliability, last 4 vs previous 4 weeks, last 12 vs previous 12.
  for (const [weeks, dim] of [[4, 'growth_trend_4w'], [12, 'growth_trend_12w']]) {
    const span = weeks * 7 * DAY;
    const [[c]] = await pool.query(
      `SELECT SUM(a.occurred_at > ?) AS recent, SUM(a.occurred_at <= ?) AS prior FROM activities a JOIN action_items ai ON ai.id = a.entity_id
       WHERE a.entity_type = 'action_item' AND a.activity_type = 'completed' AND ai.assignee_user_id = ? AND a.occurred_at BETWEEN ? AND ?`,
      [new Date(end - span), new Date(end - span), userId, new Date(end - 2 * span), end],
    );
    const recent = Number(c.recent ?? 0);
    const prior = Number(c.prior ?? 0);
    if (recent + prior < 4) out.push({ dimension: dim, value: 'insufficient_data', details: { recent, prior } });
    else out.push({ dimension: dim, value: recent > prior * 1.2 ? 'rising' : recent < prior * 0.8 ? 'declining' : 'steady', details: { recent, prior, basis: 'Completed tasks in each period' } });
  }
  return out;
}
