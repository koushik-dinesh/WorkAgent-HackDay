// Meeting pipeline across connectors, end to end through the API, sync engine, job queue and DB:
//
//   Teams meeting (Graph) ──▶ transcript import ──▶ WorkAgent meeting
//   (Google Meet transcripts come from the Vexa bot: test/vexaAuto.test.js)
//   ──▶ AI extraction ──▶ assignee + deadline validation ──▶ admin approval ──▶ Jira issue
//
// MOCKED, NOT LIVE: Microsoft Graph, Google Calendar and Jira are local fakes on 127.0.0.1
// (test/integrations/fake*.js) and WorkAPI (the AI layer) is a stub returning a fixed response. These tests prove
// WorkAgent's own logic and its HTTP contract with each fake; they do not prove that Microsoft,
// Google, Atlassian or Anthropic behave the same way. Live verification steps: runbook §12, §15.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import { workapi } from '../src/services/workapi/index.js';
import { runExport } from '../src/services/externalTasks.js';
import { configureGoogle, resetGoogleSettings } from '../src/services/integrations/providers/google/calendar.js';
import { configureJira, resetJiraSettings } from '../src/services/integrations/providers/jira/settings.js';
import { configureMicrosoft, resetMicrosoftSettings } from '../src/services/integrations/providers/microsoft/graph.js';
import teams, { TEAMS_CHANNEL_SCOPES, meetingEnvelopes, meetingsEnabled } from '../src/services/integrations/providers/microsoft/teams.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { enqueueDue, importRecord, transcriptKinds } from '../src/services/transcripts/importer.js';
import { CLIENT_ID as G_CLIENT_ID, CLIENT_SECRET as G_CLIENT_SECRET, DOMAIN as G_DOMAIN, calendar, meetEvent, startFakeGoogle } from './integrations/fakeGoogle.js';
import { SITE_URL, issue as jiraIssue, person, project as jiraProject, startFakeJira } from './integrations/fakeJira.js';
import { CLIENT_ID, CLIENT_SECRET, TENANT, event, onlineMeeting, startFakeMicrosoft } from './integrations/fakeMicrosoft.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
// An explicit date ten days after the meeting (the validator refuses implausibly distant ones).
const DUE = new Date(Date.now() + 10 * 24 * HOUR).toISOString().slice(0, 10);
const TEAMS_VTT = `WEBVTT

00:00:01.000 --> 00:00:05.000
<v Ada Admin>Thanks for joining the refund review.</v>

00:00:06.000 --> 00:00:12.000
<v Raj Kumar>I'll fix the partial refund bug by ${DUE}.</v>

00:00:13.000 --> 00:00:18.000
<v Ada Admin>Great, Raj owns the refund fix.</v>
`;

let ms;
let google;
let jira;
const original = { ...workapi };
const app = createApp();
const ids = {};
let cookie;
const as = {
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
};
const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];
const all = async (sql, params = []) => (await pool.query(sql, params))[0];

/** Runs queued jobs until none is ready (sync, import, extraction, export, correlation, ...). */
async function drain(max = 200) {
  const handlers = handlersFor([]);
  for (let i = 0; i < max; i++) if (!(await processNext('test-worker', handlers))) return;
  throw new Error('jobs did not drain');
}
async function syncAll(resourceId) {
  for (let i = 0; i < 40; i++) {
    try {
      return await syncEngine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
  throw new Error('sync did not finish');
}
async function connect(provider, code) {
  const start = await as.post(`/api/v1/integrations/${provider}/connect`);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const state = new URL(start.body.redirectUrl).searchParams.get('state');
  const res = await as.post(`/api/v1/integrations/${provider}/callback`, { state, params: { code } });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body)); // 200 = reconnected
  return res.body;
}

// Stub WorkAPI: a well-behaved answer for each transcript, quoting it verbatim.
const ev = (ref, quote) => ({ segment_ref: ref, speaker: null, timestamp: null, quote });
const item = (o) => ({ description: '', assignee_confidence: 0.95, due_date_resolved: null, due_date_is_ambiguous: false, priority: 'high', ai_confidence: 0.95, needs_review_reason: null, ...o });
const prompts = [];
function stubWorkapi() {
  workapi.isConfigured = () => true;
  workapi.model = () => 'claude-test-model';
  workapi.generateJson = async (prompt) => {
    prompts.push(prompt);
    const body = prompt.user.includes('refund bug')
      ? { action_items: [item({ title: 'Fix the partial refund bug', assignee_name_raw: 'Raj Kumar', due_date_raw: `by ${DUE}`, due_date_resolved: DUE, evidence: [ev('S2', `I'll fix the partial refund bug by ${DUE}`)] })] }
      : { action_items: [item({ title: 'Update the onboarding checklist', assignee_name_raw: 'Raj Kumar', due_date_raw: null, evidence: [ev('S2', 'I will update the onboarding checklist')] })] };
    return { text: JSON.stringify(body), data: body, finishReason: 'end_turn', provider: 'test', model: 'claude-test-model', usage: { inputTokens: 900, outputTokens: 120 }, costUsd: null, attempts: 1, durationMs: 1 };
  };
}

before(async () => {
  [ms, google, jira] = await Promise.all([startFakeMicrosoft(), startFakeGoogle(), startFakeJira()]);
  configureMicrosoft({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT, loginUrl: ms.url, graphUrl: ms.url, appPublicUrl: 'http://localhost:5173' });
  configureGoogle({ clientId: G_CLIENT_ID, clientSecret: G_CLIENT_SECRET, domain: G_DOMAIN, authUrl: google.url, tokenUrl: `${google.url}/token`, calendarUrl: google.url, appPublicUrl: 'http://localhost:5173' });
  configureJira({ clientId: 'jira-client-id-123', clientSecret: 'jira-client-secret-456', siteUrl: SITE_URL, webhookSecret: undefined, issueCreation: true, authUrl: jira.url, apiUrl: jira.url, redirectUri: 'http://localhost:5173/integrations/jira/setup' });
  stubWorkapi();

  await resetDatabase();
  ids.admin = await createUser({ email: 'ada@contoso.test', role: 'admin', fullName: 'Ada Admin' });
  ids.raj = await createUser({ email: 'raj@contoso.test', role: 'employee', fullName: 'Raj Kumar' });
  cookie = await loginCookie(app, 'ada@contoso.test');
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
  ids.P = p.insertId;

  // Microsoft: an ended Teams meeting with a transcript, a future one, and a non-Teams event.
  const now = Date.now();
  const cal = { id: 'AAMkCal', name: 'Calendar', events: [] };
  ms.state.calendars.push(cal);
  ids.teamsEvent = event(ms.state, cal, { id: 'ev-review', subject: 'Refund review', start: iso(now - 3 * HOUR), end: iso(now - 2 * HOUR), organizer: 'ada@contoso.test' });
  onlineMeeting(ms.state, ids.teamsEvent, { vtt: TEAMS_VTT });
  event(ms.state, cal, { id: 'ev-planning', subject: 'Payments planning', start: iso(now + 48 * HOUR), end: iso(now + 49 * HOUR) });
  event(ms.state, cal, { id: 'ev-lunch', subject: 'Lunch', start: iso(now - 5 * HOUR), end: iso(now - 4 * HOUR), online: false });

  // Jira: one project with an issue reported by Raj (so his Jira account becomes a known identity).
  jira.state.sites[0].scopes = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
  const pay = jiraProject(jira.state, { id: 10000, key: 'PAY', name: 'Payments' });
  jiraIssue(jira.state, pay, { id: 20001, number: 1, summary: 'Refund API returns 500', updated: iso(now - 24 * HOUR), reporter: person('acc-raj', 'Raj Kumar') });
});

after(async () => {
  Object.assign(workapi, original);
  resetMicrosoftSettings();
  resetGoogleSettings();
  resetJiraSettings();
  await Promise.all([ms.close(), google.close(), jira.close()]);
  await closeDatabase();
});

describe('Teams meeting discovery (connector, fake Graph)', () => {
  it('only Teams online meetings become teams_meeting records; deletions are tombstones', () => {
    const src = 'microsoft:t';
    const teamsEv = { id: 'a', subject: 'Sync', isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/a' }, start: { dateTime: '2026-11-10T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-10T10:00:00.0000000', timeZone: 'UTC' }, organizer: { emailAddress: { address: 'Ada@Contoso.test', name: 'Ada' } }, attendees: [{ emailAddress: { address: 'raj@contoso.test' } }] };
    const [identity, record, activity] = meetingEnvelopes(src, teamsEv, new Date('2026-11-14T00:00:00Z'));
    assert.equal(identity.email, 'ada@contoso.test');
    assert.equal(record.recordType, 'teams_meeting');
    assert.deepEqual([record.state, record.statusCategory, record.metadata.start, record.metadata.end], ['ended', 'done', '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z']);
    assert.deepEqual(record.metadata.attendees, ['raj@contoso.test']);
    assert.equal(activity.activityType, 'scheduled');
    assert.deepEqual(meetingEnvelopes(src, { ...teamsEv, onlineMeetingProvider: 'skypeForBusiness' }), []);
    assert.deepEqual(meetingEnvelopes(src, { ...teamsEv, isOnlineMeeting: false }), []);
    assert.equal(meetingEnvelopes(src, { id: 'a', '@removed': { reason: 'deleted' } })[0].deleted, true);
  });

  it('meeting features need all three meeting scopes; channels alone stay usable', async () => {
    assert.equal(meetingsEnabled({ settings: { scopes: TEAMS_CHANNEL_SCOPES } }), false);
    assert.equal(meetingsEnabled({ settings: { scopes: [...TEAMS_CHANNEL_SCOPES, 'Calendars.Read', 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'] } }), true);
    const ctx = { connection: { settings: { scopes: TEAMS_CHANNEL_SCOPES } } };
    await assert.rejects(teams.syncStream(ctx, { stream: 'meetings', resource: {}, cursor: null, phase: 'backfill' }), (e) => e.kind === 'forbidden' && /admin consent/.test(e.publicMessage));
    await assert.rejects(teams.fetchTranscript(ctx, { metadata: { joinUrl: 'https://x' } }), (e) => e.kind === 'forbidden');
  });
});

describe('Teams meeting → transcript → AI → review → Jira (end to end, all mocked)', () => {
  it('connects Teams with the meeting scopes and offers a "Teams meetings" resource', async () => {
    const body = await connect('microsoft_teams', ms.grantCode());
    ids.teamsConn = body.connection.id;
    const res = body.resources.find((r) => r.resourceType === 'meetings');
    assert.ok(res, 'meetings resource listed');
    assert.match(res.name, /^Teams meetings/);
    ids.meetingsRes = res.id;
  });

  it('a grant without the meeting scopes connects for channels only', async () => {
    const body = await connect('microsoft_teams', ms.grantCode('offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All'));
    assert.equal(body.connection.id, ids.teamsConn, 'same account: the connection is updated, not duplicated');
    assert.ok(!body.resources.some((r) => r.resourceType === 'meetings' && r.accessStatus === 'accessible'));
    // Grant everything again for the rest of the flow.
    const again = await connect('microsoft_teams', ms.grantCode());
    assert.ok(again.resources.some((r) => r.resourceType === 'meetings' && r.accessStatus === 'accessible'));
  });

  it('syncs only Teams online meetings of the calendar', async () => {
    const patched = await as.patch(`/api/v1/integrations/${ids.teamsConn}/resources/${ids.meetingsRes}`, { isEnabled: true, projectId: ids.P });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    await syncAll(ids.meetingsRes);
    const rows = await all("SELECT external_id, title, project_id, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.joinUrl')) AS join_url FROM external_records WHERE provider = 'microsoft_teams' AND record_type = 'teams_meeting' ORDER BY external_id");
    assert.deepEqual(rows.map((r) => [r.external_id, r.project_id]), [['ev-planning', ids.P], ['ev-review', ids.P]]);
    assert.match(rows[1].join_url, /meetup-join\/ev-review$/);
  });

  it('imports the ended meeting’s transcript into a new WorkAgent meeting and queues extraction', async () => {
    assert.equal(await enqueueDue(), 1, 'only the ended meeting is due');
    await drain();
    const rec = await one("SELECT id FROM external_records WHERE external_id = 'ev-review'");
    const imp = await one('SELECT status, meeting_id, transcript_ref FROM meeting_transcript_imports WHERE record_id = ?', [rec.id]);
    assert.equal(imp.status, 'imported');
    assert.equal(imp.transcript_ref, 'om-ev-review/tr-om-ev-review');
    ids.meeting = imp.meeting_id;
    const m = await one('SELECT title, platform, native_meeting_id, project_id, created_by, status FROM meetings WHERE id = ?', [ids.meeting]);
    assert.deepEqual([m.title, m.platform, m.native_meeting_id, m.project_id, m.created_by], ['Refund review', 'microsoft_teams', 'ev-review', ids.P, ids.admin]);
    assert.equal(m.status, 'review_pending', 'auto extraction ran (stubbed WorkAPI)');
    const participants = (await all('SELECT user_id FROM meeting_participants WHERE meeting_id = ? ORDER BY user_id', [ids.meeting])).map((r) => r.user_id);
    assert.deepEqual(participants, [ids.admin, ids.raj]);
    const t = await one("SELECT segment_count, JSON_VALUE(raw_json, '$.source') AS source FROM transcripts WHERE meeting_id = ?", [ids.meeting]);
    assert.deepEqual([t.segment_count, t.source], [3, 'microsoft_teams']);
    const link = await one("SELECT link_type, status FROM record_links WHERE (from_type = 'meeting' AND from_id = ?) OR (to_type = 'meeting' AND to_id = ?)", [ids.meeting, ids.meeting]);
    assert.deepEqual([link.link_type, link.status], ['same_as', 'confirmed']);
    assert.ok(prompts.at(-1).user.includes('Raj Kumar'), 'speaker names reach the prompt');
    assert.equal(await enqueueDue(), 0, 'never imported twice');
  });

  it('extraction matched the assignee and the deadline from the transcript; the item is approvable', async () => {
    const items = await all('SELECT id, title, assignee_user_id, assignee_match, DATE_FORMAT(due_date, "%Y-%m-%d") AS due, flags, review_status FROM action_items WHERE meeting_id = ?', [ids.meeting]);
    assert.equal(items.length, 1);
    const [it0] = items;
    assert.deepEqual([it0.title, it0.assignee_user_id, it0.assignee_match, it0.due, it0.review_status], ['Fix the partial refund bug', ids.raj, 'exact', DUE, 'pending']);
    assert.deepEqual(typeof it0.flags === 'string' ? JSON.parse(it0.flags) : it0.flags, []);
    ids.item = it0.id;
  });

  it('Jira asks for write access only when issue creation is turned on', async () => {
    const { default: jiraConnector } = await import('../src/services/integrations/providers/jira/index.js');
    const scopeOf = () => new URL(jiraConnector.beginConnect({ state: 'state-123456' }).redirectUrl).searchParams.get('scope');
    assert.match(scopeOf(), /write:jira-work/);
    configureJira({ issueCreation: false });
    try {
      assert.equal(scopeOf(), 'read:jira-work read:jira-user offline_access', 'existing read-only setups are unchanged');
    } finally {
      configureJira({ issueCreation: true });
    }
  });

  it('a pending item cannot be sent to Jira', async () => {
    const jiraBody = await connect('jira', jira.grantCode());
    ids.jiraConn = jiraBody.connection.id;
    const payRes = jiraBody.resources.find((r) => r.name.includes('PAY') || r.name.includes('Payments'));
    ids.payRes = payRes.id;
    await as.patch(`/api/v1/integrations/${ids.jiraConn}/resources/${ids.payRes}`, { isEnabled: true, projectId: ids.P });
    await syncAll(ids.payRes);
    const res = await as.post(`/api/v1/action-items/${ids.item}/exports`, { resourceId: ids.payRes });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ITEM_NOT_APPROVED');
  });

  it('after approval, an admin creates the Jira issue: assignee from the identity mapping, due date, label, link', async () => {
    const raj = await one("SELECT id FROM external_identities WHERE provider = 'jira' AND external_user_id = 'acc-raj'");
    assert.equal((await as.patch(`/api/v1/integrations/identities/${raj.id}`, { userId: ids.raj })).status, 200);
    assert.equal((await as.post(`/api/v1/action-items/${ids.item}/approve`)).status, 200);

    const targets = await as.get('/api/v1/action-items/export-targets');
    const target = targets.body.targets.find((t) => t.resourceId === ids.payRes);
    assert.deepEqual([target.key, target.canWrite, target.project.id], ['PAY', true, ids.P]);

    const res = await as.post(`/api/v1/action-items/${ids.item}/exports`, { resourceId: ids.payRes });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.export.status, 'queued');
    await drain();

    assert.equal(jira.state.created, 1);
    const created = jira.state.issues.find((i) => i.fields.labels.includes(`workagent-item-${ids.item}`));
    assert.deepEqual([created.fields.summary, created.fields.assignee.accountId, created.fields.duedate], ['Fix the partial refund bug', 'acc-raj', DUE]);
    assert.ok(JSON.stringify(created.fields.description).includes(`approved action item #${ids.item}`));
    const exp = await one('SELECT status, external_key, external_url, assignee_set, external_record_id FROM action_item_exports WHERE action_item_id = ?', [ids.item]);
    assert.deepEqual([exp.status, exp.external_key, Boolean(exp.assignee_set)], ['created', created.key, true]);
    assert.equal(exp.external_url, `${SITE_URL}/browse/${created.key}`);
    const link = await one("SELECT link_type, status FROM record_links WHERE from_type = 'action_item' AND from_id = ? AND to_type = 'external_record' AND to_id = ?", [ids.item, exp.external_record_id]);
    assert.deepEqual([link.link_type, link.status], ['tracks', 'confirmed']);

    const again = await as.post(`/api/v1/action-items/${ids.item}/exports`, { resourceId: ids.payRes });
    assert.deepEqual([again.status, again.body.error.code], [409, 'ALREADY_EXPORTED']);
    const listed = await as.get(`/api/v1/action-items/exports?meetingId=${ids.meeting}`);
    assert.equal(listed.body.exports[0].externalKey, created.key);
  });

  it('a retry after a crash finds the issue created earlier instead of creating a second one', async () => {
    const manual = await as.post(`/api/v1/meetings/${ids.meeting}/action-items`, { title: 'Write the refund postmortem', assigneeUserId: ids.raj, priority: 'medium' });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    const itemId = manual.body.item?.id ?? manual.body.actionItem?.id ?? manual.body.id;
    assert.equal((await as.post(`/api/v1/action-items/${itemId}/approve`)).status, 200);
    jira.state.unassignable = ['acc-raj']; // and Jira refuses Raj as assignee this time
    assert.equal((await as.post(`/api/v1/action-items/${itemId}/exports`, { resourceId: ids.payRes })).status, 202);
    const exp = await one('SELECT id FROM action_item_exports WHERE action_item_id = ?', [itemId]);
    const before = jira.state.created;
    // The issue is created, then reading it back fails: the export stays queued.
    jira.state.failNext.push({ match: /^GET \/ex\/jira\/[^/]+\/rest\/api\/3\/issue\/9\d+$/, status: 503 });
    await assert.rejects(runExport(exp.id), (e) => e.kind === 'transient');
    assert.equal(jira.state.created, before + 1);
    assert.equal(await runExport(exp.id), 'created');
    assert.equal(jira.state.created, before + 1, 'found again by its label, not created twice');
    const row = await one('SELECT status, assignee_set FROM action_item_exports WHERE id = ?', [exp.id]);
    assert.deepEqual([row.status, Boolean(row.assignee_set)], ['created', false]);
    const issue = jira.state.issues.find((i) => i.fields.labels.includes(`workagent-item-${itemId}`));
    assert.ok(JSON.stringify(issue.fields.description).includes('no linked Jira account') || issue.fields.assignee === null);
    jira.state.unassignable = [];
    await pool.query("DELETE FROM jobs WHERE type = 'action_item.export'");
  });

  it('a read-only Jira connection is refused with a clear message', async () => {
    await pool.query("UPDATE integration_connections SET settings = JSON_SET(settings, '$.scopes', JSON_ARRAY('read:jira-work', 'read:jira-user', 'offline_access')) WHERE id = ?", [ids.jiraConn]);
    const manual = await as.post(`/api/v1/meetings/${ids.meeting}/action-items`, { title: 'Refund FAQ', assigneeUserId: ids.raj, priority: 'low' });
    const itemId = manual.body.item?.id ?? manual.body.actionItem?.id ?? manual.body.id;
    await as.post(`/api/v1/action-items/${itemId}/approve`);
    const res = await as.post(`/api/v1/action-items/${itemId}/exports`, { resourceId: ids.payRes });
    assert.deepEqual([res.status, res.body.error.code], [409, 'JIRA_WRITE_SCOPE_MISSING']);
    assert.match(res.body.error.message, /write:jira-work/);
  });
});

describe('Transcript import edge cases (fake Graph)', () => {
  let recordId;
  before(async () => {
    const now = Date.now();
    const cal = ms.state.calendars[0];
    const ev2 = event(ms.state, cal, { id: 'ev-standup', subject: 'Standup', start: iso(now - 2 * HOUR), end: iso(now - HOUR) });
    onlineMeeting(ms.state, ev2); // no transcript yet
    await syncAll(ids.meetingsRes);
    recordId = (await one("SELECT id FROM external_records WHERE external_id = 'ev-standup'")).id;
  });

  it('waits while the transcript is not ready, then gives up 24 hours after the meeting', async () => {
    assert.equal(await importRecord(recordId), 'waiting');
    const w = await one('SELECT status, attempts, next_check_at FROM meeting_transcript_imports WHERE record_id = ?', [recordId]);
    assert.equal(w.status, 'waiting');
    assert.ok(new Date(w.next_check_at) > new Date());
    assert.equal(await enqueueDue(), 0, 'not due again before next_check_at');
    assert.equal(await importRecord(recordId, { now: Date.now() + 25 * HOUR }), 'none');
    assert.match((await one('SELECT last_error FROM meeting_transcript_imports WHERE record_id = ?', [recordId])).last_error, /within 24 hours/);
  });

  it('missing admin consent is reported once, not retried', async () => {
    await pool.query('DELETE FROM meeting_transcript_imports WHERE record_id = ?', [recordId]);
    ms.state.failNext.push({ match: /GET \/v1\.0\/me\/onlineMeetings$/, status: 403, body: { error: { code: 'Forbidden', message: 'Insufficient privileges' } } });
    assert.equal(await importRecord(recordId), 'failed');
    assert.match((await one('SELECT last_error FROM meeting_transcript_imports WHERE record_id = ?', [recordId])).last_error, /admin consent/);
    assert.equal(await importRecord(recordId), 'failed', 'stays failed until someone acts');
  });

  it('a meeting the account cannot see in Graph is marked as having no transcript', async () => {
    const cal = ms.state.calendars[0];
    const now = Date.now();
    event(ms.state, cal, { id: 'ev-external', subject: 'Vendor call', start: iso(now - 3 * HOUR), end: iso(now - 2 * HOUR), organizer: 'vendor@other.test' });
    await syncAll(ids.meetingsRes);
    const rec = await one("SELECT id FROM external_records WHERE external_id = 'ev-external'");
    assert.equal(await importRecord(rec.id), 'none');
    assert.match((await one('SELECT last_error FROM meeting_transcript_imports WHERE record_id = ?', [rec.id])).last_error, /organizer/);
  });
});

describe('Google Calendar does not import Google Meet transcripts (Vexa does)', () => {
  it('syncs Meet-link events for discovery but queues no Google transcript import', async () => {
    const now = Date.now();
    const cal = calendar(google.state, { id: `ada@${G_DOMAIN}`, summary: 'Ada', primary: true });
    meetEvent(google.state, cal, { id: 'gev-1', summary: 'Onboarding sync', start: iso(now - 4 * HOUR), end: iso(now - 3 * HOUR), code: 'abc-defg-hij' });
    google.state.account = `ada@${G_DOMAIN}`;
    const body = await connect('google_calendar', google.grantCode());
    const res = body.resources.find((r) => r.metadata?.primary || r.name.includes('Ada'));
    await as.patch(`/api/v1/integrations/${body.connection.id}/resources/${res.id}`, { isEnabled: true, projectId: ids.P });
    await syncAll(res.id);
    const ev = await one("SELECT record_type, external_key FROM external_records WHERE provider = 'google_calendar'");
    assert.deepEqual([ev.record_type, ev.external_key], ['calendar_event', 'abc-defg-hij']);
    assert.equal(transcriptKinds().some((k) => k.provider === 'google_calendar'), false);
    assert.equal((await all("SELECT id FROM external_records WHERE provider = 'google_calendar' AND record_type = 'conference'")).length, 0);
  });
});

