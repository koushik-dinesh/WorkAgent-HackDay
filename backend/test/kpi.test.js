// Feature: employee KPI tracking and work profiling, with its privacy controls. Everything here is
// deterministic (no AI): consent gate, employee notice, metric arithmetic with source events,
// not-observable vs insufficient data, misattribution exclusion, team-lead and HR access rules,
// minimum group size, access log visible to the employee, retention and exit deletion.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { runNightly } from '../src/services/kpi/index.js';
import { addDays } from '../src/utils/dates.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body ?? {}),
  put: (url, body) => request(app).put(url).set('Cookie', cookies[who]).send(body ?? {}),
  delete: (url) => request(app).delete(url).set('Cookie', cookies[who]),
});
const one = async (sql, params) => (await pool.query(sql, params))[0][0];
const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000);
let seq = 0;

async function task(userId, { due = null, doneDaysAgo = null, approvedDaysAgo = 10, status = 'todo', priority = 'medium' } = {}) {
  const [t] = await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, review_status, task_status, priority, due_date, approved_at, created_at) VALUES (?, NULL, ?, ?, 'approved', ?, ?, ?, ?, ?)", [ids.meeting, `Task ${++seq}`, userId, doneDaysAgo !== null ? 'done' : status, priority, due, daysAgo(approvedDaysAgo), daysAgo(approvedDaysAgo)]);
  await pool.execute("INSERT INTO activities (dedupe_key, provider, activity_type, entity_type, entity_id, actor_user_id, occurred_at, summary, origin) VALUES (?, 'workagent', 'created', 'action_item', ?, ?, ?, 'created', 'internal')", [`t${t.insertId}:c`, t.insertId, ids.mgr, daysAgo(approvedDaysAgo)]);
  if (doneDaysAgo !== null) await pool.execute("INSERT INTO activities (dedupe_key, provider, activity_type, entity_type, entity_id, actor_user_id, occurred_at, summary, origin) VALUES (?, 'workagent', 'completed', 'action_item', ?, ?, ?, 'done', 'internal')", [`t${t.insertId}:d`, t.insertId, userId, daysAgo(doneDaysAgo)]);
  return t.insertId;
}

describe('employee KPIs and privacy controls', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@k.test', role: 'admin', fullName: 'Ada Admin' });
    ids.mgr = await createUser({ email: 'mgr@k.test', role: 'manager', fullName: 'Max Lead' });
    ids.mgr2 = await createUser({ email: 'mgr2@k.test', role: 'manager', fullName: 'Other Lead' });
    ids.hr = await createUser({ email: 'hr@k.test', fullName: 'Hana HR' });
    await pool.execute('UPDATE users SET hr_access = TRUE WHERE id = ?', [ids.hr]);
    ids.members = [];
    for (let i = 1; i <= 5; i++) ids.members.push(await createUser({ email: `m${i}@k.test`, fullName: `Member ${i}` }));
    ids.eve = ids.members[0];
    for (const k of ['admin', 'mgr', 'mgr2', 'hr']) cookies[k] = await loginCookie(app, `${k}@k.test`);
    cookies.eve = await loginCookie(app, 'm1@k.test');
    ids.team = (await pool.execute("INSERT INTO teams (name, lead_user_id) VALUES ('Core', ?)", [ids.mgr]))[0].insertId;
    for (const m of ids.members) await pool.execute('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [ids.team, m]);
    ids.meeting = (await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by) VALUES ('Planning', '', 'approved', ?)", [ids.mgr]))[0].insertId;
    // Eve: 3 commitments due in the window — 2 done on time, 1 late; 1 open high-priority task.
    await task(ids.eve, { due: addDays(today, -5), doneDaysAgo: 7 });
    await task(ids.eve, { due: addDays(today, -3), doneDaysAgo: 4 });
    ids.late = await task(ids.eve, { due: addDays(today, -6), doneDaysAgo: 2 });
    await task(ids.eve, { priority: 'high', approvedDaysAgo: 15 });
    for (const m of ids.members.slice(1)) await task(m, { due: addDays(today, -4), doneDaysAgo: 5 });
  });
  after(closeDatabase);

  it('is off until the organisation consents and an admin enables it', async () => {
    assert.equal((await as('eve').get('/api/v1/kpi/status')).body.enabled, false);
    assert.match((await runNightly()).skipped, /off/);
    assert.equal((await as('admin').put('/api/v1/kpi/settings', { enabled: true })).body.error.code, 'KPI_CONSENT_REQUIRED');
    assert.equal((await as('mgr').post('/api/v1/kpi/consent', { statement: 'x'.repeat(30), confirm: true })).status, 403);
    assert.equal((await as('admin').post('/api/v1/kpi/consent', { statement: 'Works council agreement of 2026-11-01, ref WC-12', confirm: true })).status, 200);
    const on = await as('admin').put('/api/v1/kpi/settings', { enabled: true });
    assert.equal(on.body.enabled, true);
    assert.ok(on.body.neverCollected.some((x) => /Keystrokes/.test(x)));
  });

  it('computes nothing for people who have not acknowledged the notice', async () => {
    const r = await runNightly();
    assert.equal(r.computed, 0);
    const me = (await as('eve').get('/api/v1/kpi/me')).body;
    assert.equal(me.data, null);
    assert.equal(me.status.acknowledged, false);
    assert.match(me.status.notice.text, /advisory/);
  });

  it('computes deterministic metrics with sources; unobservable data is not a zero', async () => {
    for (const m of ids.members) {
      const c = await loginCookie(app, (await one('SELECT email FROM users WHERE id = ?', [m])).email);
      assert.equal((await request(app).post('/api/v1/kpi/notice/acknowledge').set('Cookie', c)).body.acknowledged, true);
    }
    const r = await runNightly();
    assert.equal(r.computed, 5);
    const me = (await as('eve').get('/api/v1/kpi/me')).body;
    const m = (k, d = 28) => me.data.metrics.find((x) => x.key === k && x.periodDays === d);
    assert.equal(m('commitment_reliability').value, 0.6667);
    assert.deepEqual([m('commitment_reliability').numerator, m('commitment_reliability').denominator], [2, 3]);
    assert.equal(m('review_contribution').status, 'not_observable', 'no linked GitHub/Figma account');
    assert.equal(m('review_contribution').value, null);
    assert.equal(m('load_index').details.openItems, 1);
    assert.ok(m('load_index').value > 3 && m('load_index').value < 6, 'high priority (3) x age factor 1.5');
    assert.equal(m('meeting_to_action').value, 0.75);
    assert.ok(me.data.profile.some((p) => p.dimension === 'reliability_band'));
    assert.ok(!JSON.stringify(me).match(/"score"|"rank"/), 'no composite score or ranking');
    const src = (await as('eve').get('/api/v1/kpi/me/sources?metric=commitment_reliability&periodDays=28')).body.sources;
    assert.equal(src.length, 3);
    assert.ok(src.every((s) => s.summary?.type === 'action_item'));
  });

  it('misattributed events can be flagged (excluded at once) and restored', async () => {
    const res = await as('eve').post('/api/v1/kpi/me/corrections', { sourceType: 'action_item', sourceId: ids.late, reason: 'This was reassigned to me after the deadline' });
    const rel = res.body.data.metrics.find((x) => x.key === 'commitment_reliability' && x.periodDays === 28);
    assert.equal(rel.denominator, 2);
    assert.equal(rel.status, 'insufficient_data', 'fewer than 3 commitments left');
    const corr = res.body.corrections[0];
    const back = await as('eve').delete(`/api/v1/kpi/me/corrections/${corr.id}`);
    assert.equal(back.body.data.metrics.find((x) => x.key === 'commitment_reliability' && x.periodDays === 28).denominator, 3);
  });

  it('team leads see their team (logged, visible to the employee); others cannot', async () => {
    assert.equal((await as('mgr2').get(`/api/v1/kpi/teams/${ids.team}`)).status, 403);
    assert.equal((await as('eve').get(`/api/v1/kpi/teams/${ids.team}`)).status, 403);
    const team = await as('mgr').get(`/api/v1/kpi/teams/${ids.team}`);
    assert.equal(team.status, 200);
    assert.equal(team.body.membersIncluded, 5);
    assert.ok(team.body.aggregates, 'five participating members: averages shown');
    assert.match(team.body.advisory, /not a score/);
    const drill = await as('mgr').get(`/api/v1/kpi/teams/${ids.team}/members/${ids.eve}`);
    assert.equal(drill.status, 200);
    const log = (await as('eve').get('/api/v1/kpi/me')).body.accessLog;
    assert.ok(log.some((l) => l.scope === 'manager_view' && l.viewer === 'Max Lead'));
    assert.ok(log.some((l) => l.scope === 'manager_drilldown'));
  });

  it('HR sees aggregates of groups of five or more only; an individual view needs a reason and notifies', async () => {
    assert.equal((await as('mgr').get('/api/v1/kpi/hr')).status, 403);
    const d = await as('admin').post('/api/v1/departments', { name: 'Small dept' });
    await request(app).patch(`/api/v1/users/${ids.eve}`).set('Cookie', cookies.admin).send({ departmentId: d.body.department.id });
    const hr = (await as('hr').get('/api/v1/kpi/hr')).body;
    assert.deepEqual(hr.groups.map((g) => g.name), ['Core']);
    assert.equal(hr.suppressed, 1, 'the one-person department is not shown');
    assert.ok(!JSON.stringify(hr).includes('Member 1'), 'no individual names in aggregates');
    const noReason = await as('hr').post('/api/v1/kpi/hr/individual', { userId: ids.eve, reason: 'curious' });
    assert.equal(noReason.status, 400);
    const ok = await as('hr').post('/api/v1/kpi/hr/individual', { userId: ids.eve, reason: 'Workload concern raised in 1:1 on 2026-11-10' });
    assert.equal(ok.status, 200);
    const log = (await as('eve').get('/api/v1/kpi/me')).body.accessLog;
    assert.ok(log.some((l) => l.scope === 'hr_drilldown' && /Workload concern/.test(l.reason)));
    assert.ok(await one("SELECT id FROM notifications WHERE user_id = ? AND kind = 'kpi_viewed'", [ids.eve]));
  });

  it('retention removes old data and exit deletes an employee’s KPI data', async () => {
    await pool.execute("INSERT INTO employee_metrics (user_id, metric_key, period_end, period_days, status) VALUES (?, 'load_index', '2020-01-01', 28, 'ok')", [ids.eve]);
    const leaver = ids.members[4];
    await request(app).delete(`/api/v1/users/${leaver}`).set('Cookie', cookies.admin);
    const r = await runNightly();
    assert.ok(r.purgedMetrics >= 1);
    assert.equal(r.exitedDeleted, 1);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM employee_metrics WHERE user_id = ?', [leaver])).n), 0);
    assert.equal((await as('admin').delete(`/api/v1/kpi/employees/${ids.members[3]}/data`)).status, 204);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM employee_metrics WHERE user_id = ?', [ids.members[3]])).n), 0);
  });
});
