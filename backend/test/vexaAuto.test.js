// Automatic Google Meet transcription with Vexa (services/vexa/autoTranscribe.js):
// one-time connection, discovery from synced calendar events, eligibility/consent, dispatch,
// duplicate prevention, bot lifecycle, delayed transcripts, failures, cancellations, restart
// recovery and signed webhooks.
// MOCKED, NOT LIVE: Vexa is a fake fetch (same contract as test/vexa.test.js); calendar events are
// rows as the Google Calendar/Outlook connectors store them. No real Vexa or Google is called.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { handlers } from '../src/jobs/handlers/index.js';
import { processNext } from '../src/jobs/runner.js';
import * as auto from '../src/services/vexa/autoTranscribe.js';
import { vexa } from '../src/services/vexa/client.js';
import { workapi } from '../src/services/workapi/index.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const originalVexa = { fetch: vexa.fetch, settings: { ...vexa.settings } };
const originalCfg = { ...config.vexa };
const originalWorkapi = { ...workapi };
const MIN = 60_000;
let cookie;
let ids = {};
let calls;
let remote; // per native id: { id, status, segments, reason }
let scripted;

const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const meetingOf = (native) => ({ id: remote[native].id, user_id: 1, platform: 'google_meet', native_meeting_id: native, status: remote[native].status, start_time: remote[native].startTime, end_time: null, completion_reason: remote[native].reason ?? null });

async function fakeFetch(url, init) {
  const u = new URL(url);
  const key = `${init.method} ${u.pathname}`;
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ key, body });
  const next = scripted[key]?.shift();
  if (next) return json(next.status, next.body);
  if (key === 'GET /auth/me') return json(200, { user_id: 7, email: 'bot-owner@vexa.test', scopes: ['bot', 'tx'], max_concurrent: 5 });
  if (key === 'PUT /user/webhook') return json(200, { ok: true });
  if (key === 'POST /bots') {
    const native = body.native_meeting_id;
    remote[native] = { id: 900 + Object.keys(remote).length, status: 'requested', startTime: new Date(Date.now() + 1000).toISOString(), segments: [] };
    return json(201, meetingOf(native));
  }
  let m = /^GET \/meetings\/(\d+)$/.exec(key);
  if (m) {
    const native = Object.keys(remote).find((n) => String(remote[n].id) === m[1]);
    return native ? json(200, meetingOf(native)) : json(404, { detail: 'not found' });
  }
  m = /^GET \/transcripts\/google_meet\/(.+)$/.exec(key);
  if (m && remote[m[1]]) return json(200, { ...meetingOf(m[1]), segments: remote[m[1]].segments });
  m = /^DELETE \/bots\/google_meet\/(.+)$/.exec(key);
  if (m) return json(200, { status: 'stopping' });
  return json(404, { detail: 'not found' });
}

const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
/** A synced calendar event as the Google Calendar connector stores it. */
async function calendarEvent({ title = 'Payments sync', code = 'abc-defg-hij', startIn = 1 * MIN, minutes = 30, organizer = 'mia@acme.test', attendees = ['raj@acme.test'], body = null, selfResponse = 'accepted', provider = 'google_calendar' }) {
  seq++;
  const start = Date.now() + startIn;
  const metadata = { calendarId: 'primary', start: iso(start), end: iso(start + minutes * MIN), allDay: false, meetCode: code, joinUrl: `https://meet.google.com/${code}`, organizer, attendees, selfResponse };
  const [r] = await pool.execute(
    `INSERT INTO external_records (provider, source_instance, record_type, external_id, external_key, connection_id, url, title, body, state, status_category, metadata, content_hash, source_created_at, source_updated_at)
     VALUES (?, 'google:acme.test', 'calendar_event', ?, ?, ?, NULL, ?, ?, 'scheduled', 'todo', ?, SHA2(?, 256), NOW(), NOW())`,
    [provider, `primary/ev${seq}`, code, provider === 'outlook' ? ids.outlookConn : ids.googleConn, title, body, JSON.stringify(metadata), `${seq}`],
  );
  return r.insertId;
}

const work = (types) => processNext('test-worker', Object.fromEntries(types.map((t) => [t, handlers[t]])));
const makeDue = () => pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
const poll = async () => {
  await makeDue();
  return work(['vexa.poll']);
};
const session = async (recordId) => (await pool.query('SELECT * FROM meeting_bot_sessions WHERE calendar_record_id = ? ORDER BY id DESC LIMIT 1', [recordId]))[0][0];
const botPosts = () => calls.filter((c) => c.key === 'POST /bots');

async function connectVexa() {
  const res = await request(app).post('/api/v1/integrations/vexa/connect').set('Cookie', cookie).send({ consentStatement: 'Participants are told in the invitation and the bot is visible in the meeting.', scope: 'organizer' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@acme.test', role: 'admin', fullName: 'Ada Admin' });
  ids.mia = await createUser({ email: 'mia@acme.test', role: 'manager', fullName: 'Mia Manager' });
  ids.raj = await createUser({ email: 'raj@acme.test', fullName: 'Raj Kumar' });
  cookie = await loginCookie(app, 'admin@acme.test');
  const [g] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status, connected_by) VALUES ('google_calendar', 'google:acme.test', 'mia@acme.test', 'Google Calendar · mia', 'active', ?)", [ids.admin]);
  ids.googleConn = g.insertId;
  const [o] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status, connected_by) VALUES ('outlook', 'microsoft:tenant', 'raj@acme.test', 'Outlook · raj', 'active', ?)", [ids.admin]);
  ids.outlookConn = o.insertId;
});
beforeEach(async () => {
  await pool.query('DELETE FROM meeting_bot_sessions');
  await pool.query('DELETE FROM vexa_webhook_events');
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM notifications');
  await pool.query("DELETE FROM external_records WHERE record_type = 'calendar_event'");
  await pool.query("DELETE FROM app_settings WHERE setting_key = 'vexa.auto_transcription'");
  calls = [];
  remote = {};
  scripted = {};
  vexa.settings.baseUrl = 'http://vexa.test';
  vexa.settings.apiKey = 'test-vexa-key';
  vexa.fetch = fakeFetch;
  workapi.isConfigured = () => false; // extraction is covered elsewhere; here it is just not queued
  Object.assign(config.vexa, originalCfg, { pollIntervalMs: 15_000, transcriptWaitMs: 5 * MIN, autoMaxDispatchAttempts: 3 });
});
afterEach(() => {
  vexa.fetch = originalVexa.fetch;
  Object.assign(vexa.settings, originalVexa.settings);
  Object.assign(config.vexa, originalCfg);
  Object.assign(workapi, originalWorkapi);
});
after(closeDatabase);

describe('one-time connection', () => {
  it('needs a consent statement, verifies the key with GET /auth/me and shows the account on the card', async () => {
    const bad = await request(app).post('/api/v1/integrations/vexa/connect').set('Cookie', cookie).send({ consentStatement: 'ok' });
    assert.equal(bad.status, 400);
    const card = await connectVexa();
    assert.equal(card.state, 'connected');
    assert.deepEqual([card.account.email, card.account.maxConcurrent], ['bot-owner@vexa.test', 5]);
    assert.equal(card.webhook.registered, false, 'no secret/public URL configured: polling only');
    assert.equal(card.settings.consent.confirmedBy, ids.admin);
    assert.ok(calls.some((c) => c.key === 'GET /auth/me'));
    const audit = (await pool.query("SELECT action FROM audit_logs WHERE action = 'vexa.connected'"))[0];
    assert.equal(audit.length, 1);
  });

  it('registers the signed webhook when a secret and public URL are configured', async () => {
    Object.assign(config.vexa, { webhookSecret: 's'.repeat(32), webhookPublicUrl: 'https://api.acme.test' });
    const card = await connectVexa();
    assert.equal(card.webhook.registered, true);
    const put = calls.find((c) => c.key === 'PUT /user/webhook');
    assert.equal(put.body.webhook_url, 'https://api.acme.test/api/v1/webhooks/vexa');
    assert.equal(put.body.webhook_secret, 's'.repeat(32));
  });

  it('does nothing until connected, and nothing after disconnecting', async () => {
    await calendarEvent({});
    let out = await auto.scan();
    assert.equal(out.enabled, false);
    assert.equal(botPosts().length, 0);
    await connectVexa();
    const disc = await request(app).post('/api/v1/integrations/vexa/disconnect').set('Cookie', cookie);
    assert.equal(disc.body.state, 'paused');
    out = await auto.scan();
    assert.equal(botPosts().length, 0);
  });
});

describe('discovery, eligibility and dispatch', () => {
  it('sends exactly one bot to an eligible meeting, creates the WorkAgent meeting with members', async () => {
    await connectVexa();
    const rec = await calendarEvent({});
    const first = await auto.scan();
    assert.deepEqual([first.discovered, first.dispatched], [1, 1]);
    const s = await session(rec);
    assert.equal(s.state, 'joining');
    const m = (await pool.query('SELECT * FROM meetings WHERE id = ?', [s.meeting_id]))[0][0];
    assert.deepEqual([m.title, m.platform, m.native_meeting_id, m.status], ['Payments sync', 'google_meet', 'abc-defg-hij', 'bot_requested']);
    const participants = (await pool.query('SELECT user_id FROM meeting_participants WHERE meeting_id = ? ORDER BY user_id', [m.id]))[0].map((r) => r.user_id);
    assert.deepEqual(participants, [ids.mia, ids.raj].sort((a, b) => a - b));
    // Repeated scans, a second worker and the same meeting in an attendee's Outlook calendar: still one bot.
    await auto.scan();
    await Promise.all([auto.scan(), auto.scan()]);
    await calendarEvent({ provider: 'outlook' });
    await auto.scan();
    assert.equal(botPosts().length, 1);
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM meeting_bot_sessions'))[0][0].n, 1);
  });

  it('waits until shortly before the start', async () => {
    await connectVexa();
    const rec = await calendarEvent({ startIn: 60 * MIN });
    await auto.scan();
    assert.equal((await session(rec)).state, 'scheduled');
    assert.equal(botPosts().length, 0);
  });

  it('skips meetings the policy excludes and says why', async () => {
    await connectVexa();
    const optOut = await calendarEvent({ code: 'aaa-aaaa-aaa', body: 'Agenda. #norecord please' });
    const external = await calendarEvent({ code: 'bbb-bbbb-bbb', organizer: 'vendor@other.test' });
    const declined = await calendarEvent({ code: 'ccc-cccc-ccc', selfResponse: 'declined' });
    const long = await calendarEvent({ code: 'ddd-dddd-ddd', minutes: 9 * 60 });
    await auto.scan();
    assert.equal(botPosts().length, 0);
    assert.match((await session(optOut)).state_reason, /opt-out keyword/);
    assert.match((await session(external)).state_reason, /organiser is not an active WorkAgent member/);
    assert.match((await session(declined)).state_reason, /declined/);
    assert.match((await session(long)).state_reason, /limit 4 h/);
    const raw = (await session(optOut)).eligibility;
    const e = typeof raw === 'string' ? JSON.parse(raw) : raw;
    assert.equal(e.ok, false);
    assert.ok(e.checks.some((c) => c.check === 'consent' && c.ok));
  });

  it('internal-only policy skips meetings with outside attendees', async () => {
    await connectVexa();
    await request(app).put('/api/v1/integrations/vexa/settings').set('Cookie', cookie).send({ internalOnly: true });
    const rec = await calendarEvent({ attendees: ['raj@acme.test', 'guest@partner.test'] });
    await auto.scan();
    assert.match((await session(rec)).state_reason, /outside the organisation/);
  });

  it('follows the calendar: rescheduled and cancelled meetings before the bot is sent', async () => {
    await connectVexa();
    const rec = await calendarEvent({ startIn: 3 * 60 * MIN });
    await auto.scan();
    const later = iso(Date.now() + 5 * 60 * MIN);
    await pool.execute("UPDATE external_records SET metadata = JSON_SET(metadata, '$.start', ?) WHERE id = ?", [later, rec]);
    await auto.scan();
    assert.equal(new Date((await session(rec)).scheduled_start).toISOString().slice(0, 16), later.slice(0, 16));
    await pool.execute('UPDATE external_records SET source_deleted_at = NOW() WHERE id = ?', [rec]);
    const out = await auto.scan();
    assert.equal(out.cancelled, 1);
    assert.equal((await session(rec)).state, 'cancelled');
  });
});

describe('bot lifecycle and transcripts', () => {
  it('joining -> recording -> processing -> completed, with the transcript imported once', async () => {
    await connectVexa();
    const rec = await calendarEvent({});
    await auto.scan();
    const s = await session(rec);
    const native = 'abc-defg-hij';
    remote[native].status = 'awaiting_admission';
    await poll();
    remote[native].status = 'active';
    await poll();
    await auto.scan();
    assert.equal((await session(rec)).state, 'recording');
    remote[native].status = 'completed';
    remote[native].segments = [{ segment_id: 'v1', speaker: 'Raj Kumar', text: 'I will update the API docs by Friday.', start: 3, end: 6, language: 'en', completed: true }];
    await poll();
    await auto.scan();
    const done = await session(rec);
    assert.equal(done.state, 'completed');
    assert.ok(done.transcript_at);
    const t = (await pool.query('SELECT segment_count FROM transcripts WHERE meeting_id = ?', [s.meeting_id]))[0];
    assert.deepEqual(t.map((r) => r.segment_count), [1]);
    const card = await auto.overview();
    assert.equal(card.counts.meetingsProcessed, 1);
    assert.equal(card.lastTranscript.meetingId, s.meeting_id);
  });

  it('a transcript that is late is waited for, not lost', async () => {
    await connectVexa();
    const rec = await calendarEvent({});
    await auto.scan();
    remote['abc-defg-hij'].status = 'completed';
    await poll(); // no segments yet
    await auto.scan();
    assert.equal((await session(rec)).state, 'processing');
    const job = (await pool.query("SELECT status FROM jobs WHERE type = 'vexa.poll'"))[0][0];
    assert.equal(job.status, 'pending', 'still waiting for segments');
  });

  it('a bot the host refuses ends as failed, visible on the card and notified', async () => {
    await connectVexa();
    const rec = await calendarEvent({});
    await auto.scan();
    Object.assign(remote['abc-defg-hij'], { status: 'failed', reason: 'awaiting_admission_rejected' });
    await poll();
    await auto.scan();
    const s = await session(rec);
    assert.equal(s.state, 'failed');
    assert.match(s.state_reason, /declined to admit/);
    const notes = (await pool.query("SELECT user_id FROM notifications WHERE kind = 'transcription_unavailable'"))[0].map((r) => r.user_id).sort();
    assert.deepEqual(notes, [ids.admin, ids.mia].sort((a, b) => a - b));
    assert.equal((await auto.overview()).counts.failed30d, 1);
  });

  it('retries a busy Vexa with backoff, then gives up visibly', async () => {
    await connectVexa();
    const rec = await calendarEvent({ startIn: 0, minutes: 120 });
    scripted['POST /bots'] = [{ status: 403, body: { detail: { reason: 'concurrency_limit_reached' } } }];
    await auto.scan();
    let s = await session(rec);
    assert.equal(s.state, 'scheduled');
    assert.match(s.state_reason, /Will retry/);
    assert.ok(new Date(s.next_attempt_at) > new Date());
    await auto.scan();
    assert.equal(botPosts().length, 1, 'not retried before the backoff');
    await pool.execute('UPDATE meeting_bot_sessions SET next_attempt_at = NOW() - INTERVAL 1 SECOND');
    scripted['POST /bots'] = [{ status: 403, body: { detail: { reason: 'concurrency_limit_reached' } } }, { status: 403, body: { detail: { reason: 'concurrency_limit_reached' } } }];
    await auto.scan();
    await pool.execute('UPDATE meeting_bot_sessions SET next_attempt_at = NOW() - INTERVAL 1 SECOND');
    await auto.scan();
    s = await session(rec);
    assert.equal(s.state, 'failed');
    assert.equal(s.attempts, 3);
    // Manual retry from the card sends it again.
    const retried = await request(app).post(`/api/v1/integrations/vexa/sessions/${s.id}/retry`).set('Cookie', cookie);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    await auto.scan();
    assert.equal((await session(rec)).state, 'joining');
  });

  it('a meeting that ended before any bot was sent is reported as missed', async () => {
    await connectVexa();
    const rec = await calendarEvent({ startIn: 60 * MIN });
    await auto.scan();
    await pool.execute('UPDATE meeting_bot_sessions SET scheduled_start = NOW() - INTERVAL 2 HOUR, scheduled_end = NOW() - INTERVAL 1 HOUR');
    await pool.execute("UPDATE external_records SET metadata = JSON_SET(metadata, '$.start', ?, '$.end', ?) WHERE id = ?", [iso(Date.now() - 7_200_000), iso(Date.now() - 3_600_000), rec]);
    await auto.scan();
    assert.match((await session(rec)).state_reason, /ended before the bot could be sent/);
  });

  it('recovers a lost poll job after a worker restart', async () => {
    await connectVexa();
    const rec = await calendarEvent({});
    await auto.scan();
    await pool.query("DELETE FROM jobs WHERE type = 'vexa.poll'");
    await auto.scan();
    const s = await session(rec);
    const job = (await pool.query("SELECT status FROM jobs WHERE type = 'vexa.poll' AND JSON_EXTRACT(payload, '$.meetingId') = ?", [s.meeting_id]))[0];
    assert.equal(job.length, 1);
  });
});

describe('webhook', () => {
  const SECRET = 'w'.repeat(32);
  const sign = (body, ts = String(Math.floor(Date.now() / 1000))) => ({ 'x-webhook-timestamp': ts, 'x-webhook-signature': `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`, 'content-type': 'application/json' });

  it('accepts signed deliveries once per event_id and wakes the poller', async () => {
    Object.assign(config.vexa, { webhookSecret: SECRET });
    await connectVexa();
    const rec = await calendarEvent({});
    await auto.scan();
    const s = await session(rec);
    await pool.query("UPDATE jobs SET run_at = NOW() + INTERVAL 1 HOUR WHERE type = 'vexa.poll'");
    const body = JSON.stringify({ event_id: 'evt_1', event_type: 'meeting.completed', api_version: '2026-03-01', created_at: new Date().toISOString(), data: { meeting: { platform: 'google_meet', native_meeting_id: 'abc-defg-hij', status: 'completed' } } });
    const send = (b, headers) => request(app).post('/api/v1/webhooks/vexa').set(headers).send(b);
    const res = await send(body, sign(body));
    assert.equal(res.status, 202);
    assert.equal(res.body.duplicate, false);
    assert.equal((await send(body, sign(body))).body.duplicate, true, 'redelivery of the same event_id');
    const due = (await pool.query("SELECT run_at <= NOW() AS due FROM jobs WHERE type = 'vexa.poll' AND JSON_EXTRACT(payload, '$.meetingId') = ?", [s.meeting_id]))[0][0];
    assert.equal(Number(due.due), 1, 'the pending poll job runs now; the poller stays the source of truth');
    assert.equal((await send(body, { ...sign(body), 'x-webhook-signature': `sha256=${'0'.repeat(64)}` })).status, 401);
    assert.equal((await send(body, sign(body, String(Math.floor(Date.now() / 1000) - 3600)))).status, 401, 'stale timestamp');
  });
});
