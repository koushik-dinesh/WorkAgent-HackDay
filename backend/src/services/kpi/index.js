// Employee KPI tracking and work profiling (Feature 5), with its privacy controls built in.
//
// Off until BOTH: an admin records organisation consent (and turns it on), and each employee has
// read and acknowledged the notice. Nothing is computed for anyone who has not.
//
// Never collected or produced: keystrokes, screen activity, idle time, after-hours tracking, a
// composite productivity score, rankings, or automated employment/performance decisions. Metrics
// are advisory context for a conversation, and the UI says so.
//
// Who sees what:
//   the employee     everything about themselves first: metrics, profile, the source events behind
//                    each metric, who viewed their data (access log); they can flag misattributed
//                    events, which are excluded at once
//   team lead        (manager role, teams they lead) their team's roll-up, workload balance, blocked
//                    work, review contribution; each individual view is logged and visible to the
//                    employee
//   HR / admins      aggregates by department and team only, and only for groups of at least the
//                    minimum size (default 5); an individual drill-down needs a written reason,
//                    is logged, and the employee is notified
// Retention: metrics, profiles and access logs older than the retention period are deleted
// nightly; a deactivated (exited) employee's KPI data is deleted at the next run, or at once by an
// admin.
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import { addDays, localDate } from '../../utils/dates.js';
import { AppError, badRequest, forbidden, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { audit, recordAudit } from '../audit.js';
import { notify } from '../notifications/inbox.js';
import { isAdmin } from '../permissions.js';
import { resolveRefs } from '../records/refs.js';
import { computeMetrics, computeProfile, METRICS } from './metrics.js';

export const JOB_TYPE = 'kpi.compute';
export const PERIODS = [28, 84];
export const NEVER_COLLECTED = [
  'Keystrokes, mouse or screen activity',
  'Idle time or online/offline status',
  'After-hours activity tracking',
  'A single productivity score or any ranking of people',
  'Automated employment, pay or performance decisions',
];
const DEFAULT_NOTICE = [
  'WorkAgent can describe how work flows using events already in its work graph: tasks from meetings, Jira issues, GitHub pull requests and reviews, Figma comments and meetings.',
  'It computes eight descriptive metrics (commitment reliability, cycle time, blocker resolution time, review contribution, collaboration breadth, rework rate, meeting-to-action conversion and load index) and a descriptive profile.',
  'You see your own data first, including every event behind each number, and you can flag events that were wrongly attributed to you; they are excluded at once.',
  'Your team lead can see your metrics; every view is logged and shown to you. HR sees only aggregates of groups of five or more; an individual view by HR needs a written reason, is logged, and you are notified.',
  'The metrics are advisory context for conversations. They are never used for automated decisions, and there is no overall score or ranking.',
].join('\n\n');
export const DEFAULT_SETTINGS = { enabled: false, orgConsent: null, noticeVersion: 1, noticeText: DEFAULT_NOTICE, retentionDays: 365, minTeamSize: 5 };

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

// ---- settings, consent, notice --------------------------------------------------------------------

export async function getSettings(conn = pool) {
  const [[row]] = await conn.query("SELECT value FROM app_settings WHERE setting_key = 'kpi'");
  return { ...DEFAULT_SETTINGS, ...(row ? parse(row.value) : {}) };
}
async function saveSettings(value, actorId, conn = pool) {
  await conn.execute("INSERT INTO app_settings (setting_key, value, updated_by) VALUES ('kpi', ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)", [JSON.stringify(value), actorId]);
}
export const isActive = (s) => Boolean(s.enabled && s.orgConsent);
export const isHr = (user) => isAdmin(user) || Boolean(user?.hrAccess);

/** The person-facing state: is profiling on, has this person acknowledged the notice. */
export async function status(user) {
  const s = await getSettings();
  const [[ack]] = await pool.query('SELECT notice_version, acknowledged_at FROM kpi_employee_notices WHERE user_id = ?', [user.id]);
  const acknowledged = Boolean(ack && ack.notice_version >= s.noticeVersion);
  const [leads] = await pool.query('SELECT id, name FROM teams WHERE lead_user_id = ?', [user.id]);
  return {
    enabled: isActive(s),
    orgConsent: s.orgConsent ? { at: s.orgConsent.at, statement: s.orgConsent.statement } : null,
    notice: { version: s.noticeVersion, text: s.noticeText },
    acknowledged,
    acknowledgedAt: ack?.acknowledged_at ?? null,
    neverCollected: NEVER_COLLECTED,
    advisory: 'These metrics are advisory context for a conversation. They are not a score and are never used for automated decisions.',
    access: { self: true, teams: user.role === 'manager' || isAdmin(user) ? leads.map((t) => ({ id: t.id, name: t.name })) : [], hr: isHr(user), admin: isAdmin(user) },
    minTeamSize: s.minTeamSize,
    retentionDays: s.retentionDays,
  };
}

export async function recordConsent(user, { statement }, ip) {
  if (!isAdmin(user)) throw forbidden();
  const s = await getSettings();
  const next = { ...s, orgConsent: { at: new Date().toISOString(), by: user.id, statement } };
  await saveSettings(next, user.id);
  await audit({ actorUserId: user.id, action: 'kpi.org_consent_recorded', entityType: 'settings', after: { statement }, ip });
  return status(user);
}

export async function withdrawConsent(user, ip) {
  if (!isAdmin(user)) throw forbidden();
  const s = await getSettings();
  await saveSettings({ ...s, orgConsent: null, enabled: false }, user.id);
  await audit({ actorUserId: user.id, action: 'kpi.org_consent_withdrawn', entityType: 'settings', ip });
  return status(user);
}

export async function updateSettings(user, patch, ip) {
  if (!isAdmin(user)) throw forbidden();
  const s = await getSettings();
  if (patch.enabled && !s.orgConsent) throw new AppError(409, 'KPI_CONSENT_REQUIRED', 'Record the organisation’s consent before turning KPI tracking on');
  const next = { ...s, ...patch };
  // A changed notice must be acknowledged again by everyone before anything more is computed.
  if (patch.noticeText !== undefined && patch.noticeText !== s.noticeText) next.noticeVersion = s.noticeVersion + 1;
  await saveSettings(next, user.id);
  await audit({ actorUserId: user.id, action: 'kpi.settings_updated', entityType: 'settings', before: { enabled: s.enabled, retentionDays: s.retentionDays, minTeamSize: s.minTeamSize, noticeVersion: s.noticeVersion }, after: { enabled: next.enabled, retentionDays: next.retentionDays, minTeamSize: next.minTeamSize, noticeVersion: next.noticeVersion }, ip });
  return status(user);
}

export async function acknowledgeNotice(user, ip) {
  const s = await getSettings();
  await pool.execute('INSERT INTO kpi_employee_notices (user_id, notice_version) VALUES (?, ?) ON DUPLICATE KEY UPDATE notice_version = VALUES(notice_version), acknowledged_at = NOW()', [user.id, s.noticeVersion]);
  await audit({ actorUserId: user.id, action: 'kpi.notice_acknowledged', entityType: 'user', entityId: user.id, after: { noticeVersion: s.noticeVersion }, ip });
  return status(user);
}

// ---- computation (nightly job) --------------------------------------------------------------------

async function eligibleUsers(s, conn = pool) {
  const [rows] = await conn.query('SELECT u.id FROM users u JOIN kpi_employee_notices n ON n.user_id = u.id WHERE u.is_active = TRUE AND n.notice_version >= ?', [s.noticeVersion]);
  return rows.map((r) => r.id);
}

/** Peer reliability values for a person: same team(s), else same job title (never company-wide). */
async function peerValues(userId, endDate) {
  const [rows] = await pool.query(
    `SELECT DISTINCT m.user_id, m.value FROM employee_metrics m
     WHERE m.metric_key = 'commitment_reliability' AND m.period_days = 84 AND m.period_end = ? AND m.status = 'ok' AND m.user_id <> ?
       AND (m.user_id IN (SELECT tm2.user_id FROM team_members tm1 JOIN team_members tm2 ON tm2.team_id = tm1.team_id WHERE tm1.user_id = ?)
         OR m.user_id IN (SELECT u2.id FROM users u1 JOIN users u2 ON u2.job_title = u1.job_title WHERE u1.id = ? AND u1.job_title IS NOT NULL))`,
    [endDate, userId, userId, userId],
  );
  return rows.map((r) => Number(r.value));
}

async function storeMetrics(userId, endDate, days, metrics) {
  for (const m of metrics) {
    await pool.execute(
      `INSERT INTO employee_metrics (user_id, metric_key, period_end, period_days, value, numerator, denominator, sample_size, status, details, source_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), numerator = VALUES(numerator), denominator = VALUES(denominator), sample_size = VALUES(sample_size),
         status = VALUES(status), details = VALUES(details), source_refs = VALUES(source_refs), computed_at = NOW()`,
      [userId, m.metricKey, endDate, days, m.value, m.numerator, m.denominator, m.sampleSize, m.status, JSON.stringify(m.details), JSON.stringify(m.sourceRefs)],
    );
  }
}

/** Computes one person's metrics (both periods) and profile for the period ending `endDate`. */
export async function computeFor(userId, endDate) {
  const byPeriod = {};
  for (const days of PERIODS) {
    byPeriod[days] = await computeMetrics(userId, endDate, days);
    await storeMetrics(userId, endDate, days, byPeriod[days]);
  }
  const profile = await computeProfile(userId, endDate, byPeriod, await peerValues(userId, endDate));
  for (const p of profile) {
    await pool.execute(
      'INSERT INTO employee_profiles (user_id, dimension, value, details, period_end) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), details = VALUES(details), computed_at = NOW()',
      [userId, p.dimension, p.value, JSON.stringify(p.details ?? {}), endDate],
    );
  }
}

/** Nightly job: retention and exit deletion always; computation only when consent conditions hold. */
export async function runNightly({ now = new Date() } = {}) {
  const s = await getSettings();
  const purged = await purge(s);
  if (!isActive(s)) return { computed: 0, skipped: 'KPI tracking is off (organisation consent or setting missing)', ...purged };
  const endDate = addDays(localDate(now, config.features.orgTimeZone), -1);
  const users = await eligibleUsers(s);
  // Two passes so peer comparisons (reliability band) see everyone's fresh values.
  for (const u of users) for (const days of PERIODS) await storeMetrics(u, endDate, days, await computeMetrics(u, endDate, days));
  let n = 0;
  for (const u of users) {
    try {
      await computeFor(u, endDate);
      n += 1;
    } catch (err) {
      logger.error('kpi computation failed for a person', { userId: u, error: err.message });
    }
  }
  await audit({ action: 'kpi.computed', entityType: 'settings', after: { people: n, periodEnd: endDate, ...purged } });
  return { computed: n, periodEnd: endDate, ...purged };
}

export async function purge(s) {
  const [a] = await pool.execute('DELETE FROM employee_metrics WHERE period_end < DATE_SUB(CURDATE(), INTERVAL ? DAY)', [s.retentionDays]);
  const [b] = await pool.execute('DELETE FROM employee_profiles WHERE period_end < DATE_SUB(CURDATE(), INTERVAL ? DAY)', [s.retentionDays]);
  const [c] = await pool.execute('DELETE FROM kpi_access_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [s.retentionDays]);
  // Exit: deactivated people's KPI data goes away.
  const [inactive] = await pool.query('SELECT id FROM users WHERE is_active = FALSE AND (id IN (SELECT user_id FROM employee_metrics) OR id IN (SELECT user_id FROM employee_profiles) OR id IN (SELECT user_id FROM kpi_corrections))');
  for (const u of inactive) await deleteEmployeeData(u.id);
  return { purgedMetrics: a.affectedRows, purgedProfiles: b.affectedRows, purgedAccessLog: c.affectedRows, exitedDeleted: inactive.length };
}

export async function deleteEmployeeData(userId, { actorId = null, ip = null } = {}) {
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM employee_metrics WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM employee_profiles WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM kpi_corrections WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM kpi_employee_notices WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM kpi_access_log WHERE subject_user_id = ?', [userId]);
    await recordAudit(conn, { actorUserId: actorId, action: 'kpi.employee_data_deleted', entityType: 'user', entityId: userId, ip });
  });
}

export async function queueCompute(actorId) {
  try {
    const id = await queue.enqueue(JOB_TYPE, { actorId }, { dedupeKey: JOB_TYPE });
    return { jobId: id };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { jobId: null, alreadyQueued: true };
    throw err;
  }
}

// ---- reading ---------------------------------------------------------------------------------------

async function latestPeriodEnd(userId) {
  const [[r]] = await pool.query('SELECT MAX(period_end) AS d FROM employee_metrics WHERE user_id = ?', [userId]);
  return r?.d ? new Date(r.d).toISOString().slice(0, 10) : null;
}

async function personView(userId) {
  const end = await latestPeriodEnd(userId);
  const [[u]] = await pool.query('SELECT id, full_name, job_title FROM users WHERE id = ?', [userId]);
  if (!end) return { person: { id: u.id, fullName: u.full_name, jobTitle: u.job_title }, periodEnd: null, metrics: [], profile: [], trend: [] };
  const [metrics] = await pool.query('SELECT * FROM employee_metrics WHERE user_id = ? AND period_end = ? ORDER BY period_days, metric_key', [userId, end]);
  const [profile] = await pool.query('SELECT dimension, value, details FROM employee_profiles WHERE user_id = ? AND period_end = ?', [userId, end]);
  const [trend] = await pool.query("SELECT period_end, metric_key, value, status FROM employee_metrics WHERE user_id = ? AND period_days = 28 AND period_end >= DATE_SUB(?, INTERVAL 84 DAY) ORDER BY period_end", [userId, end]);
  return {
    person: { id: u.id, fullName: u.full_name, jobTitle: u.job_title },
    periodEnd: end,
    metrics: metrics.map((m) => ({ key: m.metric_key, ...METRICS[m.metric_key], periodDays: m.period_days, value: m.value === null ? null : Number(m.value), numerator: m.numerator === null ? null : Number(m.numerator), denominator: m.denominator === null ? null : Number(m.denominator), sampleSize: m.sample_size, status: m.status, details: parse(m.details), sourceCount: (parse(m.source_refs) ?? []).length })),
    profile: profile.map((p) => ({ dimension: p.dimension, value: p.value, details: parse(p.details) })),
    trend: trend.map((t) => ({ periodEnd: new Date(t.period_end).toISOString().slice(0, 10), key: t.metric_key, value: t.value === null ? null : Number(t.value), status: t.status })),
  };
}

/** The employee's own dashboard (always available to them once they acknowledged the notice). */
export async function myDashboard(user) {
  const st = await status(user);
  if (!st.acknowledged) return { status: st, data: null };
  const [log] = await pool.query(
    `SELECT l.scope, l.reason, l.created_at, u.full_name AS viewer FROM kpi_access_log l LEFT JOIN users u ON u.id = l.viewer_user_id
     WHERE l.subject_user_id = ? ORDER BY l.id DESC LIMIT 100`,
    [user.id],
  );
  const [corrections] = await pool.query('SELECT id, source_type, source_id, reason, status, created_at, restored_at FROM kpi_corrections WHERE user_id = ? ORDER BY id DESC', [user.id]);
  return {
    status: st,
    data: await personView(user.id),
    accessLog: log.map((l) => ({ scope: l.scope, reason: l.reason, viewer: l.viewer, at: l.created_at })),
    corrections: corrections.map((c) => ({ id: c.id, sourceType: c.source_type, sourceId: c.source_id, reason: c.reason, status: c.status, createdAt: c.created_at, restoredAt: c.restored_at })),
  };
}

/** The events behind one metric, as readable summaries. */
export async function metricSources(user, subjectId, metricKey, periodDays) {
  if (!METRICS[metricKey]) throw badRequest('Unknown metric');
  const end = await latestPeriodEnd(subjectId);
  if (!end) return { sources: [] };
  const [[m]] = await pool.query('SELECT source_refs FROM employee_metrics WHERE user_id = ? AND metric_key = ? AND period_days = ? AND period_end = ?', [subjectId, metricKey, periodDays, end]);
  const refs = parse(m?.source_refs) ?? [];
  const map = await resolveRefs(refs);
  const [corr] = await pool.query("SELECT source_type, source_id FROM kpi_corrections WHERE user_id = ? AND status = 'excluded'", [subjectId]);
  const excluded = new Set(corr.map((c) => `${c.source_type}:${c.source_id}`));
  return { sources: refs.map((r) => ({ ref: r, summary: map.get(`${r.type}:${r.id}`) ?? null, excluded: excluded.has(`${r.type}:${r.id}`) })) };
}

/** Misattribution: the person excludes an event from their own metrics; recomputed at once. */
export async function flagEvent(user, { sourceType, sourceId, reason }, ip) {
  await pool.execute("INSERT INTO kpi_corrections (user_id, source_type, source_id, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = 'excluded', reason = VALUES(reason), restored_at = NULL", [user.id, sourceType, sourceId, reason]);
  await audit({ actorUserId: user.id, action: 'kpi.event_flagged', entityType: 'user', entityId: user.id, after: { sourceType, sourceId, reason }, ip });
  const end = await latestPeriodEnd(user.id);
  if (end) await computeFor(user.id, end);
  return myDashboard(user);
}

export async function restoreEvent(user, correctionId, ip) {
  const [r] = await pool.execute("UPDATE kpi_corrections SET status = 'restored', restored_at = NOW() WHERE id = ? AND user_id = ?", [correctionId, user.id]);
  if (!r.affectedRows) throw notFound('Correction not found');
  await audit({ actorUserId: user.id, action: 'kpi.event_restored', entityType: 'user', entityId: user.id, after: { correctionId }, ip });
  const end = await latestPeriodEnd(user.id);
  if (end) await computeFor(user.id, end);
  return myDashboard(user);
}

async function logAccess(viewer, subjectId, scope, { reason = null, teamId = null, notifySubject = false } = {}) {
  await pool.execute('INSERT INTO kpi_access_log (viewer_user_id, subject_user_id, scope, team_id, reason) VALUES (?, ?, ?, ?, ?)', [viewer.id, subjectId, scope, teamId, reason]);
  if (notifySubject && subjectId !== viewer.id) {
    await notify(pool, { userId: subjectId, kind: 'kpi_viewed', title: `${viewer.fullName} viewed your work metrics`, body: reason ? `Reason given: ${reason}` : null, link: '/my/kpi', entityType: 'user', entityId: subjectId, dedupeKey: `kpi_view:${viewer.id}:${new Date().toISOString().slice(0, 13)}` });
  }
}

async function eligibleSet(s) {
  return new Set(await eligibleUsers(s));
}

async function teamFor(user, teamId) {
  const [[t]] = await pool.query('SELECT id, name, lead_user_id FROM teams WHERE id = ?', [teamId]);
  if (!t) throw notFound('Team not found');
  if (!(isAdmin(user) || (user.role === 'manager' && t.lead_user_id === user.id))) throw forbidden('Only the team lead can see this team’s metrics');
  const [members] = await pool.query('SELECT u.id, u.full_name, u.job_title FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND u.is_active = TRUE AND u.id <> ? ORDER BY u.full_name', [teamId, t.lead_user_id ?? 0]);
  return { team: t, members };
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Manager dashboard: the team's roll-up and each member (each member view is logged). */
export async function teamDashboard(user, teamId) {
  const s = await getSettings();
  if (!isActive(s)) throw new AppError(409, 'KPI_DISABLED', 'KPI tracking is off');
  const { team, members } = await teamFor(user, teamId);
  const eligible = await eligibleSet(s);
  const people = [];
  for (const m of members.filter((x) => eligible.has(x.id))) {
    const view = await personView(m.id);
    people.push(view);
    await logAccess(user, m.id, 'manager_view', { teamId });
  }
  const metric = (p, k, d = 28) => p.metrics.find((x) => x.key === k && x.periodDays === d);
  const okValues = (k) => people.map((p) => metric(p, k)).filter((x) => x?.status === 'ok').map((x) => x.value);
  const aggregateAllowed = people.length >= s.minTeamSize;
  const loads = people.map((p) => ({ person: p.person, load: metric(p, 'load_index')?.value ?? null, open: metric(p, 'load_index')?.details?.openItems ?? 0 }));
  const meanLoad = avg(loads.map((l) => l.load).filter((x) => x !== null));
  const [blocked] = await pool.query(
    `SELECT ai.id, ai.title, u.full_name AS assignee FROM action_items ai JOIN users u ON u.id = ai.assignee_user_id
     WHERE ai.task_status = 'blocked' AND ai.review_status = 'approved' AND ai.assignee_user_id IN (?)`,
    [members.length ? members.map((m) => m.id) : [0]],
  );
  return {
    team: { id: team.id, name: team.name },
    advisory: 'Advisory context for conversations with your team, not a score or a ranking.',
    membersTotal: members.length,
    membersIncluded: people.length,
    notIncluded: members.length - people.length,
    aggregates: aggregateAllowed ? Object.fromEntries(Object.keys(METRICS).map((k) => [k, { mean: avg(okValues(k)), people: okValues(k).length }])) : null,
    aggregateNote: aggregateAllowed ? null : `Team averages are shown for teams with at least ${s.minTeamSize} participating members.`,
    workload: loads.map((l) => ({ ...l, aboveTeamMean: meanLoad !== null && l.load !== null && l.load > meanLoad * 1.5 })),
    blocked: blocked.map((b) => ({ id: b.id, title: b.title, assignee: b.assignee })),
    reviewContribution: people.map((p) => ({ person: p.person, reviews: metric(p, 'review_contribution')?.value ?? null, status: metric(p, 'review_contribution')?.status ?? 'insufficient_data' })),
    members: people,
  };
}

/** HR dashboard: aggregates by department and team (groups of at least minTeamSize only). */
export async function hrDashboard(user) {
  if (!isHr(user)) throw forbidden('HR access required');
  const s = await getSettings();
  if (!isActive(s)) throw new AppError(409, 'KPI_DISABLED', 'KPI tracking is off');
  const eligible = await eligibleSet(s);
  const [[latest]] = await pool.query('SELECT MAX(period_end) AS d FROM employee_metrics');
  const end = latest?.d ? new Date(latest.d).toISOString().slice(0, 10) : null;
  await pool.execute('INSERT INTO kpi_access_log (viewer_user_id, subject_user_id, scope, reason) VALUES (?, NULL, ?, NULL)', [user.id, 'hr_aggregate']);
  if (!end) return { periodEnd: null, groups: [], suppressed: 0, minGroupSize: s.minTeamSize };
  const [rows] = await pool.query("SELECT user_id, metric_key, period_days, value, status FROM employee_metrics WHERE period_end = ? AND status = 'ok'", [end]);
  const [prev] = await pool.query("SELECT user_id, metric_key, value FROM employee_metrics WHERE period_days = 28 AND status = 'ok' AND period_end = (SELECT MAX(period_end) FROM employee_metrics WHERE period_end <= DATE_SUB(?, INTERVAL 28 DAY))", [end]);
  const [depts] = await pool.query('SELECT d.id, d.name, u.id AS user_id FROM departments d JOIN users u ON u.department_id = d.id WHERE u.is_active = TRUE');
  const [teams] = await pool.query('SELECT t.id, t.name, tm.user_id FROM teams t JOIN team_members tm ON tm.team_id = t.id');
  const groups = new Map();
  for (const r of depts) (groups.get(`department:${r.id}`) ?? groups.set(`department:${r.id}`, { type: 'department', id: r.id, name: r.name, users: new Set() }).get(`department:${r.id}`)).users.add(r.user_id);
  for (const r of teams) (groups.get(`team:${r.id}`) ?? groups.set(`team:${r.id}`, { type: 'team', id: r.id, name: r.name, users: new Set() }).get(`team:${r.id}`)).users.add(r.user_id);
  const out = [];
  let suppressed = 0;
  for (const g of groups.values()) {
    const users = [...g.users].filter((u) => eligible.has(u));
    if (users.length < s.minTeamSize) {
      suppressed += 1;
      continue;
    }
    const metrics = {};
    for (const k of Object.keys(METRICS)) {
      const now28 = rows.filter((r) => users.includes(r.user_id) && r.metric_key === k && r.period_days === 28).map((r) => Number(r.value));
      const prior = prev.filter((r) => users.includes(r.user_id) && r.metric_key === k).map((r) => Number(r.value));
      metrics[k] = { mean: avg(now28), people: now28.length, previousMean: avg(prior) };
    }
    const loads = rows.filter((r) => users.includes(r.user_id) && r.metric_key === 'load_index' && r.period_days === 28).map((r) => Number(r.value)).sort((a, b) => a - b);
    out.push({ type: g.type, id: g.id, name: g.name, people: users.length, metrics, workload: loads.length ? { min: loads[0], median: loads[Math.floor(loads.length / 2)], max: loads.at(-1) } : null });
  }
  return { periodEnd: end, groups: out.sort((a, b) => a.name.localeCompare(b.name)), suppressed, minGroupSize: s.minTeamSize, note: `Groups with fewer than ${s.minTeamSize} participating people are not shown.` };
}

/** Individual view by HR/admin (needs a reason) or by the person's team lead. Logged; HR views notify. */
export async function individualView(user, subjectId, { reason = null, teamId = null } = {}) {
  const s = await getSettings();
  if (!isActive(s)) throw new AppError(409, 'KPI_DISABLED', 'KPI tracking is off');
  const eligible = await eligibleSet(s);
  if (!eligible.has(subjectId)) throw notFound('No KPI data for this person');
  if (subjectId === user.id) return personView(subjectId);
  if (teamId) {
    const { members } = await teamFor(user, teamId);
    if (!members.some((m) => m.id === subjectId)) throw notFound('Not a member of this team');
    await logAccess(user, subjectId, 'manager_drilldown', { teamId, notifySubject: true });
    return personView(subjectId);
  }
  if (!isHr(user)) throw forbidden('HR access required');
  if (!reason || reason.trim().length < 10) throw badRequest('Give a reason for viewing an individual’s metrics (at least 10 characters)', [{ field: 'reason', message: 'Required' }]);
  await logAccess(user, subjectId, isAdmin(user) && !user.hrAccess ? 'admin_drilldown' : 'hr_drilldown', { reason: reason.trim(), notifySubject: true });
  await audit({ actorUserId: user.id, action: 'kpi.individual_viewed', entityType: 'user', entityId: subjectId, after: { reason: reason.trim() } });
  return personView(subjectId);
}

export { METRICS };
