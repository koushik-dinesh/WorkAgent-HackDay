// Automatic meeting transcription with Vexa (replaces the standalone Google Meet integration).
//
// An admin connects Vexa once (the server's VEXA_BASE_URL/VEXA_API_KEY are verified with
// GET /auth/me), confirms the organisation's recording consent and turns automatic transcription
// on. From then on the worker runs, every few minutes ('vexa.auto_scan'):
//
//   synced calendar events (Google Calendar, Outlook) with a Google Meet link
//     -> meeting_bot_sessions row per occurrence (UNIQUE platform+link+start: one bot per meeting)
//     -> eligibility + policy + consent checks (stored on the row, shown on the Vexa card)
//     -> shortly before the start: WorkAgent meeting + meetingBot.requestBot (existing, idempotent)
//     -> the existing 'vexa.poll' job follows the bot, imports the transcript and queues extraction
//     -> sessions mirror the meeting: joining -> recording -> processing -> completed | failed
//
// Restart safety: sessions, meetings and poll jobs are rows in MySQL; a scan re-derives everything
// from them, and a meeting whose poll job is missing gets one again. Duplicate dispatch is
// prevented three times: the occurrence unique key, a conditional claim (scheduled -> dispatching)
// and meetingBot's own one-bot-per-link check.
//
// Nothing here records a meeting the policy does not allow: the organisation must have confirmed
// consent, declined/all-day/opted-out meetings are skipped, meetings must involve a WorkAgent member
// (organizer by default) and, optionally, only internal attendees. The bot joins as a visible
// participant and Google Meet's host must admit it from the lobby; a refusal is shown, never retried.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import * as meetings from '../../repositories/meetingsRepository.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { audit } from '../audit.js';
import { notify, notifyAdmins } from '../notifications/inbox.js';
import * as bot from '../meetingBot.js';
import { readSetting, writeSetting } from '../settings.js';
import { VexaError, vexa } from './client.js';
import { describeReason, parseGoogleMeetUrl } from './mapper.js';

export const SETTINGS_KEY = 'vexa.auto_transcription';
export const SCAN_JOB = 'vexa.auto_scan';
export const DEFAULTS = {
  enabled: false,
  // Organisation-level recording consent (statement, who confirmed it, when). Required to enable.
  consent: null,
  // 'organizer' = only meetings organised by a WorkAgent member; 'member_attends' = any meeting a
  // WorkAgent member organises or attends.
  scope: 'organizer',
  internalOnly: false,
  optOutKeywords: ['#norecord', '#no-transcript', '[no bot]'],
  joinLeadMinutes: 2,
  maxDurationHours: 4,
  // Result of the last GET /auth/me.
  account: null,
  webhook: null,
};

const ACTIVE_STATES = ['dispatching', 'joining', 'recording', 'processing'];
const MEET_LINK = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i;
const RETRY_MINUTES = [1, 2, 4, 8, 15];

export const getSettings = () => readSetting(SETTINGS_KEY, DEFAULTS);

function publicSettings(s) {
  return {
    enabled: Boolean(s.enabled),
    consent: s.consent ? { statement: s.consent.statement, confirmedBy: s.consent.confirmedBy, confirmedAt: s.consent.confirmedAt } : null,
    scope: s.scope,
    internalOnly: Boolean(s.internalOnly),
    optOutKeywords: s.optOutKeywords ?? [],
    joinLeadMinutes: s.joinLeadMinutes,
    maxDurationHours: s.maxDurationHours,
  };
}

// ---- connection ------------------------------------------------------------------------------------

function vexaHttpError(err) {
  if (!(err instanceof VexaError)) return err;
  return new AppError(err.kind === 'not_configured' ? 503 : 502, `VEXA_${err.kind.toUpperCase()}`, err.publicMessage);
}

/** Registers WorkAgent's webhook with Vexa when a secret and public URL are configured. */
async function registerWebhook() {
  const { webhookSecret, webhookPublicUrl } = config.vexa;
  if (!webhookSecret || !webhookPublicUrl) return { registered: false, reason: 'VEXA_WEBHOOK_SECRET / VEXA_WEBHOOK_PUBLIC_URL not set; polling only' };
  const url = `${webhookPublicUrl}/api/v1/webhooks/vexa`;
  await vexa.setWebhook({ url, secret: webhookSecret, events: { 'meeting.started': true, 'meeting.status_change': true, 'meeting.completed': true, 'bot.failed': true, 'transcription.ready': true } });
  return { registered: true, url, at: new Date().toISOString() };
}

/**
 * Connect once: verify the API key, record the consent statement, register the webhook (optional)
 * and turn automatic transcription on.
 */
export async function connect(actor, { consentStatement, scope, internalOnly } = {}, { ip = null } = {}) {
  if (!vexa.isConfigured()) throw new AppError(503, 'VEXA_NOT_CONFIGURED', 'Vexa is not configured on the server (VEXA_BASE_URL / VEXA_API_KEY)');
  const statement = String(consentStatement ?? '').trim();
  if (statement.length < 20) throw new AppError(400, 'CONSENT_REQUIRED', 'Describe how participants are informed and consent to transcription (at least 20 characters)');
  let account;
  try {
    account = await vexa.whoAmI();
  } catch (err) {
    throw vexaHttpError(err);
  }
  let webhook;
  try {
    webhook = await registerWebhook();
  } catch (err) {
    webhook = { registered: false, reason: err.publicMessage ?? err.message };
  }
  const s = await getSettings();
  const next = {
    ...s,
    enabled: true,
    scope: ['organizer', 'member_attends'].includes(scope) ? scope : s.scope,
    internalOnly: internalOnly === undefined ? s.internalOnly : Boolean(internalOnly),
    consent: { statement: statement.slice(0, 2000), confirmedBy: actor.id, confirmedAt: new Date().toISOString() },
    account: { ...account, verifiedAt: new Date().toISOString() },
    webhook,
  };
  await writeSetting(SETTINGS_KEY, next, actor.id);
  await audit({ actorUserId: actor.id, action: 'vexa.connected', entityType: 'integration', entityId: null, after: { account: { email: account.email, maxConcurrent: account.maxConcurrent }, scope: next.scope, internalOnly: next.internalOnly, webhook: webhook.registered }, ip });
  await enqueueScan();
  return overview();
}

/** Turns automatic transcription off and cancels occurrences no bot was sent to yet. Live bots finish. */
export async function disconnect(actor, { ip = null } = {}) {
  const s = await getSettings();
  await writeSetting(SETTINGS_KEY, { ...s, enabled: false }, actor.id);
  const [r] = await pool.execute("UPDATE meeting_bot_sessions SET state = 'cancelled', state_reason = 'Automatic transcription was turned off' WHERE state = 'scheduled'");
  await audit({ actorUserId: actor.id, action: 'vexa.disconnected', entityType: 'integration', after: { cancelledScheduled: r.affectedRows }, ip });
  return overview();
}

export async function updateSettings(actor, patch, { ip = null } = {}) {
  const s = await getSettings();
  const next = { ...s };
  if (patch.scope !== undefined) next.scope = patch.scope;
  if (patch.internalOnly !== undefined) next.internalOnly = Boolean(patch.internalOnly);
  if (patch.optOutKeywords !== undefined) next.optOutKeywords = [...new Set(patch.optOutKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (patch.joinLeadMinutes !== undefined) next.joinLeadMinutes = patch.joinLeadMinutes;
  if (patch.maxDurationHours !== undefined) next.maxDurationHours = patch.maxDurationHours;
  if (patch.enabled !== undefined) {
    if (patch.enabled && !s.consent) throw new AppError(409, 'CONSENT_REQUIRED', 'Connect Vexa and confirm the recording consent first');
    next.enabled = Boolean(patch.enabled);
  }
  await writeSetting(SETTINGS_KEY, next, actor.id);
  await audit({ actorUserId: actor.id, action: 'vexa.settings_updated', entityType: 'integration', before: publicSettings(s), after: publicSettings(next), ip });
  return overview();
}

// ---- discovery and eligibility --------------------------------------------------------------------

/** The Google Meet link of a synced calendar event (join URL, location or description), or null. */
export function meetLinkOf(record) {
  const md = record.metadata ?? {};
  for (const candidate of [md.joinUrl, md.location, record.url, record.body]) {
    if (!candidate) continue;
    const direct = parseGoogleMeetUrl(candidate);
    if (direct) return direct;
    const m = MEET_LINK.exec(String(candidate));
    if (m) {
      const parsed = parseGoogleMeetUrl(m[0]);
      if (parsed) return parsed;
    }
  }
  return null;
}

const emailsOf = (md) => {
  const list = Array.isArray(md.attendees) ? md.attendees : Array.isArray(md.attendeeEmails) ? md.attendeeEmails : [];
  return [...new Set(list.filter((e) => typeof e === 'string' && e.includes('@')).map((e) => e.toLowerCase()))];
};
const domainOf = (email) => email.split('@')[1] ?? '';

async function directory(conn = pool) {
  const [rows] = await conn.query('SELECT id, LOWER(email) AS email, is_active FROM users');
  const byEmail = new Map(rows.map((u) => [u.email, u]));
  const domains = new Set(rows.filter((u) => u.is_active).map((u) => domainOf(u.email)));
  return { byEmail, domains };
}

/**
 * Policy and consent checks for one calendar occurrence. Pure given the directory and settings.
 * @returns {{ ok: boolean, checks: {check, ok, detail}[], organizerUserId, memberIds }}
 */
export function evaluate(record, settings, dir, now = new Date()) {
  const md = record.metadata ?? {};
  const organizer = (md.organizer ?? '').toLowerCase() || null;
  const attendees = emailsOf(md);
  const members = [...new Set([organizer, ...attendees].filter(Boolean))].map((e) => dir.byEmail.get(e)).filter((u) => u?.is_active);
  const organizerUser = organizer ? dir.byEmail.get(organizer) : null;
  const start = Date.parse(md.start ?? '');
  const end = Date.parse(md.end ?? '');
  const text = `${record.title ?? ''} ${record.body ?? ''}`.toLowerCase();
  const keyword = (settings.optOutKeywords ?? []).find((k) => k && text.includes(k.toLowerCase()));
  const external = attendees.filter((e) => !dir.domains.has(domainOf(e)));

  const checks = [
    { check: 'consent', ok: Boolean(settings.consent), detail: settings.consent ? 'Organisation consent confirmed' : 'The organisation has not confirmed recording consent' },
    { check: 'not_cancelled', ok: record.state !== 'cancelled' && !record.source_deleted_at, detail: record.state === 'cancelled' || record.source_deleted_at ? 'The meeting was cancelled' : 'Scheduled' },
    { check: 'not_declined', ok: md.selfResponse !== 'declined', detail: md.selfResponse === 'declined' ? 'The calendar owner declined this meeting' : 'Not declined' },
    { check: 'timed', ok: !md.allDay && Number.isFinite(start), detail: md.allDay ? 'All-day events are not meetings' : Number.isFinite(start) ? 'Has a start time' : 'No start time' },
    {
      check: 'duration',
      ok: !Number.isFinite(end) || !Number.isFinite(start) || end - start <= settings.maxDurationHours * 3_600_000,
      detail: Number.isFinite(end) && Number.isFinite(start) ? `${Math.round((end - start) / 60_000)} minutes (limit ${settings.maxDurationHours} h)` : 'Unknown length',
    },
    { check: 'opt_out', ok: !keyword, detail: keyword ? `The title or description contains the opt-out keyword “${keyword}”` : 'No opt-out keyword' },
    settings.scope === 'organizer'
      ? { check: 'organizer_member', ok: Boolean(organizerUser?.is_active), detail: organizerUser?.is_active ? 'Organised by a WorkAgent member' : 'The organiser is not an active WorkAgent member' }
      : { check: 'member_involved', ok: members.length > 0, detail: members.length ? `${members.length} WorkAgent member(s) involved` : 'No WorkAgent member organises or attends' },
    ...(settings.internalOnly ? [{ check: 'internal_only', ok: external.length === 0, detail: external.length ? `${external.length} attendee(s) outside the organisation` : 'Only internal attendees' }] : []),
    { check: 'not_ended', ok: !Number.isFinite(end) || end > now.getTime(), detail: Number.isFinite(end) && end <= now.getTime() ? 'Already ended' : 'Upcoming or in progress' },
  ];
  return { ok: checks.every((c) => c.ok), checks, organizerUserId: organizerUser?.is_active ? organizerUser.id : null, memberIds: members.map((u) => u.id) };
}

const toDate = (iso) => (iso ? new Date(iso) : null);
const failingCheck = (e) => e.checks.find((c) => !c.ok);

/** Upcoming/in-progress synced calendar events from active connections and enabled calendars. */
async function candidates(now, lookaheadHours) {
  const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const to = new Date(now.getTime() + lookaheadHours * 3_600_000).toISOString();
  const [rows] = await pool.query(
    `SELECT er.id, er.provider, er.title, er.body, er.url, er.state, er.metadata, er.source_deleted_at, ic.connected_by
       FROM external_records er
       JOIN integration_connections ic ON ic.id = er.connection_id AND ic.status = 'active'
       LEFT JOIN integration_resources r ON r.id = er.resource_id
      WHERE er.record_type = 'calendar_event' AND er.provider IN ('google_calendar', 'outlook')
        AND (r.id IS NULL OR r.is_enabled = TRUE)
        AND JSON_UNQUOTE(JSON_EXTRACT(er.metadata, '$.start')) BETWEEN ? AND ?
      ORDER BY JSON_UNQUOTE(JSON_EXTRACT(er.metadata, '$.start'))
      LIMIT 500`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {} }));
}

/** Creates or updates the session of one occurrence; returns the session row. */
async function upsertSession(record, link, result, now) {
  const md = record.metadata;
  const start = toDate(md.start);
  const end = toDate(md.end);
  const [[existing]] = await pool.query('SELECT * FROM meeting_bot_sessions WHERE calendar_record_id = ? ORDER BY id DESC LIMIT 1', [record.id]);
  const eligibility = JSON.stringify({ ok: result.ok, checks: result.checks, evaluatedAt: now.toISOString() });
  if (existing) {
    // A scheduled occurrence that only "ended" in the meantime was missed (reported below), not skipped.
    const failing = result.checks.filter((c) => !c.ok);
    if (existing.state === 'scheduled' && failing.length && failing.every((c) => c.check === 'not_ended')) return existing;
    // Rescheduled or re-evaluated before any bot was sent: follow the calendar.
    if (['scheduled', 'skipped'].includes(existing.state)) {
      const state = result.ok ? 'scheduled' : 'skipped';
      await pool.execute(
        `UPDATE meeting_bot_sessions SET native_meeting_id = ?, title = ?, organizer_email = ?, organizer_user_id = ?, scheduled_start = ?, scheduled_end = ?,
                state = ?, state_reason = ?, eligibility = ? WHERE id = ? AND state IN ('scheduled','skipped')`,
        [link.nativeMeetingId, (record.title ?? '(no title)').slice(0, 255), md.organizer ?? null, result.organizerUserId, start, end, state, result.ok ? null : failingCheck(result)?.detail ?? null, eligibility, existing.id],
      ).catch((err) => {
        if (err.code !== 'ER_DUP_ENTRY') throw err; // another occurrence already owns that link + start
      });
    }
    return (await pool.query('SELECT * FROM meeting_bot_sessions WHERE id = ?', [existing.id]))[0][0];
  }
  try {
    const [ins] = await pool.execute(
      `INSERT INTO meeting_bot_sessions (calendar_record_id, platform, native_meeting_id, title, organizer_email, organizer_user_id, scheduled_start, scheduled_end, state, state_reason, eligibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, link.platform, link.nativeMeetingId, (record.title ?? '(no title)').slice(0, 255), md.organizer ?? null, result.organizerUserId, start, end, result.ok ? 'scheduled' : 'skipped', result.ok ? null : failingCheck(result)?.detail ?? null, eligibility],
    );
    return (await pool.query('SELECT * FROM meeting_bot_sessions WHERE id = ?', [ins.insertId]))[0][0];
  } catch (err) {
    // The same occurrence reached us through a second calendar (organiser's and attendee's): one session.
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return null;
  }
}

/** WorkAgent meeting for the occurrence (found again by link + start, else created). */
async function meetingFor(session, record, memberIds) {
  return withTransaction(async (conn) => {
    const [[found]] = await conn.query('SELECT id FROM meetings WHERE platform = ? AND native_meeting_id = ? AND scheduled_at = ? FOR UPDATE', [session.platform, session.native_meeting_id, session.scheduled_start]);
    if (found) return found.id;
    if (session.meeting_id) {
      const [[m]] = await conn.query('SELECT id FROM meetings WHERE id = ?', [session.meeting_id]);
      if (m) return m.id;
    }
    let creator = session.organizer_user_id ?? record?.connected_by ?? null;
    if (!creator) {
      const [[admin]] = await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1");
      creator = admin?.id;
    }
    if (!creator) throw new AppError(409, 'NO_OWNER', 'No active user to own the meeting');
    const id = await meetings.create(conn, { title: session.title, meetingUrl: `https://meet.google.com/${session.native_meeting_id}`, scheduledAt: session.scheduled_start, createdBy: creator });
    if (memberIds.length) await meetings.replaceParticipants(conn, id, memberIds);
    await conn.execute('UPDATE meeting_bot_sessions SET meeting_id = ? WHERE id = ?', [id, session.id]);
    return id;
  });
}

const RETRYABLE_CODES = new Set(['VEXA_BUSY', 'VEXA_UNAVAILABLE', 'VEXA_RATE_LIMITED', 'VEXA_TIMEOUT', 'VEXA_NETWORK', 'VEXA_SERVER', 'VEXA_INVALID_RESPONSE']);

/** Sends the bot for one due session. Never throws for Vexa problems: the session records them. */
async function dispatch(session, record, memberIds, now) {
  // Claim: only one worker moves scheduled -> dispatching.
  const [claim] = await pool.execute("UPDATE meeting_bot_sessions SET state = 'dispatching', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? AND state = 'scheduled'", [session.id]);
  if (!claim.affectedRows) return 'not_claimed';
  let meetingId;
  try {
    meetingId = await meetingFor(session, record, memberIds);
    await pool.execute('UPDATE meeting_bot_sessions SET meeting_id = ? WHERE id = ?', [meetingId, session.id]);
    const m = await meetings.findById(meetingId);
    // The meeting already has a bot (manual request, earlier dispatch) or a transcript: adopt it.
    if (['bot_requested', 'bot_joining', 'in_progress', 'ended', 'transcript_ready', 'extracting', 'review_pending', 'approved', 'emails_sent'].includes(m.status)) {
      await pool.execute("UPDATE meeting_bot_sessions SET state = 'joining', dispatched_at = COALESCE(dispatched_at, NOW()) WHERE id = ?", [session.id]);
      await bot.ensurePolling(meetingId);
      return 'adopted';
    }
    await bot.requestBot(meetingId, null, null);
    await pool.execute("UPDATE meeting_bot_sessions SET state = 'joining', dispatched_at = NOW(), state_reason = NULL WHERE id = ?", [session.id]);
    await audit({ action: 'vexa.auto_dispatched', entityType: 'meeting', entityId: meetingId, after: { sessionId: session.id, platform: session.platform, nativeMeetingId: session.native_meeting_id, scheduledStart: session.scheduled_start } });
    return 'dispatched';
  } catch (err) {
    const code = err.code ?? err.kind ?? 'ERROR';
    const message = (err.publicMessage ?? err.message ?? 'Unknown error').slice(0, 480);
    const attempts = session.attempts + 1;
    const end = session.scheduled_end ? new Date(session.scheduled_end).getTime() : new Date(session.scheduled_start).getTime() + 3_600_000;
    const retryAt = new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000);
    const retryable = RETRYABLE_CODES.has(code) && attempts < config.vexa.autoMaxDispatchAttempts && retryAt.getTime() < end;
    if (code === 'BOT_ALREADY_ACTIVE' || code === 'LINK_IN_USE') {
      // Another WorkAgent meeting already has the bot on this link: not a second bot, not a failure.
      await pool.execute("UPDATE meeting_bot_sessions SET state = 'skipped', state_reason = ? WHERE id = ?", [`A bot is already on this meeting link (${message})`, session.id]);
      return 'duplicate';
    }
    await pool.execute('UPDATE meeting_bot_sessions SET state = ?, state_reason = ?, next_attempt_at = ? WHERE id = ?', [retryable ? 'scheduled' : 'failed', `${retryable ? 'Will retry' : 'Could not send the bot'}: ${message}`, retryable ? retryAt : null, session.id]);
    logger.warn('vexa auto dispatch failed', { sessionId: session.id, code, retryable, attempts });
    if (!retryable) {
      await audit({ action: 'vexa.auto_dispatch_failed', entityType: 'meeting', entityId: meetingId ?? null, after: { sessionId: session.id, code, message } });
      await notifyUnavailable(session, message);
    }
    return retryable ? 'retry' : 'failed';
  }
}

/** Tells the organiser (and admins) that a meeting will have no automatic transcript, once per session. */
async function notifyUnavailable(session, reason) {
  const [[s]] = await pool.query('SELECT id, title, organizer_user_id, meeting_id FROM meeting_bot_sessions WHERE id = ?', [session.id]);
  if (!s) return;
  const args = {
    kind: 'transcription_unavailable',
    title: `No automatic transcript for “${s.title}”`,
    body: `${reason ?? 'The bot could not record this meeting'}. Upload a transcript manually if one exists.`,
    link: s.meeting_id ? `/admin/meetings/${s.meeting_id}` : '/admin/integrations',
    entityType: 'meeting_bot_session',
    entityId: s.id,
    dedupeKey: `vexa-session:${s.id}`,
  };
  await notifyAdmins(pool, args);
  if (s.organizer_user_id) await notify(pool, { ...args, userId: s.organizer_user_id, link: '/notifications' });
}

// Meeting status -> session state, once a bot was sent.
function stateFromMeeting(m) {
  if (!m) return null;
  if (['bot_requested', 'bot_joining'].includes(m.status)) return 'joining';
  if (m.status === 'in_progress') return 'recording';
  if (m.status === 'ended') return 'processing';
  if (['transcript_ready', 'extracting', 'review_pending', 'approved', 'emails_sent'].includes(m.status)) return 'completed';
  if (m.status === 'failed') return 'failed';
  return null;
}

/** Brings live sessions in line with their meetings, and recovers lost poll jobs. */
async function followActive() {
  const [rows] = await pool.query(
    `SELECT s.id, s.state, s.meeting_id, m.status, m.bot_status, m.bot_reason, m.last_error, m.native_meeting_id
       FROM meeting_bot_sessions s JOIN meetings m ON m.id = s.meeting_id
      WHERE s.state IN (?)`,
    [ACTIVE_STATES],
  );
  let changed = 0;
  for (const r of rows) {
    const next = stateFromMeeting(r);
    if (next && next !== r.state) {
      const reason = next === 'failed' ? r.last_error ?? describeReason(r.bot_reason) ?? 'The bot failed' : next === 'completed' ? null : undefined;
      await pool.execute(
        `UPDATE meeting_bot_sessions SET state = ?, state_reason = COALESCE(?, state_reason),
                joined_at = IF(? = 'recording' AND joined_at IS NULL, NOW(), joined_at),
                ended_at = IF(? IN ('processing','completed') AND ended_at IS NULL, NOW(), ended_at),
                transcript_at = IF(? = 'completed' AND transcript_at IS NULL, NOW(), transcript_at)
          WHERE id = ?`,
        [next, reason ?? null, next, next, next, r.id],
      );
      changed++;
      if (next === 'failed') await notifyUnavailable(r, reason);
    }
    // Worker restarts never lose a meeting: a tracked meeting without a poll job gets one again.
    if (bot.TRACKED_STATUSES.includes(r.status) && r.native_meeting_id && !(await queue.findActiveByDedupeKey(bot.pollJobKey(r.meeting_id)))) {
      await bot.ensurePolling(r.meeting_id);
    }
  }
  return changed;
}

/** One discovery + dispatch pass. Safe to run concurrently and repeatedly. */
export async function scan(now = new Date()) {
  const s = await getSettings();
  const out = { enabled: Boolean(s.enabled), discovered: 0, scheduled: 0, skipped: 0, dispatched: 0, retry: 0, failed: 0, cancelled: 0, missed: 0, followed: 0 };
  out.followed = await followActive();
  if (!s.enabled || !vexa.isConfigured()) return out;

  const dir = await directory();
  const records = await candidates(now, config.vexa.autoLookaheadHours);
  for (const record of records) {
    const link = meetLinkOf(record);
    if (!link) continue;
    // Cancelled/deleted events are handled below (pending occurrences are cancelled, live bots stopped).
    if (record.source_deleted_at || record.state === 'cancelled') continue;
    out.discovered++;
    const result = evaluate(record, s, dir, now);
    const session = await upsertSession(record, link, result, now);
    if (!session) continue;
    if (session.state === 'skipped') out.skipped++;
    if (session.state !== 'scheduled') continue;
    out.scheduled++;
    const start = new Date(session.scheduled_start).getTime();
    const endAt = session.scheduled_end ? new Date(session.scheduled_end).getTime() : start + 3_600_000;
    if (endAt <= now.getTime()) continue; // over: reported as missed below, never a late bot
    const due = start - s.joinLeadMinutes * 60_000 <= now.getTime() && (!session.next_attempt_at || new Date(session.next_attempt_at) <= now);
    if (!due) continue;
    const r = await dispatch(session, record, result.memberIds, now);
    if (r === 'dispatched' || r === 'adopted') out.dispatched++;
    else if (r === 'retry') out.retry++;
    else if (r === 'failed') out.failed++;
  }

  // Cancelled meetings: drop pending occurrences; stop a bot that was already sent before the start.
  const [cancelled] = await pool.query(
    `SELECT s.id, s.state, s.meeting_id FROM meeting_bot_sessions s JOIN external_records er ON er.id = s.calendar_record_id
      WHERE s.state IN ('scheduled','joining') AND (er.source_deleted_at IS NOT NULL OR er.state = 'cancelled')`,
  );
  for (const c of cancelled) {
    if (c.state === 'joining' && c.meeting_id) {
      await bot.stopBot(c.meeting_id, null, null).catch((err) => logger.warn('could not stop bot of cancelled meeting', { sessionId: c.id, error: err.message }));
    }
    await pool.execute("UPDATE meeting_bot_sessions SET state = 'cancelled', state_reason = 'The meeting was cancelled in the calendar' WHERE id = ? AND state IN ('scheduled','joining')", [c.id]);
    out.cancelled++;
  }
  // Occurrences whose meeting ended before a bot could be sent (e.g. the worker was down).
  const [missed] = await pool.execute(
    "UPDATE meeting_bot_sessions SET state = 'failed', state_reason = 'The meeting ended before the bot could be sent' WHERE state = 'scheduled' AND COALESCE(scheduled_end, DATE_ADD(scheduled_start, INTERVAL 1 HOUR)) < ?",
    [now],
  );
  out.missed = missed.affectedRows;
  return out;
}

export async function enqueueScan() {
  try {
    await queue.enqueue(SCAN_JOB, {}, { dedupeKey: SCAN_JOB });
    return 1;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return 0;
    throw err;
  }
}

// ---- manual controls -----------------------------------------------------------------------------

async function sessionById(id) {
  const [[s]] = await pool.query('SELECT * FROM meeting_bot_sessions WHERE id = ?', [id]);
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  return s;
}

/** Retry a failed session: before its end the bot is sent again; afterwards the transcript is fetched again. */
export async function retrySession(actor, id, { ip = null } = {}) {
  const s = await sessionById(id);
  if (!['failed', 'skipped', 'cancelled'].includes(s.state)) throw new AppError(409, 'NOT_RETRYABLE', `A ${s.state} session cannot be retried`);
  const end = s.scheduled_end ? new Date(s.scheduled_end).getTime() : new Date(s.scheduled_start).getTime() + 3_600_000;
  if (Date.now() < end && !s.meeting_id) {
    await pool.execute("UPDATE meeting_bot_sessions SET state = 'scheduled', state_reason = 'Retry requested', next_attempt_at = NULL, attempts = 0 WHERE id = ?", [id]);
  } else if (s.meeting_id) {
    const m = await meetings.findById(s.meeting_id);
    if (m && ['failed', 'draft'].includes(m.status) && Date.now() < end) {
      await pool.execute("UPDATE meeting_bot_sessions SET state = 'scheduled', state_reason = 'Retry requested', next_attempt_at = NULL WHERE id = ?", [id]);
    } else if (m?.native_meeting_id) {
      // Meeting over: look for the transcript again (the poller imports it if Vexa has it).
      await withTransaction(async (conn) => {
        if (m.status === 'failed') await meetings.update(conn, m.id, { status: 'ended', lastError: null });
        await bot.ensurePolling(m.id, { conn });
      });
      await pool.execute("UPDATE meeting_bot_sessions SET state = 'processing', state_reason = 'Looking for the transcript again' WHERE id = ?", [id]);
    } else throw new AppError(409, 'NOT_RETRYABLE', 'The meeting is over and no bot was in it');
  } else throw new AppError(409, 'NOT_RETRYABLE', 'The meeting is over and no bot was in it');
  await audit({ actorUserId: actor.id, action: 'vexa.session_retry', entityType: 'meeting_bot_session', entityId: id, ip });
  await enqueueScan();
  return sessionView(await sessionById(id));
}

/** Do not record this occurrence (before the bot is sent). */
export async function skipSession(actor, id, { ip = null } = {}) {
  const s = await sessionById(id);
  if (s.state !== 'scheduled') throw new AppError(409, 'NOT_SKIPPABLE', 'Only meetings no bot was sent to can be skipped');
  await pool.execute("UPDATE meeting_bot_sessions SET state = 'cancelled', state_reason = ? WHERE id = ? AND state = 'scheduled'", [`Skipped by ${actor.fullName ?? 'an admin'}`, id]);
  await audit({ actorUserId: actor.id, action: 'vexa.session_skipped', entityType: 'meeting_bot_session', entityId: id, ip });
  return sessionView(await sessionById(id));
}

// ---- webhook -------------------------------------------------------------------------------------

const MAX_SKEW_MS = 5 * 60_000;

/** Verifies a Vexa delivery (webhook.v1: sha256=HMAC(secret, "<ts>.<raw body>")). */
export function verifySignature(headers, rawBody, secret = config.vexa.webhookSecret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  const sig = String(headers['x-webhook-signature'] ?? '');
  const ts = String(headers['x-webhook-timestamp'] ?? '');
  if (!/^sha256=[0-9a-f]{64}$/.test(sig) || (!/^\d{9,13}(\.\d+)?$/.test(ts) && Number.isNaN(Date.parse(ts)))) return { ok: false, reason: 'missing_signature' };
  const tsMs = /^\d+(\.\d+)?$/.test(ts) ? (Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts)) : Date.parse(ts);
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > MAX_SKEW_MS) return { ok: false, reason: 'stale' };
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Handles one Vexa webhook delivery. The webhook only speeds things up: it wakes the poller for
 * the meeting now, and the poller (source of truth) reads the state and imports the transcript.
 * De-duplicated on event_id (Vexa delivers at least once).
 */
export async function receiveWebhook(headers, rawBody) {
  const v = verifySignature(headers, rawBody);
  if (!v.ok) throw new AppError(v.reason === 'not_configured' ? 404 : 401, 'WEBHOOK_REJECTED', 'Webhook signature check failed');
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_BODY', 'Body is not JSON');
  }
  const eventId = typeof body?.event_id === 'string' ? body.event_id.slice(0, 100) : null;
  const eventType = typeof body?.event_type === 'string' ? body.event_type.slice(0, 48) : null;
  if (!eventId || !eventType) throw new AppError(400, 'INVALID_BODY', 'event_id and event_type are required');
  const m = body?.data?.meeting ?? {};
  const platform = typeof m.platform === 'string' ? m.platform.slice(0, 32) : null;
  const nativeId = typeof m.native_meeting_id === 'string' ? m.native_meeting_id.slice(0, 255) : null;
  try {
    await pool.execute('INSERT INTO vexa_webhook_events (event_id, event_type, platform, native_id, vexa_status) VALUES (?, ?, ?, ?, ?)', [eventId, eventType, platform, nativeId, typeof m.status === 'string' ? m.status.slice(0, 32) : null]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { duplicate: true };
    throw err;
  }
  let outcome = 'no_meeting';
  if (platform && nativeId) {
    const [rows] = await pool.query("SELECT id FROM meetings WHERE platform = ? AND native_meeting_id = ? AND status IN ('bot_requested','bot_joining','in_progress','ended','failed') ORDER BY id DESC LIMIT 3", [platform, nativeId]);
    for (const r of rows) {
      // Wake the pending poll job now (it keeps its dedupe key), or create one if none is active.
      const [woke] = await pool.execute("UPDATE jobs SET run_at = NOW() WHERE dedupe_key = ? AND status = 'pending'", [bot.pollJobKey(r.id)]);
      if (!woke.affectedRows) await bot.ensurePolling(r.id);
    }
    outcome = rows.length ? `polling_woken:${rows.length}` : 'no_tracked_meeting';
  }
  await pool.execute('UPDATE vexa_webhook_events SET outcome = ? WHERE event_id = ?', [outcome, eventId]);
  return { duplicate: false, outcome };
}

// ---- overview (Integrations card) ----------------------------------------------------------------

function sessionView(s) {
  const eligibility = typeof s.eligibility === 'string' ? JSON.parse(s.eligibility) : s.eligibility;
  return {
    id: s.id,
    title: s.title,
    platform: s.platform,
    nativeMeetingId: s.native_meeting_id,
    meetingId: s.meeting_id,
    calendarRecordId: s.calendar_record_id,
    organizerEmail: s.organizer_email,
    scheduledStart: s.scheduled_start,
    scheduledEnd: s.scheduled_end,
    state: s.state,
    reason: s.state_reason,
    attempts: s.attempts,
    nextAttemptAt: s.next_attempt_at,
    dispatchedAt: s.dispatched_at,
    transcriptAt: s.transcript_at,
    eligibility,
  };
}

export async function listSessions({ state, limit = 50 } = {}) {
  const [rows] = await pool.query(`SELECT * FROM meeting_bot_sessions ${state ? 'WHERE state = ?' : ''} ORDER BY scheduled_start DESC, id DESC LIMIT ?`, state ? [state, limit] : [limit]);
  return rows.map(sessionView);
}

export async function overview() {
  const s = await getSettings();
  const n = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);
  const [[last]] = await pool.query(
    "SELECT m.id, m.title, t.fetched_at AS created_at FROM transcripts t JOIN meetings m ON m.id = t.meeting_id WHERE JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.source')) = 'vexa' ORDER BY t.fetched_at DESC LIMIT 1",
  );
  const [sources] = await pool.query("SELECT provider, COUNT(*) AS n FROM integration_connections WHERE provider IN ('google_calendar','outlook') AND status = 'active' GROUP BY provider");
  const configured = vexa.isConfigured();
  const state = !configured ? 'not_configured' : s.enabled ? 'connected' : s.account ? 'paused' : 'disconnected';
  return {
    provider: 'vexa',
    displayName: 'Vexa meeting transcription',
    configured,
    problem: configured ? null : 'VEXA_BASE_URL / VEXA_API_KEY are not set',
    state,
    account: s.account ? { email: s.account.email, userId: s.account.userId, maxConcurrent: s.account.maxConcurrent, scopes: s.account.scopes, verifiedAt: s.account.verifiedAt } : null,
    bot: { name: config.vexa.botName, platform: 'Google Meet', autoExtract: config.vexa.autoExtract, pollIntervalSeconds: Math.round(config.vexa.pollIntervalMs / 1000) },
    webhook: s.webhook ? { registered: Boolean(s.webhook.registered), reason: s.webhook.reason ?? null, at: s.webhook.at ?? null } : { registered: false, reason: 'Not registered' },
    settings: publicSettings(s),
    discoverySources: sources.map((r) => ({ provider: r.provider, connections: Number(r.n) })),
    counts: {
      meetingsProcessed: await n("SELECT COUNT(*) AS n FROM transcripts WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.source')) = 'vexa'"),
      upcoming: await n("SELECT COUNT(*) AS n FROM meeting_bot_sessions WHERE state = 'scheduled'"),
      active: await n('SELECT COUNT(*) AS n FROM meeting_bot_sessions WHERE state IN (?)', [ACTIVE_STATES]),
      failed30d: await n("SELECT COUNT(*) AS n FROM meeting_bot_sessions WHERE state = 'failed' AND updated_at >= NOW() - INTERVAL 30 DAY"),
      skipped30d: await n("SELECT COUNT(*) AS n FROM meeting_bot_sessions WHERE state = 'skipped' AND updated_at >= NOW() - INTERVAL 30 DAY"),
      manualFailed: await n("SELECT COUNT(*) AS n FROM meetings WHERE status = 'failed' AND native_meeting_id IS NOT NULL AND updated_at >= NOW() - INTERVAL 30 DAY"),
    },
    lastTranscript: last ? { meetingId: last.id, title: last.title, at: last.created_at } : null,
    sessions: await listSessions({ limit: 25 }),
  };
}
