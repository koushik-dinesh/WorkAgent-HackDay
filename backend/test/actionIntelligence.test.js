// Action intelligence: action items from every source (not only transcripts), owner and team
// resolution, ambiguous names, deadline resolution, evidence, cross-source de-duplication,
// progress/completion evidence from linked work, and the Action Center's views, visibility,
// evidence trail and review rules.
// MOCKED: WorkAPI is a stub returning fixed JSON (it never calls Gemini or Claude). Synced records are
// rows as the Teams/Jira/GitHub connectors store them.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { classifyCategory, enrichItems, fingerprint, resolveTeam } from '../src/services/actions/intelligence.js';
import { refresh as refreshProgress } from '../src/services/actions/progress.js';
import { hasSignal, scan } from '../src/services/actions/sourceExtraction.js';
import { workapi } from '../src/services/workapi/index.js';
import { resolveDeadline } from '../src/utils/dates.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const originalWorkapi = { ...workapi };
const ids = {};
const cookies = {};
let prompts;
let answer; // (prompt) => { action_items: [...] }

const ev = (ref, quote, speaker = null) => ({ segment_ref: ref, speaker, timestamp: null, quote });
const item = (o) => ({ description: '', category: null, assignee_confidence: 0.95, owner_kind: 'explicit', owner_team_raw: null, due_date_raw: null, due_date_resolved: null, due_date_is_ambiguous: false, priority: 'medium', ai_confidence: 0.9, needs_review_reason: null, ...o });

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});

let seq = 0;
async function identity(provider, userId, name) {
  const [r] = await pool.execute("INSERT INTO external_identities (provider, source_instance, external_user_id, login, display_name, user_id, match_method) VALUES (?, 'src', ?, ?, ?, ?, 'manual')", [provider, `ext-${++seq}`, name, name, userId]);
  return r.insertId;
}
async function record({ provider = 'microsoft_teams', type = 'message', body, title = null, author, parent = null, key = null, project = null, state = null, category = 'unknown', at = new Date() }) {
  const conn = provider === 'jira' ? ids.jiraConn : provider === 'github' ? ids.githubConn : ids.teamsConn;
  const [r] = await pool.execute(
    `INSERT INTO external_records (provider, source_instance, record_type, external_id, external_key, connection_id, parent_record_id, url, title, body, state, status_category, author_identity_id, project_id, metadata, content_hash, source_created_at, source_updated_at)
     VALUES (?, 'src', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', SHA2(?, 256), ?, ?)`,
    [provider, type, `x-${++seq}`, key, conn, parent, `https://example.test/${seq}`, title ?? body?.slice(0, 60) ?? key, body, state, category, author ?? null, project, `${seq}:${body}`, at, at],
  );
  return r.insertId;
}
const items = async (where = '1=1', params = []) => (await pool.query(`SELECT * FROM action_items WHERE ${where} ORDER BY id`, params))[0];
const evidence = async (itemId) => (await pool.query('SELECT * FROM action_item_evidence WHERE action_item_id = ? ORDER BY id', [itemId]))[0];

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@violin.test', role: 'admin', fullName: 'Ada Admin' });
  ids.ben = await createUser({ email: 'ben@violin.test', role: 'manager', fullName: 'Ben Carter' });
  ids.priyaR = await createUser({ email: 'priya.r@violin.test', fullName: 'Priya Raman' });
  ids.priyaS = await createUser({ email: 'priya.s@violin.test', fullName: 'Priya Shah' });
  ids.samuel = await createUser({ email: 'samuel@violin.test', fullName: 'Samuel Osei' });
  ids.hannah = await createUser({ email: 'hannah@violin.test', fullName: 'Hannah Okoro' });
  ids.lead = await createUser({ email: 'lead@violin.test', role: 'manager', fullName: 'Lena Lead' });
  for (const who of ['admin', 'ben', 'samuel', 'lead', 'priyaR']) cookies[who] = await loginCookie(app, { admin: 'admin@violin.test', ben: 'ben@violin.test', samuel: 'samuel@violin.test', lead: 'lead@violin.test', priyaR: 'priya.r@violin.test' }[who]);
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.ben]);
  ids.P = p.insertId;
  const [t] = await pool.execute("INSERT INTO teams (name, lead_user_id) VALUES ('Design', ?)", [ids.lead]);
  ids.design = t.insertId;
  await pool.execute('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [ids.design, ids.samuel]);
  for (const [prov, key] of [['microsoft_teams', 'teamsConn'], ['jira', 'jiraConn'], ['github', 'githubConn']]) {
    const [c] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status) VALUES (?, 'src', ?, ?, 'active')", [prov, prov, prov]);
    ids[key] = c.insertId;
  }
  ids.idSamuel = await identity('microsoft_teams', ids.samuel, 'Samuel Osei');
  ids.idHannah = await identity('microsoft_teams', ids.hannah, 'Hannah Okoro');
  ids.idBen = await identity('microsoft_teams', ids.ben, 'Ben Carter');
  ids.idKenji = await identity('microsoft_teams', null, 'Kenji Watanabe');
});
beforeEach(async () => {
  prompts = [];
  workapi.isConfigured = () => true;
  workapi.model = () => 'test-model';
  workapi.generateJson = async (prompt) => {
    prompts.push(prompt);
    const data = answer(prompt);
    return { text: JSON.stringify(data), data, finishReason: 'stop', provider: 'test', model: 'test-model', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: null, attempts: 1, durationMs: 1 };
  };
});
afterEach(() => Object.assign(workapi, originalWorkapi));
after(closeDatabase);

describe('deterministic rules', () => {
  it('classifies actions into the closed set of categories, preferring a valid model answer', () => {
    assert.equal(classifyCategory('Unblock the payments migration'), 'blocker_resolution');
    assert.equal(classifyCategory('Check the contrast of the secondary button in the Figma mock'), 'design_correction');
    assert.equal(classifyCategory('Add a regression test for JPY amounts'), 'code_implementation');
    assert.equal(classifyCategory('Schedule a follow-up meeting with security'), 'meeting_scheduling');
    assert.equal(classifyCategory('Tell the product teams in the release channel'), 'communication_required');
    assert.equal(classifyCategory('Anything', 'review_request'), 'review_request');
    assert.equal(classifyCategory('Anything', 'world_domination'), 'task_assignment', 'unknown model categories are ignored');
  });

  it('resolves relative deadlines and leaves vague ones unresolved', () => {
    assert.equal(resolveDeadline('tomorrow', '2026-11-16').date, '2026-11-17');
    assert.equal(resolveDeadline('within three days', '2026-11-16').date, '2026-11-19');
    assert.equal(resolveDeadline('next Friday', '2026-11-16').ambiguous, true);
    assert.equal(resolveDeadline('before the release', '2026-11-16').recognized, false);
    const [i] = enrichItems([{ title: 'Ship it', assigneeUserId: null, assigneeNameRaw: null, dueDate: null, dueDateRaw: 'before the release', flags: [] }]);
    assert.equal(i.deadlineStatus, 'needs_clarification');
  });

  it('resolves team owners, and refuses ambiguous teams', () => {
    const idx = { teams: [{ id: 1, name: 'Design' }, { id: 2, name: 'Backend Engineering' }, { id: 3, name: 'Frontend Engineering' }], departments: [{ id: 9, name: 'Design' }] };
    assert.equal(resolveTeam('the design team', idx).teamId, 1);
    assert.ok(resolveTeam('engineering', idx).ambiguous, 'two engineering teams');
    const [i] = enrichItems([{ title: 'Review the checkout mocks', assigneeUserId: null, assigneeNameRaw: 'The design team', flags: ['unknown_assignee'] }], { teamsIndex: idx });
    assert.deepEqual([i.assigneeKind, i.assigneeTeamId], ['team', 1]);
    assert.ok(i.flags.includes('team_owner') && !i.flags.includes('unknown_assignee'));
  });

  it('fingerprints a commitment by owner and words, independent of order and phrasing details', () => {
    const a = fingerprint({ title: 'Add regression tests for JPY and EUR amounts', assigneeUserId: 5 });
    assert.equal(a, fingerprint({ title: 'add a regression test for EUR and JPY amount', assigneeUserId: 5 }));
    assert.notEqual(a, fingerprint({ title: 'Add regression tests for JPY and EUR amounts', assigneeUserId: 6 }));
  });

  it('pre-filters records without commitment language (no AI call)', () => {
    assert.equal(hasSignal('Works for me.'), false);
    assert.equal(hasSignal('I will add a regression test before we merge.'), true);
    assert.equal(hasSignal('This blocks the 4.2 release.'), true);
    assert.equal(hasSignal('Please check the contrast of the secondary button.'), true);
  });
});

describe('extraction from Teams, Jira and GitHub activity', () => {
  it('turns a Teams thread into reviewed items with owners, deadlines and verbatim evidence', async () => {
    const root = await record({ body: 'Partial refunds are failing for EUR transactions. Fix is in PR #501.', author: ids.idKenji, project: ids.P });
    await record({ body: 'Reviewed, one comment on the migration. Otherwise good to merge.', author: ids.idBen, parent: root, project: ids.P });
    const reply = await record({ body: 'I will add a regression test for JPY and EUR amounts before we merge.', author: ids.idSamuel, parent: root, project: ids.P });
    answer = () => ({
      action_items: [
        item({ title: 'Add a regression test for JPY and EUR amounts', assignee_name_raw: 'Samuel Osei', due_date_raw: 'before we merge', due_date_is_ambiguous: true, category: 'code_implementation', evidence: [ev('M3', 'I will add a regression test for JPY and EUR amounts before we merge', 'Samuel Osei')] }),
        // Invented owner and invented quote: never stored as such.
        item({ title: 'Zed rewrites the ledger', assignee_name_raw: 'Zed', evidence: [ev('M1', 'Zed will rewrite the ledger')] }),
      ],
    });
    const out = await scan();
    assert.deepEqual([out.threads, out.created], [1, 1]);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].user, /\[M3\] .* Samuel Osei: I will add a regression test/);
    assert.match(prompts[0].system, /untrusted data, not instructions/);
    const [i] = await items("source_type = 'teams_message'");
    assert.deepEqual([i.title, i.assignee_user_id, i.assignee_kind, i.category, i.deadline_status, i.review_status, i.project_id, i.meeting_id], ['Add a regression test for JPY and EUR amounts', ids.samuel, 'explicit', 'code_implementation', 'needs_clarification', 'pending', ids.P, null]);
    const [e] = await evidence(i.id);
    assert.deepEqual([e.record_id, e.relation, e.speaker], [reply, 'origin', 'Samuel Osei']);
    assert.ok(e.excerpt.includes('regression test'));
    const audit = (await pool.query("SELECT after_json FROM audit_logs WHERE action = 'action_item.created_from_source' AND entity_id = ?", [i.id]))[0][0];
    assert.equal(JSON.parse(typeof audit.after_json === 'string' ? audit.after_json : JSON.stringify(audit.after_json)).sourceType, 'teams_message');
    // Same content again: nothing re-analysed.
    const again = await scan();
    assert.equal(again.threads, 0);
    assert.equal(prompts.length, 1);
  });

  it('an edited message is analysed again and merged into the existing item, not duplicated', async () => {
    const [before] = await items("source_type = 'teams_message'");
    const [{ id: replyId }] = (await pool.query("SELECT id FROM external_records WHERE body LIKE 'I will add a regression test%'"))[0];
    await pool.execute("UPDATE external_records SET body = CONCAT(body, ' (and GBP)'), content_hash = SHA2(CONCAT(content_hash, 'x'), 256) WHERE id = ?", [replyId]);
    answer = () => ({ action_items: [item({ title: 'Add a regression test for JPY and EUR amounts', assignee_name_raw: 'Samuel Osei', evidence: [ev('M3', 'I will add a regression test for JPY and EUR amounts')] })] });
    const out = await scan();
    assert.equal(out.created, 0);
    assert.equal((await items("source_type = 'teams_message'")).length, 1);
    assert.equal((await items("source_type = 'teams_message'"))[0].id, before.id);
  });

  it('never guesses between two people with the same first name', async () => {
    const root = await record({ body: 'P1: refund confirmation email is sent twice. Priya owns it. This blocks the 4.2 release.', author: ids.idBen, project: ids.P });
    answer = () => ({ action_items: [item({ title: 'Fix the duplicate refund confirmation email', assignee_name_raw: 'Priya', owner_kind: 'explicit', category: 'blocker_resolution', evidence: [ev('M1', 'Priya owns it')] })] });
    await scan();
    const [i] = await items('source_record_id = ?', [root]);
    assert.equal(i.assignee_user_id, null);
    const flags = typeof i.flags === 'string' ? JSON.parse(i.flags) : i.flags;
    assert.ok(flags.includes('ambiguous_assignee'));
    assert.ok(flags.includes('blocker_reported'));
    const details = typeof i.review_details === 'string' ? JSON.parse(i.review_details) : i.review_details;
    assert.deepEqual(details.assignee.candidates.map((c) => c.fullName).sort(), ['Priya Raman', 'Priya Shah']);
  });

  it('records a team owner when a team, not a person, was named', async () => {
    const root = await record({ body: 'Checkout v3 mocks are in Figma. The design team needs to review the order summary by Wednesday.', author: ids.idBen, project: ids.P });
    answer = () => ({ action_items: [item({ title: 'Review the checkout v3 order summary', assignee_name_raw: 'The design team', owner_kind: 'team', owner_team_raw: 'the design team', due_date_raw: 'by Wednesday', category: 'review_request', evidence: [ev('M1', 'The design team needs to review the order summary by Wednesday')] })] });
    await scan();
    const [i] = await items('source_record_id = ?', [root]);
    assert.deepEqual([i.assignee_kind, i.assignee_team_id, i.assignee_user_id], ['team', ids.design, null]);
  });

  it('reads Jira and GitHub comments with their issue as context; quotes must be real', async () => {
    const issue = await record({ provider: 'jira', type: 'issue', key: 'PAY-42', title: 'Refund rounding', body: 'Rounding before conversion', project: ids.P });
    const comment = await record({ provider: 'jira', type: 'comment', body: '@Hannah Okoro can you update the API docs within three days?', parent: issue, author: ids.idBen, project: ids.P });
    const pr = await record({ provider: 'github', type: 'pull_request', key: 'violin/api#501', title: 'Idempotency keys', body: 'Adds validation', project: ids.P });
    await record({ provider: 'github', type: 'review_comment', body: 'Looks good.', parent: pr, author: ids.idBen, project: ids.P });
    answer = (p) =>
      p.user.includes('PAY-42')
        ? { action_items: [item({ title: 'Update the API docs', assignee_name_raw: 'Hannah Okoro', due_date_raw: 'within three days', category: 'communication_required', evidence: [ev('M1', 'can you update the API docs within three days')] })] }
        : { action_items: [item({ title: 'Merge the PR', assignee_name_raw: null, evidence: [ev('M1', 'This text is not in the comment')] })] };
    const out = await scan();
    assert.ok(out.skipped >= 1, '"Looks good." has no commitment language: no AI call');
    assert.ok(prompts.every((p) => !p.user.includes('Looks good')));
    const [i] = await items('source_record_id = ?', [comment]);
    assert.deepEqual([i.source_type, i.assignee_user_id, i.category, i.deadline_status], ['jira_comment', ids.hannah, 'communication_required', 'resolved']);
    const ev2 = await evidence(i.id);
    assert.deepEqual(ev2.map((e) => [e.relation, e.record_id]), [['origin', comment], ['supporting', issue]]);
  });

  it('the same commitment from a meeting and from Teams becomes one item with two pieces of evidence', async () => {
    const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, created_by, status, project_id) VALUES ('Migration sync', '', ?, 'review_pending', ?)", [ids.admin, ids.P]);
    const fp = fingerprint({ title: 'Chase security about the secrets manager', assigneeUserId: ids.hannah });
    const [mi] = await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, assignee_match, assignee_kind, fingerprint, flags) VALUES (?, ?, 'Chase security about the secrets manager', ?, 'exact', 'explicit', ?, '[]')", [m.insertId, ids.P, ids.hannah, fp]);
    const root = await record({ body: 'Blocker: payments needs the new secrets manager before it can move.', author: ids.idKenji, project: ids.P });
    await record({ body: 'I will chase security about the secrets manager today; target is to unblock by Tuesday.', author: ids.idHannah, parent: root, project: ids.P });
    answer = () => ({ action_items: [item({ title: 'Chase security about the secrets manager', assignee_name_raw: 'Hannah Okoro', due_date_raw: 'by Tuesday', evidence: [ev('M2', 'I will chase security about the secrets manager today')] })] });
    const out = await scan();
    assert.deepEqual([out.created, out.linked], [0, 1]);
    const evs = await evidence(mi.insertId);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].relation, 'supporting');
    const flags = (await items('id = ?', [mi.insertId]))[0].flags;
    assert.ok((typeof flags === 'string' ? JSON.parse(flags) : flags).includes('merged_sources'));
  });

  it('linked work that finished becomes completion evidence; the status is left to a person', async () => {
    const [[i]] = await pool.query("SELECT id FROM action_items WHERE title = 'Add a regression test for JPY and EUR amounts'");
    const pr = await record({ provider: 'github', type: 'pull_request', key: 'violin/api#519', title: 'JPY/EUR regression tests', body: 'tests', state: 'merged', category: 'done', project: ids.P });
    await pool.execute("INSERT INTO record_links (from_type, from_id, to_type, to_id, link_type, origin, status) VALUES ('action_item', ?, 'external_record', ?, 'implements', 'rule', 'confirmed')", [i.id, pr]);
    const out = await refreshProgress();
    assert.ok(out.evidence >= 1);
    const evs = await evidence(i.id);
    assert.ok(evs.some((e) => e.relation === 'completion' && e.record_id === pr));
    assert.equal((await items('id = ?', [i.id]))[0].task_status, 'todo');
    assert.equal((await refreshProgress()).evidence, 0, 'idempotent');
  });
});

describe('Action Center', () => {
  it('lists, filters and counts what each person may see', async () => {
    const all = await as('admin').get('/api/v1/actions?view=review');
    assert.equal(all.status, 200);
    assert.ok(all.body.items.length >= 4);
    assert.ok(all.body.items.every((i) => i.reviewStatus === 'pending'));
    const teams = await as('admin').get('/api/v1/actions?source=teams_message');
    assert.ok(teams.body.items.every((i) => i.sourceType === 'teams_message' && i.sourceLabel === 'Microsoft Teams'));
    const unassigned = await as('admin').get('/api/v1/actions?view=unassigned');
    assert.ok(unassigned.body.items.some((i) => i.title === 'Fix the duplicate refund confirmation email'));
    const summary = await as('admin').get('/api/v1/actions/summary');
    assert.ok(summary.body.counts.review >= 4);
    // The project's manager sees pending items of their project; an employee sees nothing pending.
    assert.ok((await as('ben').get('/api/v1/actions?view=review')).body.items.length >= 4);
    assert.equal((await as('samuel').get('/api/v1/actions?view=all')).body.items.length, 0);
  });

  it('shows the full evidence trail and review rules; approval needs a person', async () => {
    const [[blocker]] = await pool.query("SELECT id FROM action_items WHERE title = 'Fix the duplicate refund confirmation email'");
    const d = await as('ben').get(`/api/v1/actions/${blocker.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.actionItem.lifecycle, 'needs_review');
    assert.ok(d.body.evidence[0].record.url.startsWith('https://example.test/'));
    assert.ok(d.body.permissions.approvalProblems.includes('Choose an assignee'));
    const refused = await as('ben').post(`/api/v1/actions/${blocker.id}/approve`);
    assert.equal(refused.status, 409);
    const edited = await as('ben').patch(`/api/v1/actions/${blocker.id}`, { assigneeUserId: ids.priyaR });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.actionItem.assigneeKind, 'explicit');
    const ok = await as('ben').post(`/api/v1/actions/${blocker.id}/approve`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Employees cannot review; the owner now sees the approved item (no meeting needed).
    assert.equal((await as('samuel').post(`/api/v1/actions/${blocker.id}/reject`, {})).status, 404);
    const mine = await as('priyaR').get('/api/v1/actions?view=mine');
    assert.deepEqual(mine.body.items.map((i) => i.id), [blocker.id]);
    const myTasks = await as('priyaR').get('/api/v1/me/tasks');
    assert.ok(myTasks.body.tasks.some((t) => t.id === blocker.id && t.meeting === null));
    const history = (await as('ben').get(`/api/v1/actions/${blocker.id}`)).body.history.map((h) => h.action);
    assert.ok(history.includes('action_item.approved') && history.includes('action_item.created_from_source'));
  });

  it('team leads see approved work of their team; owners change the status', async () => {
    const [[i]] = await pool.query("SELECT id FROM action_items WHERE title = 'Add a regression test for JPY and EUR amounts'");
    await as('ben').patch(`/api/v1/actions/${i.id}`, { dueDate: '2026-12-01', resolveFlags: [] });
    const flags = (await as('ben').get(`/api/v1/actions/${i.id}`)).body.actionItem.flags.filter((f) => !['missing_deadline', 'merged_duplicates', 'completion_evidence', 'merged_sources', 'blocker_reported'].includes(f));
    if (flags.length) await as('ben').patch(`/api/v1/actions/${i.id}`, { resolveFlags: flags });
    assert.equal((await as('ben').post(`/api/v1/actions/${i.id}/approve`)).status, 200);
    const lead = await as('lead').get('/api/v1/actions?view=all');
    assert.ok(lead.body.items.some((x) => x.id === i.id), 'Samuel is in the Design team Lena leads');
    const done = await as('samuel').post(`/api/v1/actions/${i.id}/status`, { status: 'done' });
    assert.equal(done.status, 200);
    assert.equal(done.body.actionItem.taskStatus, 'done');
    const det = await as('ben').get(`/api/v1/actions/${i.id}`);
    assert.equal(det.body.workStatus.status, 'done');
    assert.ok(det.body.workStatus.signals.some((s) => s.signal === 'completion'));
  });
});
