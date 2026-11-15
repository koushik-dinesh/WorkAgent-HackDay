// Feature: weekly automatic digest. Deterministic sections and counts with source references,
// audiences (manager / HR / executive), the narrative guard (WorkAPI STUBBED: a narrative with a
// figure that is not in the data is rejected), per-person suppression, delivery by e-mail (fake
// provider) and Teams (fake webhook), schedule cut-off and idempotency. MOCKED: no real e-mail,
// Teams or AI provider.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import * as digest from '../src/services/digest/index.js';
import { workapi } from '../src/services/workapi/index.js';
import { addDays } from '../src/utils/dates.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const original = { ...workapi };
const as = (who) => ({ get: (url) => request(app).get(url).set('Cookie', cookies[who]), put: (url, body) => request(app).put(url).set('Cookie', cookies[who]).send(body) });
const END = new Date();
const daysAgo = (d) => new Date(END.getTime() - d * 86_400_000);
const today = END.toISOString().slice(0, 10);
let narrativeText = null;
let seq = 0;

async function task(userId, { status = 'todo', due = null, doneDaysAgo = null, lastActivityDaysAgo = 20 } = {}) {
  const [t] = await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, review_status, task_status, due_date, approved_at) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)", [ids.meeting, ids.project, `Task ${++seq}`, userId, doneDaysAgo !== null ? 'done' : status, due, daysAgo(30)]);
  await pool.execute("INSERT INTO activities (dedupe_key, provider, activity_type, entity_type, entity_id, occurred_at, summary, origin) VALUES (?, 'workagent', ?, 'action_item', ?, ?, 'x', 'internal')", [`dg${t.insertId}`, doneDaysAgo !== null ? 'completed' : status === 'blocked' ? 'blocked' : 'created', t.insertId, daysAgo(doneDaysAgo ?? lastActivityDaysAgo)]);
  return t.insertId;
}

describe('weekly digest', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@w.test', role: 'admin', fullName: 'Ada Admin' });
    ids.lead = await createUser({ email: 'lead@w.test', role: 'manager', fullName: 'Lee Lead' });
    ids.dev = await createUser({ email: 'dev@w.test', fullName: 'Dana Dev' });
    ids.hr = await createUser({ email: 'hr@w.test', fullName: 'Hana HR' });
    ids.other = await createUser({ email: 'other@w.test', fullName: 'Oscar Other' });
    await pool.execute('UPDATE users SET hr_access = TRUE WHERE id = ?', [ids.hr]);
    for (const k of ['admin', 'lead', 'dev', 'hr', 'other']) cookies[k] = await loginCookie(app, `${k}@w.test`);
    ids.team = (await pool.execute("INSERT INTO teams (name, lead_user_id) VALUES ('Payments', ?)", [ids.lead]))[0].insertId;
    await pool.execute('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [ids.team, ids.dev]);
    ids.project = (await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Checkout', ?, 'active')", [ids.lead]))[0].insertId;
    ids.meeting = (await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, project_id, started_at) VALUES ('Weekly sync', '', 'approved', ?, ?, ?)", [ids.lead, ids.project, daysAgo(2)]))[0].insertId;
    await pool.execute('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?), (?, ?)', [ids.meeting, ids.lead, ids.meeting, ids.dev]);
    ids.shipped = await task(ids.dev, { doneDaysAgo: 3 });
    ids.slipped = await task(ids.dev, { due: addDays(today, -4) });
    ids.blocked = await task(ids.dev, { status: 'blocked', lastActivityDaysAgo: 5 });
    ids.atRisk = await task(ids.dev, { due: addDays(today, 3) });
    await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, review_status, task_status) VALUES (?, ?, 'Nobody owns this', 'approved', 'todo')", [ids.meeting, ids.project]);
    await pool.execute("INSERT INTO meeting_decisions (meeting_id, text, decided_by_name, evidence, start_sec) VALUES (?, 'Ship the new checkout on Friday', 'Lee Lead', 'we ship it on Friday', 61)", [ids.meeting]);
    workapi.isConfigured = () => true;
    workapi.generateJson = async () => {
      const data = { headline: narrativeText, sections: Object.fromEntries(digest.SECTIONS.map((s) => [s, null])) };
      return { data, text: JSON.stringify(data), provider: 'test', model: 'stub', usage: {}, attempts: 1 };
    };
  });
  after(async () => {
    Object.assign(workapi, original);
    await closeDatabase();
  });

  it('the narrative guard rejects figures that are not in the data', () => {
    const data = { counts: { shipped: 4, slipped: 2 }, sections: { slipped: [{ title: 'PAY-12 refund', daysOverdue: 9 }] } };
    assert.equal(digest.checkNarrative({ headline: '4 items shipped, 2 slipped; PAY-12 is 9 days late', sections: {} }, data).ok, true);
    const bad = digest.checkNarrative({ headline: 'Throughput rose 35% with 4 shipped', sections: {} }, data);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.invented, ['35']);
  });

  it('computes the manager digest deterministically with source references', async () => {
    narrativeText = 'The team shipped 1 item; 1 slipped.';
    const r = await digest.generate(END.toISOString());
    assert.equal(r.digests.length, 3, 'manager (team), HR and executive');
    const list = (await as('lead').get('/api/v1/digests')).body.digests;
    assert.equal(list.length, 1);
    const d = (await as('lead').get(`/api/v1/digests/${list[0].id}`)).body;
    assert.equal(d.counts.shipped, 1);
    assert.equal(d.counts.slipped, 1);
    assert.equal(d.counts.blockers, 1);
    assert.equal(d.counts.commitmentsAtRisk, 1);
    assert.equal(d.counts.decisions, 1);
    assert.equal(d.counts.onTimeShare, 50);
    const slipped = d.sections.find((s) => s.key === 'slipped').items[0];
    assert.deepEqual([slipped.ref.type, slipped.ref.id, slipped.daysOverdue, slipped.owner], ['action_item', ids.slipped, 4, 'Dana Dev']);
    const decision = d.sections.find((s) => s.key === 'decisions').items[0];
    assert.equal(decision.transcriptSec, 61);
    assert.ok(d.sections.find((s) => s.key === 'needs_attention').items.some((x) => /no owner/.test(x.reason)));
    assert.equal(d.sections.find((s) => s.key === 'team_load').items.available, false, 'KPI off: no load figures');
    assert.equal(d.digest.headline, 'The team shipped 1 item; 1 slipped.');
    assert.equal(d.digest.narrativeStatus, 'generated');
  });

  it('audiences: HR gets aggregates without names; others see nothing; admins see all', async () => {
    const hrList = (await as('hr').get('/api/v1/digests')).body.digests;
    assert.deepEqual(hrList.map((x) => x.audience), ['hr']);
    const hr = (await as('hr').get(`/api/v1/digests/${hrList[0].id}`)).body;
    assert.ok(!JSON.stringify(hr).includes('Dana Dev'), 'no individual names in the HR digest');
    assert.equal(hr.counts.slipped, 1);
    assert.equal((await as('other').get('/api/v1/digests')).body.digests.length, 0);
    assert.equal((await as('other').get(`/api/v1/digests/${hrList[0].id}`)).status, 404);
    assert.equal((await as('admin').get('/api/v1/digests')).body.digests.length, 3);
    const notif = (await pool.query("SELECT user_id FROM notifications WHERE kind = 'weekly_digest'"))[0].map((n) => n.user_id).sort();
    assert.deepEqual(notif, [ids.admin, ids.lead, ids.hr].sort());
  });

  it('a narrative with invented numbers is withheld; regeneration is idempotent', async () => {
    narrativeText = 'Velocity improved by 40% this week.';
    await digest.generate(END.toISOString());
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM weekly_digests');
    assert.equal(Number(rows[0].n), 3, 'same week, same digests');
    const id = (await as('lead').get('/api/v1/digests')).body.digests[0].id;
    const d = (await as('lead').get(`/api/v1/digests/${id}`)).body;
    assert.equal(d.digest.narrativeStatus, 'rejected');
    assert.equal(d.digest.headline, null);
    assert.match(d.digest.narrativeNote, /withheld/);
  });

  it('recipients can suppress sections', async () => {
    const res = await as('lead').put('/api/v1/digests/preferences', { suppressedSections: ['decisions', 'team_load'] });
    assert.deepEqual(res.body.preferences.suppressedSections, ['decisions', 'team_load']);
    const id = (await as('lead').get('/api/v1/digests')).body.digests[0].id;
    const d = (await as('lead').get(`/api/v1/digests/${id}`)).body;
    assert.ok(!d.sections.some((s) => s.key === 'decisions'));
    assert.equal((await as('lead').put('/api/v1/digests/preferences', { suppressedSections: ['nonsense'] })).status, 400);
  });

  it('delivers by e-mail (skipped when not configured) and to Teams (team counts only)', async () => {
    const [[rec]] = await pool.query("SELECT r.id FROM weekly_digest_recipients r JOIN weekly_digests d ON d.id = r.digest_id WHERE d.audience = 'manager'");
    await digest.deliver(rec.id, { emailService: { isConfigured: () => false, configurationProblem: () => 'EMAIL_PROVIDER is not set' } });
    let row = (await pool.query('SELECT email_status, email_error FROM weekly_digest_recipients WHERE id = ?', [rec.id]))[0][0];
    assert.equal(row.email_status, 'skipped');
    const sent = [];
    await pool.execute("UPDATE weekly_digest_recipients SET email_status = 'queued', teams_status = 'queued' WHERE id = ?", [rec.id]);
    config.features.digestTeamsWebhookUrl = 'https://teams.example.test/webhook';
    let posted;
    try {
      await digest.deliver(rec.id, {
        emailService: { isConfigured: () => true, from: () => 'WorkAgent <no-reply@w.test>', getProvider: () => ({ send: async (m) => sent.push(m) }) },
        fetchImpl: async (url, init) => {
          posted = JSON.parse(init.body).text;
          return new Response('1', { status: 200 });
        },
      });
    } finally {
      config.features.digestTeamsWebhookUrl = undefined;
    }
    row = (await pool.query('SELECT email_status, teams_status FROM weekly_digest_recipients WHERE id = ?', [rec.id]))[0][0];
    assert.deepEqual([row.email_status, row.teams_status], ['sent', 'sent']);
    assert.equal(sent[0].to, 'lead@w.test');
    assert.ok(!sent[0].text.includes('Decisions made'), 'suppressed sections are left out of the e-mail too');
    assert.match(posted, /Shipped: 1 · Slipped: 1/);
    assert.ok(!posted.includes('Dana Dev'), 'no individual figures in Teams');
  });

  it('schedule: Friday 17:00 cut-off in the org time zone, queued once', async () => {
    const s = { ...digest.DEFAULT_SETTINGS(), timeZone: 'Asia/Kolkata' };
    const cut = digest.lastCutoff(s, new Date('2026-11-21T12:00:00Z')); // Saturday
    assert.equal(cut.toISOString(), '2026-11-20T11:30:00.000Z');
    await pool.query('DELETE FROM jobs');
    await pool.execute("INSERT INTO app_settings (setting_key, value) VALUES ('digest', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ timeZone: 'Asia/Kolkata' })]);
    assert.equal(await digest.enqueueDue(new Date('2026-11-20T12:00:00Z')), 1);
    assert.equal(await digest.enqueueDue(new Date('2026-11-20T12:05:00Z')), 0, 'dedupe: one job per cut-off');
  });
});
