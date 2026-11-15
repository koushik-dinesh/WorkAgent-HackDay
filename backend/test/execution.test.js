// Central execution engine (services/execution): prepare -> exact preview -> approval (hash, large
// confirmation, approver's provider rights) -> cancel window -> idempotent execution -> read-back
// verification -> retries -> audit; Jira create/comment/update/transition/link, e-mail drafting and
// delivery, Teams, calendar scheduling, in-app notifications, permission failures, duplicate
// prevention.
// MOCKED, NOT LIVE: Jira is a local fake (test/integrations/fakeJira.js); e-mail uses a fake
// provider object; Teams is the labelled development-mock connector; the calendar is WorkAgent-only.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlers } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import { email } from '../src/services/email/index.js';
import * as engine from '../src/services/execution/index.js';
import { registry } from '../src/services/integrations/registry.js';
import teamsMock from '../src/services/integrations/providers/microsoft/teamsMock.js';
import { configureJira, resetJiraSettings } from '../src/services/integrations/providers/jira/settings.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { SITE_URL, issue as jiraIssue, person, project as jiraProject, startFakeJira } from './integrations/fakeJira.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
let jira;
const sent = [];
const originalEmail = { ...email };
const originalGetAvailable = registry.getAvailable;
const originalCancel = engine.engineSettings.cancelSeconds;
const originalLarge = engine.engineSettings.largeThreshold;

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
});
const runJobs = async () => {
  for (let i = 0; i < 20; i++) {
    await pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
    // Fast-forward backoff waits (the engine's retry delays are real minutes).
    await pool.query("UPDATE action_executions SET next_attempt_at = NOW() - INTERVAL 1 SECOND WHERE next_attempt_at > NOW()");
    if (!(await processNext('test-worker', { 'action.execute': handlers['action.execute'], 'meeting.invite_send': handlers['meeting.invite_send'] }))) return;
  }
};
async function syncAll(resourceId) {
  for (let i = 0; i < 40; i++) {
    try {
      return await syncEngine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
}
async function approvedItem(title, { assignee = ids.emp, due = '2026-12-10', priority = 'high' } = {}) {
  const [r] = await pool.execute(
    "INSERT INTO action_items (meeting_id, project_id, source_type, title, description, category, assignee_user_id, assignee_match, assignee_kind, priority, review_status, task_status, due_date, deadline_status, flags) VALUES (?, ?, 'meeting', ?, 'From the planning meeting', 'code_implementation', ?, 'exact', 'explicit', ?, 'approved', 'todo', ?, 'resolved', '[]')",
    [ids.meeting, ids.project, title, assignee, priority, due],
  );
  await pool.execute("INSERT INTO action_item_evidence (action_item_id, excerpt, speaker) VALUES (?, 'I will fix the refund rounding by Friday', 'Eve Employee')", [r.insertId]);
  return r.insertId;
}
async function prepareAndApprove(who, body, { largeConfirmed = false } = {}) {
  const prep = await as(who).post('/api/v1/actions/execution/plans', body);
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  assert.ok(prep.body.planId, JSON.stringify(prep.body.preview));
  const ok = await as(who).post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash, largeConfirmed });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return prep.body;
}
const execsOf = async (planId) => (await pool.query('SELECT * FROM action_executions WHERE plan_id = ? ORDER BY id', [planId]))[0];

before(async () => {
  jira = await startFakeJira();
  configureJira({ clientId: 'jira-client-id-123', clientSecret: 'jira-client-secret-456', siteUrl: SITE_URL, webhookSecret: undefined, issueCreation: true, authUrl: jira.url, apiUrl: jira.url, redirectUri: 'http://localhost:5173/integrations/jira/setup' });
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@x.test', role: 'admin', fullName: 'Ada Admin' });
  ids.mgr = await createUser({ email: 'mgr@x.test', role: 'manager', fullName: 'Max Manager' });
  ids.emp = await createUser({ email: 'emp@x.test', fullName: 'Eve Employee' });
  ids.raj = await createUser({ email: 'raj@x.test', fullName: 'Raj Kumar' });
  for (const k of ['admin', 'mgr', 'emp']) cookies[k] = await loginCookie(app, `${k}@x.test`);
  jira.state.sites[0].scopes = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
  const pay = jiraProject(jira.state, { id: 10000, key: 'PAY', name: 'Payments' });
  jiraIssue(jira.state, pay, { id: 20001, number: 1, summary: 'Existing issue', updated: new Date().toISOString(), reporter: person('acc-eve', 'Eve'), assignee: person('acc-max', 'Max') });
  const start = await as('admin').post('/api/v1/integrations/jira/connect');
  const state = new URL(start.body.redirectUrl).searchParams.get('state');
  const cb = await as('admin').post('/api/v1/integrations/jira/callback', { state, params: { code: jira.grantCode() } });
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.mgr]);
  ids.project = p.insertId;
  const res = cb.body.resources.find((r) => r.name === 'PAY');
  ids.payResource = res.id;
  await request(app).patch(`/api/v1/integrations/${cb.body.connection.id}/resources/${res.id}`).set('Cookie', cookies.admin).send({ isEnabled: true, projectId: ids.project });
  await syncAll(res.id);
  await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE provider = 'jira' AND external_user_id = 'acc-eve'", [ids.emp]);
  await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE provider = 'jira' AND external_user_id = 'acc-max'", [ids.mgr]);
  const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, project_id, scheduled_at) VALUES ('Planning', '', 'approved', ?, ?, NOW())", [ids.admin, ids.project]);
  ids.meeting = m.insertId;
  await pool.execute('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?), (?, ?)', [ids.meeting, ids.emp, ids.meeting, ids.raj]);
  // Fake e-mail provider (no SMTP/Resend is contacted).
  email.isConfigured = () => true;
  email.configurationProblem = () => null;
  email.from = () => 'WorkAgent <noreply@x.test>';
  email.getProvider = () => ({ name: 'fake', send: async (m) => (sent.push(m), { messageId: `fake-${sent.length}` }) });
  // Teams: the labelled development mock connector (nothing is sent to Microsoft).
  registry.getAvailable = (id) => (id === 'microsoft_teams' ? teamsMock : originalGetAvailable(id));
  const [tc] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status, settings) VALUES ('microsoft_teams', 'microsoft.mock-violin-technologies', 'mock', 'Teams · Development mock', 'active', '{\"mode\":\"mock\"}')");
  const [ch] = await pool.execute("INSERT INTO integration_resources (connection_id, resource_type, external_id, name, is_enabled, metadata) VALUES (?, 'channel', 'mock-team/mock-ch', 'Payments Team / General', TRUE, '{\"teamId\":\"mock-team\",\"channelId\":\"mock-ch\",\"isMock\":true}')", [tc.insertId]);
  ids.channel = ch.insertId;
});
beforeEach(() => {
  engine.engineSettings.cancelSeconds = () => 0;
  engine.engineSettings.largeThreshold = () => 10;
  jira.state.permissions['acc-max'] = ['CREATE_ISSUES', 'ASSIGN_ISSUES', 'ADD_COMMENTS', 'EDIT_ISSUES', 'TRANSITION_ISSUES', 'LINK_ISSUES'];
});
after(async () => {
  Object.assign(email, originalEmail);
  registry.getAvailable = originalGetAvailable;
  engine.engineSettings.cancelSeconds = originalCancel;
  engine.engineSettings.largeThreshold = originalLarge;
  resetJiraSettings();
  await jira.close();
  await closeDatabase();
});

describe('Jira write-back', () => {
  it('previews exactly, writes nothing before approval, then creates, links and verifies the issue', async () => {
    const itemId = await approvedItem('Fix the refund rounding');
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    const d = prep.body.preview.drafts[0];
    assert.equal(d.target, 'Jira project PAY');
    assert.match(d.content.description, new RegExp(`WorkAgent action #${itemId}`));
    assert.match(d.content.description, /I will fix the refund rounding by Friday/);
    assert.deepEqual([d.content.priority, d.content.dueDate, d.content.assignee], ['High', '2026-12-10', 'Eve Employee']);
    assert.equal(jira.state.created, 0, 'nothing written before approval');
    // A changed preview is refused.
    assert.equal((await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: 'f'.repeat(64) })).status, 409);
    // Employees may not approve for items they don't manage.
    assert.equal((await as('emp').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash })).status, 403);
    const ok = await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await runJobs();
    const [x] = await execsOf(prep.body.planId);
    assert.equal(x.status, 'verified');
    const created = jira.state.issues.find((i) => i.key === x.external_key);
    assert.ok(created.fields.labels.includes(`workagent-item-${itemId}`));
    assert.equal(created.fields.assignee.accountId, 'acc-eve');
    assert.equal(created.fields.duedate, '2026-12-10');
    const link = (await pool.query("SELECT status, origin FROM record_links WHERE from_type = 'action_item' AND from_id = ? AND to_id = ?", [itemId, x.external_record_id]))[0][0];
    assert.deepEqual([link.status, link.origin], ['confirmed', 'source']);
    assert.equal((await pool.query('SELECT execution_status FROM action_items WHERE id = ?', [itemId]))[0][0].execution_status, 'completed');
    assert.equal((await pool.query("SELECT status FROM action_item_exports WHERE action_item_id = ?", [itemId]))[0][0].status, 'created');
    const plan = (await as('mgr').get(`/api/v1/actions/execution/plans/${prep.body.planId}`)).body.plan;
    assert.equal(plan.status, 'completed');
    assert.deepEqual(plan.history.map((h) => h.action).filter((a) => a.startsWith('action_plan')), ['action_plan.prepared', 'action_plan.approved', 'action_plan.completed']);
    assert.ok(plan.history.some((h) => h.action === 'action_execution.verified'));
    // The same write cannot be planned twice.
    const again = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    assert.equal(again.body.planId, null);
    assert.match(again.body.preview.drafts[0].skipped, /Already done/);
    assert.equal(jira.state.created, 1);
    ids.jiraItem = itemId;
  });

  it('refuses to approve when the approver lacks the Jira permission', async () => {
    const itemId = await approvedItem('Add the reconciliation alert');
    jira.state.permissions['acc-max'] = [];
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    const res = await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JIRA_PERMISSION_DENIED');
    assert.equal((await execsOf(prep.body.planId))[0].status, 'awaiting_approval');
  });

  it('can be cancelled inside the cancel window; nothing is written', async () => {
    engine.engineSettings.cancelSeconds = () => 60;
    const itemId = await approvedItem('Rotate the webhook secret');
    const prep = await prepareAndApprove('mgr', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    const before = jira.state.created;
    const job = (await pool.query("SELECT run_at > NOW() + INTERVAL 30 SECOND AS later FROM jobs WHERE type = 'action.execute' AND JSON_EXTRACT(payload, '$.planId') = ?", [prep.planId]))[0][0];
    assert.equal(Number(job.later), 1, 'the job waits for the cancel window');
    const c = await as('mgr').post(`/api/v1/actions/execution/plans/${prep.planId}/cancel`);
    assert.equal(c.body.plan.status, 'cancelled');
    await engine.runPlan(prep.planId, { now: new Date(Date.now() + 120_000) });
    assert.equal(jira.state.created, before);
    assert.equal((await execsOf(prep.planId))[0].status, 'cancelled');
    // Cancelled work can be planned again.
    engine.engineSettings.cancelSeconds = () => 0;
    const re = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    assert.ok(re.body.planId);
  });

  it('retries transient failures automatically and leaves permanent ones retryable', async () => {
    const itemId = await approvedItem('Document the payout API');
    jira.state.failNext.push({ match: /POST \/ex\/jira\/.*\/issue$/, status: 503, body: { errorMessages: ['busy'] } });
    const prep = await prepareAndApprove('mgr', { kind: 'jira.create_issue', actionItemIds: [itemId] });
    await runJobs();
    let [x] = await execsOf(prep.planId);
    assert.equal(x.status, 'verified', 'a 503 is retried with backoff');
    assert.equal(x.attempts, 2);
    // A comment on an issue whose key Jira does not know: permanent failure, visible, manual retry.
    const [[rec]] = await pool.query("SELECT id FROM external_records WHERE external_key = 'PAY-1'");
    await pool.execute("INSERT INTO record_links (from_type, from_id, to_type, to_id, link_type, origin, status) VALUES ('action_item', ?, 'external_record', ?, 'references', 'manual', 'confirmed')", [itemId, rec.id]);
    jira.state.failNext.push({ match: /GET \/ex\/jira\/.*\/issue\/PAY-1\/comment/, status: 404, body: { errorMessages: ['Issue does not exist'] } });
    const c = await prepareAndApprove('mgr', { kind: 'jira.comment', actionItemIds: [itemId], options: { text: 'Docs draft is ready for review.' } });
    await runJobs();
    [x] = (await execsOf(c.planId)).filter((e) => e.kind === 'jira.comment');
    assert.equal(x.status, 'failed');
    assert.ok(x.last_error);
    assert.equal((await pool.query('SELECT execution_status FROM action_items WHERE id = ?', [itemId]))[0][0].execution_status, 'failed');
    const note = (await pool.query("SELECT title FROM notifications WHERE kind = 'action_execution' AND user_id = ?", [ids.mgr]))[0];
    assert.ok(note.length >= 1, 'the approver is told');
    const r = await as('mgr').post(`/api/v1/actions/execution/executions/${x.id}/retry`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await runJobs();
    [x] = (await execsOf(c.planId)).filter((e) => e.kind === 'jira.comment');
    assert.equal(x.status, 'succeeded');
    const issue = jira.state.issues.find((i) => i.key === 'PAY-1');
    assert.equal(issue.allComments.filter((cm) => JSON.stringify(cm.body).includes('Docs draft is ready')).length, 1);
    // Re-running the same execution cannot post a second comment (marker).
    await pool.execute("UPDATE action_executions SET status = 'scheduled' WHERE id = ?", [x.id]);
    await pool.execute("UPDATE action_plans SET status = 'executing' WHERE id = ?", [c.planId]);
    await engine.runPlan(c.planId);
    assert.equal(issue.allComments.filter((cm) => JSON.stringify(cm.body).includes('Docs draft is ready')).length, 1);
  });

  it('updates priority/due date, transitions and links the linked issue, verified by reading back', async () => {
    const itemId = ids.jiraItem;
    const up = await prepareAndApprove('mgr', { kind: 'jira.update', actionItemIds: [itemId], options: { priority: 'low', dueDate: '2026-12-20' } });
    await runJobs();
    assert.equal((await execsOf(up.planId))[0].status, 'verified');
    const tr = await prepareAndApprove('mgr', { kind: 'jira.transition', actionItemIds: [itemId], options: { status: 'In Progress' } });
    await runJobs();
    assert.equal((await execsOf(tr.planId))[0].status, 'verified');
    const key = (await execsOf(up.planId))[0].external_key;
    assert.equal(jira.state.issues.find((i) => i.key === key).fields.status.name, 'In Progress');
    const ln = await prepareAndApprove('mgr', { kind: 'jira.link', actionItemIds: [itemId], options: { toKey: 'PAY-1' } });
    await runJobs();
    assert.equal((await execsOf(ln.planId))[0].status, 'verified');
    assert.deepEqual(jira.state.links.at(-1), [key, 'PAY-1']);
  });
});

describe('e-mail', () => {
  it('drafts one e-mail per owner from the directory, sends after approval and links it to the items', async () => {
    const a = await approvedItem('Prepare the payout runbook', { assignee: ids.emp });
    const b = await approvedItem('Update the refund policy flag', { assignee: ids.raj });
    const c = await approvedItem('Review the settlement batches', { assignee: ids.emp });
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'email.send', actionItemIds: [a, b, c], options: { template: 'assignment' } });
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    assert.deepEqual(prep.body.preview.recipients.map((r) => r.email).sort(), ['emp@x.test', 'raj@x.test']);
    const evesMail = prep.body.preview.drafts.find((d) => d.content?.to?.includes('emp@x.test'));
    assert.match(evesMail.content.subject, /Max Manager assigned you 2 action items/);
    assert.match(evesMail.content.body, /Prepare the payout runbook/);
    assert.match(evesMail.content.body, /Review the settlement batches/);
    assert.equal(sent.length, 0, 'nothing sent before approval');
    await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    await runJobs();
    assert.equal(sent.length, 2);
    assert.ok(sent.every((m) => m.idempotencyKey && m.from.includes('noreply')));
    const rows = (await pool.query('SELECT em.id, em.kind, em.status, em.action_execution_id FROM email_messages em WHERE em.action_execution_id IS NOT NULL'))[0];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'sent' && r.kind === 'action_assignment'));
    const linked = (await pool.query('SELECT action_item_id FROM email_message_items WHERE email_message_id IN (?) ORDER BY action_item_id', [rows.map((r) => r.id)]))[0].map((r) => r.action_item_id);
    assert.deepEqual(linked, [a, b, c].sort((x, y) => x - y));
    assert.ok((await execsOf(prep.body.planId)).every((x) => x.status === 'verified'));
  });

  it('never invents recipients: owners without a directory e-mail are skipped; changed addresses fail', async () => {
    const orphan = await approvedItem('Nobody owns this', { assignee: null });
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'email.send', actionItemIds: [orphan], options: { template: 'assignment' } });
    assert.equal(prep.body.planId, null);
    assert.match(prep.body.preview.drafts[0].skipped, /No owner/);
    const it2 = await approvedItem('Chase the bank', { assignee: ids.raj });
    const p2 = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'email.send', actionItemIds: [it2], options: { template: 'reminder' } });
    await as('mgr').post(`/api/v1/actions/execution/plans/${p2.body.planId}/approve`, { previewHash: p2.body.previewHash });
    await pool.execute("UPDATE users SET email = 'raj.new@x.test' WHERE id = ?", [ids.raj]);
    const before = sent.length;
    await runJobs();
    assert.equal(sent.length, before);
    assert.equal((await execsOf(p2.body.planId))[0].status, 'failed');
    await pool.execute("UPDATE users SET email = 'raj@x.test' WHERE id = ?", [ids.raj]);
  });

  it('meeting summaries go to the meeting’s participants', async () => {
    const it3 = await approvedItem('Share the migration timeline', { assignee: ids.emp });
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'email.send', actionItemIds: [it3], options: { template: 'meeting_summary', meetingId: ids.meeting } });
    assert.deepEqual(prep.body.preview.recipients.map((r) => r.email).sort(), ['emp@x.test', 'raj@x.test']);
    assert.match(prep.body.preview.drafts[0].content.subject, /Summary and action items: Planning/);
  });
});

describe('Teams, calendar, notifications, bulk safety', () => {
  it('posts to a Teams channel through the development mock and labels it', async () => {
    const it4 = await approvedItem('Announce the refund window change');
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'teams.message', actionItemIds: [it4], options: { resourceId: ids.channel, template: 'assignment' } });
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    assert.match(prep.body.preview.drafts[0].target, /DEVELOPMENT MOCK/);
    await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    await runJobs();
    const [x] = await execsOf(prep.body.planId);
    assert.equal(x.status, 'verified');
    const out = (await pool.query("SELECT metadata FROM mock_records WHERE source = 'teams_mock' AND entity_type = 'outbound_message'"))[0];
    assert.equal(out.length, 1);
    assert.match(JSON.stringify(out[0].metadata), /Announce the refund window change/);
  });

  it('schedules a follow-up meeting with the owners, verified once invitations went out', async () => {
    const it5 = await approvedItem('Decide the payout batch size', { assignee: ids.raj });
    const startAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'calendar.schedule', actionItemIds: [it5], options: { title: 'Payout batch follow-up', startAt, durationMinutes: 30, timeZone: 'UTC', provider: 'workagent' } });
    assert.equal(prep.status, 201, JSON.stringify(prep.body));
    assert.deepEqual(prep.body.preview.recipients.map((r) => r.email), ['raj@x.test']);
    await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    await runJobs();
    await engine.verifyPending();
    const [x] = await execsOf(prep.body.planId);
    assert.equal(x.status, 'verified');
    const meetingId = Number(x.external_id);
    assert.equal((await pool.query('SELECT status FROM meeting_schedules WHERE meeting_id = ?', [meetingId]))[0][0].status, 'sent');
  });

  it('bulk plans above the threshold need an explicit second confirmation', async () => {
    engine.engineSettings.largeThreshold = () => 2;
    const many = [];
    for (let i = 0; i < 3; i++) many.push(await approvedItem(`Bulk item ${i}`));
    const prep = await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'workagent.notify', actionItemIds: many, options: {} });
    assert.equal(prep.body.preview.requiresLargeConfirmation, true);
    const refused = await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash });
    assert.equal(refused.body.error.code, 'LARGE_CONFIRMATION_REQUIRED');
    const ok = await as('mgr').post(`/api/v1/actions/execution/plans/${prep.body.planId}/approve`, { previewHash: prep.body.previewHash, largeConfirmed: true });
    assert.equal(ok.status, 200);
    await runJobs();
    assert.ok((await execsOf(prep.body.planId)).every((x) => x.status === 'verified'));
  });

  it('refuses unapproved items and items the person cannot see', async () => {
    const [r] = await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, review_status, flags) VALUES (?, ?, 'Pending one', 'pending', '[]')", [ids.meeting, ids.project]);
    assert.equal((await as('mgr').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [r.insertId] })).status, 409);
    assert.equal((await as('emp').post('/api/v1/actions/execution/plans', { kind: 'jira.create_issue', actionItemIds: [r.insertId] })).status, 404);
    const caps = await as('mgr').get('/api/v1/actions/execution/capabilities');
    assert.ok(caps.body.kinds.find((k) => k.kind === 'jira.create_issue').available);
    assert.ok(caps.body.kinds.find((k) => k.kind === 'github.create_issue').problem);
  });
});
