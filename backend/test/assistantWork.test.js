// Assistant work-graph intents (services/assistant/work.js): grounded intent/slot parsing,
// read-only answers from the work graph (counted in code), ambiguous references as choices, and
// bulk operations as execution-engine plans that need confirmation (cancel window = undo).
// MOCKED: WorkAPI is a stub returning the parse we script; e-mail is a fake provider.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { normalizeParse } from '../src/services/assistant/parser.js';
import { email } from '../src/services/email/index.js';
import * as engine from '../src/services/execution/index.js';
import { workapi } from '../src/services/workapi/index.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
let cookie;
let nextParse;
const originalWorkapi = { ...workapi };
const originalEmail = { ...email };
const originalCancel = engine.engineSettings.cancelSeconds;
const sent = [];

const slots = (o = {}) => ({ task_reference: null, task_title: null, description: null, assignee: null, project: null, priority: null, status: null, due_date_text: null, due_date: null, meeting_title: null, attendees: [], attendees_from_meeting: null, start_text: null, start_datetime: null, duration_minutes: null, calendar_provider: null, query: null, query_person: null, work_query: null, operation: null, selection: null, item_kind: null, meeting_reference: null, period_text: null, recipients: null, ...o });
const parseAs = (intent, s, missing = []) => (nextParse = { intent, slots: slots(s), missing, clarification_question: null });
const say = async (text, conversationId = null) => {
  const res = await request(app).post('/api/v1/assistant/messages').set('Cookie', cookie).send({ text, conversationId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const conv = res.body;
  return { conv, cmd: conv.commands.at(-1), last: conv.messages.at(-1).content };
};

async function item(title, { meeting = null, category = 'code_implementation', status = 'todo', due = null, assignee = ids.eve, review = 'approved', source = 'meeting', flags = [] } = {}) {
  const [r] = await pool.execute(
    "INSERT INTO action_items (meeting_id, project_id, source_type, title, category, assignee_user_id, assignee_match, assignee_kind, review_status, task_status, due_date, flags) VALUES (?, ?, ?, ?, ?, ?, 'exact', 'explicit', ?, ?, ?, ?)",
    [meeting, ids.P, source, title, category, assignee, review, status, due, JSON.stringify(flags)],
  );
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@w.test', role: 'admin', fullName: 'Ada Admin' });
  ids.eve = await createUser({ email: 'eve@w.test', fullName: 'Eve Engineer' });
  ids.dan = await createUser({ email: 'dan@w.test', fullName: 'Dan Designer' });
  cookie = await loginCookie(app, 'admin@w.test');
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
  ids.P = p.insertId;
  await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments Mobile', ?, 'active')", [ids.admin]);
  const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, project_id, scheduled_at, started_at) VALUES ('Design review', '', 'approved', ?, ?, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY)", [ids.admin, ids.P]);
  ids.M = m.insertId;
  await pool.execute('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?), (?, ?)', [ids.M, ids.eve, ids.M, ids.dan]);
  ids.a = await item('Fix the payout rounding', { meeting: ids.M });
  ids.b = await item('Tighten the checkout spacing', { meeting: ids.M, category: 'design_correction', assignee: ids.dan });
  ids.c = await item('Unblock the secrets manager migration', { category: 'blocker_resolution', status: 'blocked', source: 'teams_message', flags: ['blocker_reported'] });
  ids.d = await item('Send the incident post-mortem', { due: '2026-01-02', category: 'communication_required' });
  await pool.execute("INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, relation) VALUES (?, 'Payments needs the new secrets manager before it can move', 'Kenji', 'origin')", [ids.c]);
  workapi.isConfigured = () => true;
  workapi.generateJson = async () => ({ text: JSON.stringify(nextParse), data: nextParse, finishReason: 'STOP', provider: 'test', model: 'stub', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, attempts: 1, durationMs: 1 });
  email.isConfigured = () => true;
  email.configurationProblem = () => null;
  email.from = () => 'noreply@w.test';
  email.getProvider = () => ({ name: 'fake', send: async (m) => (sent.push(m), { messageId: `m${sent.length}` }) });
});
beforeEach(() => {
  engine.engineSettings.cancelSeconds = () => 60;
});
after(async () => {
  Object.assign(workapi, originalWorkapi);
  Object.assign(email, originalEmail);
  engine.engineSettings.cancelSeconds = originalCancel;
  await closeDatabase();
});

describe('intent classification', () => {
  it('keeps operations and queries only when their words were said', () => {
    const ok = normalizeParse({ intent: 'act_on_actions', slots: slots({ operation: 'create_jira_issues', item_kind: 'engineering', selection: 'approved' }), missing: [] }, 'Create Jira tickets for all approved engineering action items');
    assert.deepEqual([ok.intent, ok.slots.operation, ok.slots.item_kind, ok.slots.selection, ok.missing], ['act_on_actions', 'create_jira_issues', 'engineering', 'approved', []]);
    const bad = normalizeParse({ intent: 'act_on_actions', slots: slots({ operation: 'email_owners', item_kind: 'marketing' }), missing: [] }, 'Do the thing for engineering');
    assert.deepEqual([bad.slots.operation, bad.slots.item_kind], [null, null], 'ungrounded slots are dropped');
    assert.match(bad.question, /What should I do with those action items/);
    const unknown = normalizeParse({ intent: 'delete_everything', slots: slots(), missing: [] }, 'Delete everything');
    assert.equal(unknown.intent, 'unsupported');
  });
});

describe('questions about the work graph', () => {
  it('lists action items from yesterday’s meetings', async () => {
    parseAs('query_work', { work_query: 'action_items', meeting_reference: 'yesterday’s meetings' });
    const { cmd, last } = await say('Show me all action items from yesterday’s meetings.');
    assert.equal(cmd.status, 'answered');
    assert.match(last, /^2 action items from yesterday’s meetings/);
    assert.deepEqual(cmd.result.items.map((i) => i.title).sort(), ['Fix the payout rounding', 'Tighten the checkout spacing']);
  });

  it('answers overdue commitments and who blocks a project, with the blocker’s evidence', async () => {
    parseAs('query_work', { work_query: 'overdue_commitments' });
    let r = await say('Which commitments are overdue?');
    assert.match(r.last, /^1 overdue commitment/);
    assert.equal(r.cmd.result.items[0].title, 'Send the incident post-mortem');
    parseAs('query_work', { work_query: 'project_blockers', project: 'Payments' });
    r = await say('Who is blocking the Payments project?');
    assert.equal(r.cmd.status, 'needs_clarification', '“Payments” matches two projects');
    const choice = r.cmd.resolution.pending[0];
    const chosen = await request(app).post(`/api/v1/assistant/commands/${r.cmd.id}/choose`).set('Cookie', cookie).send({ key: choice.key, optionId: choice.options.find((o) => o.label === 'Payments').id });
    const cmd = chosen.body.commands.at(-1);
    assert.equal(cmd.status, 'answered');
    assert.match(chosen.body.messages.at(-1).content, /1 blocked item in Payments; owners: Eve Engineer/);
    assert.match(cmd.result.items[0].blocker, /secrets manager/);
  });

  it('compares what was promised with the linked progress', async () => {
    parseAs('query_work', { work_query: 'promised_vs_progress', meeting_reference: 'the design review' });
    const { cmd, last } = await say('Compare what was promised in the design review with the actual GitHub progress');
    assert.equal(cmd.status, 'answered', JSON.stringify(cmd));
    assert.match(last, /2 commitments from “Design review”: 0 done, 0 with finished linked work .* 2 with no linked activity/);
  });
});

describe('bulk operations through the execution engine', () => {
  it('e-mails owners of pending items only after confirmation, and the cancel window undoes it', async () => {
    parseAs('act_on_actions', { operation: 'email_owners', selection: 'pending' });
    const { cmd } = await say('Email everyone who has pending action items.');
    assert.equal(cmd.status, 'awaiting_confirmation');
    assert.equal(cmd.plan.action, 'engine_plan');
    const recipients = cmd.plan.engine.preview.recipients.map((r) => r.email).sort();
    assert.deepEqual(recipients, ['dan@w.test', 'eve@w.test']);
    assert.ok(cmd.plan.engine.preview.drafts.every((d) => d.content?.subject && d.content?.body));
    assert.equal(sent.length, 0);
    const confirmed = await request(app).post(`/api/v1/assistant/commands/${cmd.id}/confirm`).set('Cookie', cookie).send({});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const after = confirmed.body.commands.at(-1);
    assert.equal(after.status, 'executed');
    assert.equal(after.canUndo, true);
    const undone = await request(app).post(`/api/v1/assistant/commands/${cmd.id}/undo`).set('Cookie', cookie).send({});
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    const plan = (await pool.query('SELECT status, command_id FROM action_plans WHERE id = ?', [cmd.plan.engine.planId]))[0][0];
    assert.deepEqual([plan.status, plan.command_id], ['cancelled', cmd.id]);
    assert.equal(sent.length, 0, 'nothing was sent');
  });

  it('says plainly when the operation cannot run (no Jira connected)', async () => {
    parseAs('act_on_actions', { operation: 'create_jira_issues', item_kind: 'engineering', selection: 'approved' });
    const { cmd } = await say('Create Jira tickets for all approved engineering action items');
    assert.equal(cmd.status, 'awaiting_confirmation');
    assert.equal(cmd.plan.engine.planId, null);
    assert.ok(cmd.plan.blockers.length);
    assert.ok(cmd.plan.engine.preview.drafts.every((d) => d.blockers.some((b) => /No Jira project/.test(b))));
    const res = await request(app).post(`/api/v1/assistant/commands/${cmd.id}/confirm`).set('Cookie', cookie).send({});
    assert.equal(res.status, 409);
  });

  it('asks instead of guessing when nothing matches', async () => {
    parseAs('act_on_actions', { operation: 'notify_owners', item_kind: 'quantum' });
    const { cmd, last } = await say('Notify owners of the quantum action items');
    assert.equal(cmd.status, 'needs_clarification');
    assert.match(last, /don’t know which action items “quantum” means/);
  });
});
