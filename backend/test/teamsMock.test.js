// Microsoft Teams DEVELOPMENT MOCK (TEAMS_INTEGRATION_MODE=mock): connection through the normal
// connect flow (no Microsoft), seeding into WorkAgent's own tables, the real sync engine, ingest and
// transcript importer, idempotent re-seeding, relationships, dashboard state, WorkAPI extraction
// (STUBBED) on a mock transcript, reset isolation and disconnect. No Microsoft endpoint is involved.
process.env.WORKAGENT_TEST_TEAMS_MODE = 'mock';
const assert = (await import('node:assert/strict')).default;
const { after, before, describe, it } = await import('node:test');
const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { handlersFor } = await import('../src/jobs/handlers/index.js');
const { processNext } = await import('../src/jobs/runner.js');
const { registry } = await import('../src/services/integrations/registry.js');
const { workapi } = await import('../src/services/workapi/index.js');
const { EMPLOYEES, MEETINGS, MESSAGES, TEAMS } = await import('../src/services/integrations/mock/violinFixture.js');
const { closeDatabase, createUser, loginCookie, resetDatabase } = await import('./helpers.js');

const app = createApp();
const ids = {};
let cookie;
const original = { ...workapi };
const as = { get: (u) => request(app).get(u).set('Cookie', cookie), post: (u, b) => request(app).post(u).set('Cookie', cookie).send(b ?? {}) };
const one = async (sql, p) => (await pool.query(sql, p))[0][0];
const n = async (sql, p) => Number((await one(sql, p)).n);
const work = async () => {
  let k = 0;
  while (k < 50 && (await processNext('test', handlersFor(['ai.extract'])))) k++;
  return k;
};

describe('Microsoft Teams development mock', () => {
  before(async () => {
    await resetDatabase();
    await pool.query("DELETE FROM mock_records");
    ids.admin = await createUser({ email: 'admin@real.test', role: 'admin', fullName: 'Real Admin' });
    cookie = await loginCookie(app, 'admin@real.test');
    // Real data that must survive a reset, including a department with a mock name.
    ids.realUser = await createUser({ email: 'real.person@real.test', fullName: 'Real Person' });
    ids.realDept = (await pool.execute("INSERT INTO departments (name) VALUES ('Engineering')"))[0].insertId;
    ids.realProject = (await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Real project', ?, 'active')", [ids.admin]))[0].insertId;
    workapi.isConfigured = () => false;
  });
  after(async () => {
    Object.assign(workapi, original);
    await pool.query("DELETE FROM mock_records");
    await closeDatabase();
  });

  it('uses the mock connector in mock mode, available without Microsoft credentials', () => {
    const p = registry.list().find((x) => x.id === 'microsoft_teams');
    assert.equal(p.available, true);
    assert.match(p.displayName, /development mock/i);
  });

  it('connects through the normal flow (single-use state, no Microsoft sign-in), labelled as a mock', async () => {
    const start = await as.post('/api/v1/integrations/microsoft_teams/connect');
    assert.equal(start.status, 200);
    const url = new URL(start.body.redirectUrl);
    assert.equal(url.searchParams.get('code'), 'mock');
    assert.ok(!/microsoftonline|graph\.microsoft/.test(start.body.redirectUrl));
    const bad = await as.post('/api/v1/integrations/microsoft_teams/callback', { state: 'f'.repeat(43), params: { code: 'mock' } });
    assert.equal(bad.body.error.code, 'INVALID_STATE');
    const cb = await as.post('/api/v1/integrations/microsoft_teams/callback', { state: url.searchParams.get('state'), params: { code: 'mock' } });
    assert.equal(cb.status, 201, JSON.stringify(cb.body));
    ids.conn = cb.body.connection.id;
    assert.match(cb.body.connection.displayName, /Development mock \(Violin Technologies\)/);
    assert.equal(cb.body.connection.settings.mode, 'mock');
    assert.equal(cb.body.connection.settings.verified, false);
    assert.equal(cb.body.resources.filter((r) => r.resourceType === 'channel').length, TEAMS.reduce((s, t) => s + t.channels.length, 0));
  });

  it('seeds the organisation and imports Teams data through the real pipeline', async () => {
    const res = await as.post('/api/v1/integrations/teams-mock/sync');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = res.body.counts;
    assert.equal(c.employees, EMPLOYEES.length);
    assert.ok(c.employees >= 20);
    assert.equal(c.teams, 7);
    assert.ok(c.channels >= 14);
    assert.equal(c.meetings, MEETINGS.length);
    assert.equal(c.messages, MESSAGES.length + MESSAGES.reduce((s, m) => s + m.replies.length, 0));
    assert.ok(c.replies > 0);
    assert.equal(c.transcriptsImported, MEETINGS.length);
    assert.equal(res.body.connection.lastSyncSucceededAt !== null, true);
    ids.counts = c;
  });

  it('marks every mock row and never reuses real rows', async () => {
    assert.equal(await n("SELECT COUNT(*) AS n FROM external_records WHERE provider = 'microsoft_teams' AND JSON_EXTRACT(metadata, '$.isMock') = TRUE"), ids.counts.meetings + ids.counts.messages);
    assert.equal(await n("SELECT COUNT(*) AS n FROM mock_records WHERE source = 'teams_mock' AND entity_type = 'user'"), EMPLOYEES.length);
    const eng = await one("SELECT d.name FROM mock_records m JOIN departments d ON d.id = m.entity_id WHERE m.natural_key = 'department:Engineering'");
    assert.equal(eng.name, 'Engineering (Violin Technologies)', 'the real Engineering department is not reused');
    assert.equal(await n("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@violin.example.com' AND password_hash IS NULL"), EMPLOYEES.length, 'mock people cannot sign in');
  });

  it('re-seeding is idempotent', async () => {
    const before = await n('SELECT COUNT(*) AS n FROM users') + await n('SELECT COUNT(*) AS n FROM meetings') * 1000 + await n('SELECT COUNT(*) AS n FROM external_records') * 1_000_000;
    const res = await as.post('/api/v1/integrations/teams-mock/sync');
    assert.deepEqual(res.body.counts, ids.counts);
    const after = await n('SELECT COUNT(*) AS n FROM users') + await n('SELECT COUNT(*) AS n FROM meetings') * 1000 + await n('SELECT COUNT(*) AS n FROM external_records') * 1_000_000;
    assert.equal(after, before);
    assert.equal(await n("SELECT COUNT(*) AS n FROM teams WHERE name = 'Payments Team'"), 1);
  });

  it('relationships resolve: departments, managers, teams, projects, identities, participants', async () => {
    const priya = await one("SELECT u.id, u.job_title, d.name AS dept, u.role FROM users u JOIN departments d ON d.id = u.department_id WHERE u.email = 'priya.raman@violin.example.com'");
    assert.deepEqual([priya.job_title, priya.dept], ['Senior Backend Engineer', 'Engineering (Violin Technologies)']);
    const meta = await one("SELECT metadata FROM mock_records WHERE natural_key = 'employee:VT-003'");
    assert.equal((typeof meta.metadata === 'string' ? JSON.parse(meta.metadata) : meta.metadata).managerId, 'VT-002');
    const team = await one("SELECT t.id, u.full_name AS lead_name FROM teams t JOIN users u ON u.id = t.lead_user_id WHERE t.name = 'Payments Team'");
    assert.equal(team.lead_name, 'Ben Carter');
    assert.equal(await n('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?', [team.id, priya.id]), 1);
    assert.equal(await n("SELECT COUNT(*) AS n FROM external_identities WHERE provider = 'microsoft_teams' AND user_id IS NOT NULL AND match_method = 'email'") > 0, true);
    const unmatched = await n("SELECT COUNT(*) AS n FROM external_records r JOIN external_identities i ON i.id = r.author_identity_id WHERE r.record_type = 'message' AND i.user_id IS NULL");
    assert.equal(unmatched, 0, 'every message author resolves to a WorkAgent user');
    const msgProject = await one("SELECT p.name FROM external_records r JOIN projects p ON p.id = r.project_id WHERE r.title = 'Sprint 23 goals'");
    assert.equal(msgProject.name, 'Payments Platform 2.0');
    const standup = await one("SELECT m.id, m.project_id, p.name, (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS people FROM meetings m JOIN projects p ON p.id = m.project_id WHERE m.title = 'Daily Engineering Standup'");
    assert.equal(standup.name, 'Payments Platform 2.0');
    assert.equal(Number(standup.people), 9, 'organizer + 8 attendees matched by e-mail');
    ids.standup = standup.id;
  });

  it('teams, channels, messages, meetings and transcripts are readable through the API', async () => {
    const view = (await as.get('/api/v1/integrations/teams-mock/teams')).body;
    assert.equal(view.teams.length, 7);
    const refunds = view.teams.find((t) => t.name === 'Payments Team').channels.find((c) => c.name === 'Refunds');
    assert.ok(refunds.messages[0].replies.length >= 1);
    assert.ok(refunds.messages[0].reactions.length >= 1);
    assert.equal(view.meetings.length, MEETINGS.length);
    assert.ok(view.meetings.every((m) => m.meetingId && m.transcriptSegments > 0));
    const tr = await as.get(`/api/v1/meetings/${ids.standup}/transcript`);
    assert.equal(tr.status, 200);
    assert.match(JSON.stringify(tr.body), /duplicate refund email/);
    const feed = await as.get('/api/v1/activities');
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    assert.match(JSON.stringify(feed.body), /in Teams/);
  });

  it('the dashboard shows Microsoft Teams CONNECTED as a DEVELOPMENT MOCK with real counts', async () => {
    const card = (await as.get('/api/v1/integrations/overview')).body.cards.find((c) => c.provider === 'microsoft_teams');
    assert.equal(card.state, 'connected');
    assert.equal(card.mode, 'mock');
    assert.equal(card.mock, true);
    assert.equal(card.teams.account, 'demo.user@example.com');
    assert.equal(card.teams.organisation, 'Violin Technologies');
    assert.equal(card.teams.verified, false);
    assert.deepEqual(card.teams.counts, ids.counts);
  });

  it('existing WorkAPI extraction and review consume a mock transcript (WorkAPI stubbed)', async () => {
    workapi.isConfigured = () => true;
    workapi.model = () => 'stub-model';
    workapi.generateJson = async () => {
      const data = { action_items: [{ title: 'Fix the duplicate refund email bug', description: '', assignee_name_raw: 'Priya Raman', assignee_confidence: 0.95, due_date_raw: 'by tomorrow noon', due_date_resolved: null, due_date_is_ambiguous: false, priority: 'high', ai_confidence: 0.9, needs_review_reason: null, evidence: [{ segment_ref: 'S2', speaker: 'Priya Raman', timestamp: null, quote: 'I will have a fix up for review by tomorrow noon' }] }] };
      return { text: JSON.stringify(data), data, finishReason: 'STOP', provider: 'test', model: 'stub-model', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, attempts: 1, durationMs: 1 };
    };
    const ex = await as.post(`/api/v1/meetings/${ids.standup}/extract`);
    assert.ok([200, 202].includes(ex.status), JSON.stringify(ex.body));
    await work();
    const items = (await as.get(`/api/v1/meetings/${ids.standup}/action-items`)).body;
    const item = (items.actionItems ?? items.items ?? [])[0];
    assert.equal(item.assignee.fullName, 'Priya Raman', 'the speaker resolves to the mock employee');
    // The existing review rules apply: the reviewer sets the vague deadline before approving.
    const edit = await request(app).patch(`/api/v1/action-items/${item.id}`).set('Cookie', cookie).send({ dueDate: '2026-12-01' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const approve = await request(app).post(`/api/v1/action-items/${item.id}/approve`).set('Cookie', cookie).send({});
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    workapi.isConfigured = () => false;
  });

  it('disconnect marks the mock disconnected and keeps its data', async () => {
    const d = await as.post(`/api/v1/integrations/${ids.conn}/disconnect`, {});
    assert.equal(d.status, 200);
    const card = (await as.get('/api/v1/integrations/overview')).body.cards.find((c) => c.provider === 'microsoft_teams');
    assert.equal(card.state, 'disconnected');
    assert.equal(card.teams.counts.messages, ids.counts.messages);
    const again = await as.post('/api/v1/integrations/teams-mock/sync');
    assert.equal(again.body.connection.status, 'active', 'Sync Mock Data reconnects the mock');
  });

  it('reset deletes only mock rows', async () => {
    const realBefore = { users: await n("SELECT COUNT(*) AS n FROM users WHERE email NOT LIKE '%@violin.example.com'"), projects: await n("SELECT COUNT(*) AS n FROM projects WHERE id = ?", [ids.realProject]), dept: await n('SELECT COUNT(*) AS n FROM departments WHERE id = ?', [ids.realDept]) };
    const res = await as.post('/api/v1/integrations/teams-mock/reset');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted.users, EMPLOYEES.length);
    assert.deepEqual(Object.values(res.body.summary.counts).every((v) => v === 0), true, JSON.stringify(res.body.summary.counts));
    assert.equal(await n("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@violin.example.com'"), 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM external_records WHERE source_instance = 'microsoft.mock-violin-technologies'"), 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM meetings WHERE platform = 'microsoft_teams'"), 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM mock_records WHERE source = 'teams_mock'"), 0);
    assert.deepEqual({ users: await n("SELECT COUNT(*) AS n FROM users WHERE email NOT LIKE '%@violin.example.com'"), projects: await n('SELECT COUNT(*) AS n FROM projects WHERE id = ?', [ids.realProject]), dept: await n('SELECT COUNT(*) AS n FROM departments WHERE id = ?', [ids.realDept]) }, realBefore);
    const card = (await as.get('/api/v1/integrations/overview')).body.cards.find((c) => c.provider === 'microsoft_teams');
    assert.equal(card.state, 'disconnected');
  });
});
