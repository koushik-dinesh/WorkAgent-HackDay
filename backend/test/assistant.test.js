// Feature: conversational task and meeting orchestration. WorkAPI is STUBBED (no real AI call):
// each test sets the structured answer the model would give, and the test checks what WorkAgent
// does with it — grounding, clarification, choices, confirmation cards, permission checks,
// execution against a fake Jira, meeting scheduling, undo, audit — and the speech abstraction with
// a fake speech endpoint. MOCKED: Jira and Google Speech are fakes on 127.0.0.1.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { configureJira, resetJiraSettings } from '../src/services/integrations/providers/jira/settings.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import * as queue from '../src/jobs/queue.js';
import { configureSpeech, resetSpeech } from '../src/services/speech/index.js';
import { workapi } from '../src/services/workapi/index.js';
import { normalizeParse, parseDuration, resolveDue, resolveStart } from '../src/services/assistant/parser.js';
import { SITE_URL, issue as jiraIssue, person, project as jiraProject, startFakeJira } from './integrations/fakeJira.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
let jira;
let nextParse = null;
const original = { ...workapi };
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body ?? {}),
});
const one = async (sql, params) => (await pool.query(sql, params))[0][0];
const empty = { task_reference: null, task_title: null, description: null, assignee: null, project: null, priority: null, status: null, due_date_text: null, due_date: null, meeting_title: null, attendees: [], attendees_from_meeting: null, start_text: null, start_datetime: null, duration_minutes: null, calendar_provider: null, query: null, query_person: null };
const parseAs = (intent, slots, missing = []) => {
  nextParse = { intent, slots: { ...empty, ...slots }, missing, clarification_question: null };
};
const lastCommand = (body) => body.commands.at(-1);
const lastMessage = (body) => body.messages.at(-1).content;

async function syncAll(resourceId) {
  for (let i = 0; i < 30; i++) {
    try {
      return await syncEngine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
  throw new Error('sync did not finish');
}

describe('parser rules (deterministic)', () => {
  const now = new Date('2026-11-16T09:00:00Z'); // Monday
  it('drops slots that are not in the utterance and keeps grounded ones', () => {
    const r = normalizeParse({ intent: 'assign_task', slots: { ...empty, task_title: 'OAuth refresh bug', assignee: 'Priyanka', priority: 'high' } }, 'Assign the OAuth refresh bug to Priya, high priority');
    assert.equal(r.slots.task_title, 'OAuth refresh bug');
    assert.equal(r.slots.assignee, null, 'an invented name is never used');
    assert.equal(r.slots.priority, 'high');
    assert.deepEqual(r.missing, ['assignee']);
    const bad = normalizeParse({ intent: 'delete_everything', slots: empty }, 'drop the database');
    assert.equal(bad.intent, 'unsupported');
    const noPriority = normalizeParse({ intent: 'assign_task', slots: { ...empty, task_title: 'fix login', assignee: 'Raj', priority: 'critical' } }, 'assign fix login to Raj');
    assert.equal(noPriority.slots.priority, null, 'a priority that was not said is dropped');
  });
  it('resolves dates and times deterministically and offers choices when ambiguous', () => {
    assert.deepEqual(resolveDue('next Friday', null, '2026-11-16').choices, ['2026-11-20', '2026-11-27']);
    assert.equal(resolveDue('by 20 November', null, '2026-11-16').date, '2026-11-20');
    assert.equal(resolveStart('Thursday at 4 PM', null, { now, timeZone: 'Asia/Kolkata' }).startAt, '2026-11-19T10:30:00.000Z');
    assert.equal(resolveStart('Thursday at 4', null, { now, timeZone: 'UTC' }).choices.length, 2, 'am or pm?');
    assert.equal(parseDuration('for one hour'), 60);
    assert.equal(parseDuration('a 30-minute follow-up'), 30);
    assert.equal(parseDuration('half an hour'), 30);
    assert.equal(parseDuration('tomorrow'), null);
  });
});

describe('assistant end to end (stubbed WorkAPI, fake Jira)', () => {
  before(async () => {
    jira = await startFakeJira();
    configureJira({ clientId: 'jira-client-id-123', clientSecret: 'jira-client-secret-456', siteUrl: SITE_URL, webhookSecret: undefined, issueCreation: true, authUrl: jira.url, apiUrl: jira.url, redirectUri: 'http://localhost:5173/integrations/jira/setup' });
    workapi.isConfigured = () => true;
    workapi.generateJson = async () => {
      const data = nextParse;
      return { text: JSON.stringify(data), data, finishReason: 'STOP', provider: 'test', model: 'stub-model', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, attempts: 1, durationMs: 1 };
    };
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@a.test', role: 'admin', fullName: 'Ada Admin' });
    ids.mgr = await createUser({ email: 'mgr@a.test', role: 'manager', fullName: 'Max Manager' });
    ids.emp = await createUser({ email: 'emp@a.test', role: 'employee', fullName: 'Eve Employee' });
    ids.priyaS = await createUser({ email: 'priya.s@a.test', fullName: 'Priya Shah' });
    ids.priyaN = await createUser({ email: 'priya.n@a.test', fullName: 'Priya Nair' });
    for (const k of ['admin', 'mgr', 'emp']) cookies[k] = await loginCookie(app, `${k}@a.test`);
    // Jira: connect, enable PAY, sync an issue so Priya's and the manager's Jira accounts are known.
    jira.state.sites[0].scopes = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
    const pay = jiraProject(jira.state, { id: 10000, key: 'PAY', name: 'Payments' });
    jiraIssue(jira.state, pay, { id: 20001, number: 1, summary: 'Payment integration retries', updated: new Date().toISOString(), reporter: person('acc-priya', 'Priya Shah'), assignee: person('acc-max', 'Max Manager') });
    const start = await as('admin').post('/api/v1/integrations/jira/connect');
    const state = new URL(start.body.redirectUrl).searchParams.get('state');
    const cb = await as('admin').post('/api/v1/integrations/jira/callback', { state, params: { code: jira.grantCode() } });
    assert.ok([200, 201].includes(cb.status), JSON.stringify(cb.body));
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.mgr]);
    ids.project = p.insertId;
    await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', [ids.project, ids.emp]);
    const res = cb.body.resources.find((r) => r.name === 'PAY');
    ids.payResource = res.id;
    await request(app).patch(`/api/v1/integrations/${cb.body.connection.id}/resources/${res.id}`).set('Cookie', cookies.admin).send({ isEnabled: true, projectId: ids.project });
    await syncAll(res.id);
    await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE provider = 'jira' AND external_user_id = 'acc-priya'", [ids.priyaS]);
    await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE provider = 'jira' AND external_user_id = 'acc-max'", [ids.mgr]);
    // A WorkAgent task in the manager's project.
    const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, project_id) VALUES ('Planning', '', 'approved', ?, ?)", [ids.admin, ids.project]);
    const [t] = await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, assignee_match, priority, review_status, task_status, due_date) VALUES (?, ?, 'Finish the payment integration task', ?, 'exact', 'medium', 'approved', 'todo', '2026-01-05')", [m.insertId, ids.project, ids.emp]);
    ids.task = t.insertId;
    ids.standup = (await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, started_at) VALUES ('Daily standup', '', 'ended', ?, UTC_TIMESTAMP() - INTERVAL 1 MINUTE)", [ids.mgr]))[0].insertId;
    await pool.execute('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?), (?, ?), (?, ?)', [ids.standup, ids.mgr, ids.standup, ids.emp, ids.standup, ids.priyaN]);
  });
  after(async () => {
    Object.assign(workapi, original);
    resetJiraSettings();
    resetSpeech();
    await jira.close();
    await closeDatabase();
  });

  it('rejects unsupported requests and asks for missing slots without guessing', async () => {
    parseAs('unsupported', {});
    let res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Delete all Jira projects' });
    assert.equal(res.status, 200);
    assert.equal(lastCommand(res.body).status, 'rejected');
    parseAs('assign_task', { task_title: 'OAuth refresh bug', assignee: 'Priyanka' });
    res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Assign the OAuth refresh bug' });
    assert.equal(lastCommand(res.body).status, 'needs_clarification');
    assert.match(lastMessage(res.body), /Who should it be assigned to/);
  });

  it('assign_task: choices for an ambiguous name and date, a card, permission checks, execution and undo', async () => {
    parseAs('assign_task', { task_title: 'OAuth refresh bug', assignee: 'Priya', due_date_text: 'next Friday', priority: 'high' });
    let res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Assign the OAuth refresh bug to Priya, due next Friday, high priority.' });
    let cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'needs_clarification');
    const pend = cmd.resolution.pending;
    assert.deepEqual(pend.map((p) => p.key).sort(), ['assignee', 'due']);
    const due = pend.find((p) => p.key === 'due');
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/choose`, { key: 'due', optionId: due.options[0].id });
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/choose`, { key: 'assignee', optionId: ids.priyaS });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation', JSON.stringify(cmd.resolution));
    assert.equal(cmd.plan.action, 'jira_create');
    assert.equal(cmd.plan.assignee.userId, ids.priyaS);
    assert.equal(cmd.plan.dueDate, due.options[0].id);
    assert.equal(jira.state.created, 0, 'nothing written before confirmation');
    assert.equal((await as('emp').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {})).status, 404, 'commands are private');

    let conf = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    assert.equal(conf.status, 409);
    assert.equal(conf.body.error.code, 'JIRA_PERMISSION_DENIED', 'the manager lacks CREATE_ISSUES in Jira');
    assert.equal(lastCommand((await as('mgr').get(`/api/v1/assistant/conversations/${cmd.conversationId}`)).body).status, 'failed');

    // Grant Jira permissions and try again with a fresh command.
    jira.state.permissions['acc-max'] = ['CREATE_ISSUES', 'ASSIGN_ISSUES', 'DELETE_ISSUES', 'EDIT_ISSUES'];
    parseAs('assign_task', { task_title: 'OAuth refresh bug', assignee: 'Priya Shah', due_date_text: 'by 20 December', priority: 'high' });
    res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Assign the OAuth refresh bug to Priya Shah by 20 December, high priority', conversationId: cmd.conversationId });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation');
    conf = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    cmd = lastCommand(conf.body);
    assert.equal(cmd.status, 'executed');
    assert.match(cmd.externalKey, /^PAY-/);
    assert.equal(cmd.canUndo, true);
    const created = jira.state.issues.find((i) => i.key === cmd.externalKey);
    assert.equal(created.fields.priority.name, 'High');
    assert.equal(created.fields.assignee.accountId, 'acc-priya');
    assert.ok(created.fields.labels.includes(`workagent-command-${cmd.id}`));
    assert.match(JSON.stringify(created.fields.description), /Requested by Max Manager/);
    const notif = await one("SELECT title FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [ids.priyaS]);
    assert.match(notif.title, /^Max Manager assigned you PAY-/, 'the requester’s name, not WorkAgent’s');
    assert.equal((await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {})).status, 409, 'never executes twice');
    const audit = await one("SELECT after_json FROM audit_logs WHERE action = 'assistant.command_executed' AND entity_id = ?", [cmd.id]);
    const after = typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json;
    assert.equal(after.utterance, 'Assign the OAuth refresh bug to Priya Shah by 20 December, high priority');
    assert.equal(after.externalKey, cmd.externalKey);

    const undone = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/undo`);
    assert.equal(undone.status, 200);
    assert.equal(lastCommand(undone.body).status, 'undone');
    assert.ok(jira.state.deleted.includes(cmd.externalKey));
  });

  it('undo outside the window is refused and a failed undo is reported as failed', async () => {
    parseAs('assign_task', { task_title: 'Rotate keys', assignee: 'Priya Shah' });
    let res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Assign rotate keys to Priya Shah' });
    let cmd = lastCommand(res.body);
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    cmd = lastCommand(res.body);
    jira.state.failNext.push({ match: /DELETE \/ex\/jira\/.*\/issue\//, status: 403, body: { errorMessages: ['No permission'] } });
    const failed = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/undo`);
    assert.notEqual(failed.status, 200);
    const conv = (await as('mgr').get(`/api/v1/assistant/conversations/${cmd.conversationId}`)).body;
    assert.equal(lastCommand(conv).status, 'undo_failed');
    assert.match(lastMessage(conv), /Undo failed — the change is still in place/);
    await pool.execute('UPDATE command_invocations SET status = \'executed\', undo_deadline = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [cmd.id]);
    const expired = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/undo`);
    assert.equal(expired.body.error.code, 'UNDO_EXPIRED');
  });

  it('update_task on a WorkAgent task: managers may, the card shows the priority mapping, undo restores', async () => {
    parseAs('update_task', { task_reference: 'the payment integration task', priority: 'critical' });
    let res = await as('emp').post('/api/v1/assistant/messages', { text: 'Change the priority of the payment integration task to critical' });
    let cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'needs_clarification', 'the task and the Jira issue both match');
    res = await as('emp').post(`/api/v1/assistant/commands/${cmd.id}/choose`, { key: 'task', optionId: ids.task });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation', JSON.stringify(cmd));
    assert.ok(cmd.plan.blockers.length, 'an assignee may only change the status');
    assert.equal((await as('emp').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {})).body.error.code, 'COMMAND_BLOCKED');

    res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Change the priority of the payment integration task to critical' });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'needs_clarification', 'the task and the Jira issue both match');
    const pick = cmd.resolution.pending[0].options.find((o) => o.kind === 'action_item');
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/choose`, { key: 'task', optionId: pick.id });
    cmd = lastCommand(res.body);
    assert.equal(cmd.plan.changes.priority, 'high');
    assert.match(cmd.plan.warnings.join(' '), /saved as “high”/);
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await one('SELECT priority FROM action_items WHERE id = ?', [ids.task])).priority, 'high');
    res = await as('mgr').post(`/api/v1/assistant/commands/${lastCommand(res.body).id}/undo`);
    assert.equal(res.status, 200);
    assert.equal((await one('SELECT priority FROM action_items WHERE id = ?', [ids.task])).priority, 'medium');
  });

  it('set_deadline on a Jira issue checks EDIT_ISSUES and restores on undo', async () => {
    parseAs('set_deadline', { task_reference: 'PAY-1', due_date_text: '30 December' });
    let res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Set the deadline of PAY-1 to 30 December' });
    let cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation', JSON.stringify(cmd.resolution) + lastMessage(res.body));
    assert.equal(cmd.plan.provider, 'jira');
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(jira.state.issues.find((i) => i.key === 'PAY-1').fields.duedate, /-12-30$/);
    res = await as('mgr').post(`/api/v1/assistant/commands/${lastCommand(res.body).id}/undo`);
    assert.equal(res.status, 200);
    assert.equal(jira.state.issues.find((i) => i.key === 'PAY-1').fields.duedate, null);
  });

  it('create_meeting: group + earlier meeting attendees, clarification for time, card, WorkAgent invitations, undo cancels', async () => {
    const d = await as('admin').post('/api/v1/departments', { name: 'Payments' });
    for (const u of [ids.priyaS, ids.priyaN]) await request(app).patch(`/api/v1/users/${u}`).set('Cookie', cookies.admin).send({ departmentId: d.body.department.id });
    parseAs('create_meeting', { meeting_title: 'design review', attendees: ['the Payments department'], start_text: 'Thursday at 4 PM' });
    let res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Schedule a design review with the Payments department Thursday at 4 PM' });
    let cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'needs_clarification');
    assert.match(lastMessage(res.body), /How long/);
    parseAs('create_meeting', { meeting_title: 'design review', attendees: ['the Payments department'], start_text: 'Thursday at 4 PM' });
    res = await as('mgr').post('/api/v1/assistant/messages', { text: 'for one hour', conversationId: cmd.conversationId });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation', JSON.stringify(cmd.resolution));
    assert.equal(cmd.plan.recipientCount, 2);
    assert.equal(cmd.plan.meetingInput.durationMinutes, 60);
    assert.equal(cmd.plan.provider, 'workagent');
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/confirm`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    cmd = lastCommand(res.body);
    assert.ok(cmd.meetingId);
    res = await as('mgr').post(`/api/v1/assistant/commands/${cmd.id}/undo`);
    assert.match(lastMessage(res.body), /before any invitation went out/);
    assert.equal((await one('SELECT status FROM meeting_schedules WHERE meeting_id = ?', [cmd.meetingId])).status, 'cancelled');

    parseAs('create_meeting', { meeting_title: 'follow-up', attendees_from_meeting: 'this morning’s standup', start_text: 'tomorrow at 10am' });
    res = await as('mgr').post('/api/v1/assistant/messages', { text: 'Book a 30-minute follow-up with everyone who was in this morning’s standup tomorrow at 10am' });
    cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'awaiting_confirmation', JSON.stringify(cmd.resolution));
    assert.deepEqual(cmd.plan.invitees.map((p) => p.id).sort(), [ids.emp, ids.priyaN].sort(), 'the standup’s participants minus the organiser');
  });

  it('query_status answers from WorkAgent records without confirmation', async () => {
    parseAs('query_status', { query: 'overdue_tasks' });
    const res = await as('emp').post('/api/v1/assistant/messages', { text: 'Show me all overdue tasks assigned to me' });
    const cmd = lastCommand(res.body);
    assert.equal(cmd.status, 'answered');
    assert.deepEqual(cmd.result.items.map((i) => i.ref), [{ type: 'action_item', id: ids.task }]);
    assert.match(cmd.result.text, /^1 overdue task for you/);
    parseAs('query_status', { query: 'my_tasks', query_person: 'Max Manager' });
    const other = await as('emp').post('/api/v1/assistant/messages', { text: 'What are Max Manager’s tasks?' });
    assert.match(lastCommand(other.body).result.text, /your own tasks/);
  });

  it('says so when WorkAPI is not configured, and voice goes through the speech abstraction', async () => {
    workapi.isConfigured = () => false;
    const res = await as('emp').post('/api/v1/assistant/messages', { text: 'Assign X to Y' });
    assert.match(lastMessage(res.body), /not configured/);
    workapi.isConfigured = () => true;
    const noSpeech = await request(app).post('/api/v1/assistant/transcribe').set('Cookie', cookies.emp).set('Content-Type', 'audio/webm').send(Buffer.from('abc'));
    assert.equal(noSpeech.body.error.code, 'SPEECH_NOT_CONFIGURED');
    let sent;
    configureSpeech({ provider: 'google', apiKey: 'test-speech-key-123', fetch: async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify({ results: [{ alternatives: [{ transcript: 'show my overdue tasks', confidence: 0.9 }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const ok = await request(app).post('/api/v1/assistant/transcribe').set('Cookie', cookies.emp).set('Content-Type', 'audio/webm;codecs=opus').send(Buffer.from('fake-audio'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.text, 'show my overdue tasks');
    assert.equal(sent.init.headers['X-Goog-Api-Key'], 'test-speech-key-123');
    assert.ok(!String(sent.url).includes('test-speech-key'), 'the key is never in the URL');
    const caps = (await as('emp').get('/api/v1/assistant/capabilities')).body;
    assert.equal(caps.speech.configured, true);
    assert.equal(JSON.stringify(caps).includes('test-speech-key'), false);
  });
});
