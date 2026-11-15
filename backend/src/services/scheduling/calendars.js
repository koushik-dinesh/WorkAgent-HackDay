// Calendar providers for meetings WorkAgent schedules (group invitations, assistant commands).
//
//   outlook      Microsoft Graph, the connected account's calendar: POST /me/events with a Teams
//                meeting (isOnlineMeeting), /events/{id}/cancel, PATCH attendees, getSchedule
//                for free/busy. Needs Calendars.ReadWrite (OUTLOOK_CALENDAR_WRITE, opt-in).
//   google_calendar  Google Calendar API, the connected account's primary calendar: events.insert
//                with a Meet conference and sendUpdates=all, events.delete, events.patch, freeBusy.
//                Needs calendar.events (GOOGLE_CALENDAR_WRITE, opt-in).
//
// Permissions: an event is created only through a connection the organiser connected themselves
// (connected_by = organiser), so invitations always go out as the organiser with their own OAuth
// grant and WorkAgent never sends as somebody else. Without such a connection the meeting is
// WorkAgent-only (in-app invitations, no calendar event).
//
// Idempotency: Graph's transactionId and a deterministic Google event id derived from the meeting
// id, so a retried job never creates a second event.
import { pool } from '../../db/pool.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import { buildContext } from '../integrations/context.js';
import { ProviderError } from '../integrations/errors.js';
import { calendarApi, canWriteGoogleCalendar } from '../integrations/providers/google/calendar.js';
import { graphClient } from '../integrations/providers/microsoft/graph.js';
import { canWriteCalendar } from '../integrations/providers/microsoft/outlook.js';
import { registry as defaultRegistry } from '../integrations/registry.js';

export const CALENDAR_PROVIDERS = ['outlook', 'google_calendar'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const canWrite = (provider, connection) => (provider === 'outlook' ? canWriteCalendar(connection) : canWriteGoogleCalendar(connection));
const writeFlag = (provider) => (provider === 'outlook' ? 'OUTLOOK_CALENDAR_WRITE' : 'GOOGLE_CALENDAR_WRITE');

/** "YYYY-MM-DDTHH:mm:ss" wall-clock time of an instant in a time zone (what both APIs expect with timeZone). */
export function wallClock(instant, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** An instant from a wall-clock "YYYY-MM-DDTHH:mm:ss" in `timeZone` (or an ISO string with offset). */
export function toInstant(value, timeZone = 'UTC') {
  if (!value) return null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(value)) return new Date(value);
  const guess = new Date(`${value.slice(0, 19)}Z`);
  const offset = new Date(`${wallClock(guess, timeZone)}Z`).getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/**
 * Calendars a person can send invitations from: their own active Outlook / Google connections,
 * with whether the grant allows writing (and why not). 'workagent' (in-app only) is always offered.
 */
export async function calendarOptions(user, { registry = defaultRegistry } = {}) {
  const [rows] = await pool.query(
    `SELECT id FROM integration_connections WHERE provider IN (?) AND status = 'active' AND is_enabled = TRUE AND connected_by = ? ORDER BY provider, id`,
    [CALENDAR_PROVIDERS, user.id],
  );
  const out = [{ provider: 'workagent', connectionId: null, label: 'WorkAgent only (in-app invitations, no calendar event)', canWrite: true, problem: null }];
  for (const r of rows) {
    const c = await connectionsRepo.findById(r.id);
    const available = registry.getAvailable(c.provider);
    const writable = canWrite(c.provider, c);
    out.push({
      provider: c.provider,
      connectionId: c.id,
      label: c.displayName,
      canWrite: Boolean(available && writable),
      problem: !available ? registry.problem(c.provider) : !writable ? `This connection can only read the calendar. Set ${writeFlag(c.provider)}=true, then connect again and allow calendar write access.` : null,
    });
  }
  return out;
}

/** The connection, connector and ctx for sending as `organizerId`; throws ProviderError when not allowed. */
export async function contextFor(provider, connectionId, organizerId, { registry = defaultRegistry } = {}) {
  const connection = await connectionsRepo.findById(connectionId);
  if (!connection || connection.provider !== provider || connection.status !== 'active' || !connection.isEnabled) {
    throw new ProviderError('forbidden', 'Calendar connection not available', { publicMessage: 'The calendar connection is not available any more' });
  }
  if (connection.connectedBy !== organizerId) {
    throw new ProviderError('forbidden', 'Calendar connection belongs to someone else', { publicMessage: 'Invitations can only be sent from your own connected calendar' });
  }
  const connector = registry.getAvailable(provider);
  if (!connector) throw new ProviderError('forbidden', `${provider} not configured`, { publicMessage: `${provider === 'outlook' ? 'Outlook' : 'Google'} is not configured on the server: ${registry.problem(provider)}` });
  if (!canWrite(provider, connection)) {
    throw new ProviderError('forbidden', 'Calendar grant is read-only', { publicMessage: `This calendar connection can only read. Set ${writeFlag(provider)}=true, then connect again and allow calendar write access.` });
  }
  return { connection, connector, ctx: buildContext(connector, connection) };
}

// ---- Outlook (Microsoft Graph) --------------------------------------------------------------------

function graphRecurrence(rec, startAt, timeZone) {
  if (!rec) return undefined;
  const startDate = wallClock(startAt, timeZone).slice(0, 10);
  const day = WEEKDAYS[new Date(`${startDate}T00:00:00Z`).getUTCDay()];
  return {
    pattern: rec.frequency === 'daily' ? { type: 'daily', interval: rec.interval ?? 1 } : { type: 'weekly', interval: rec.interval ?? 1, daysOfWeek: [day], firstDayOfWeek: 'monday' },
    range: { type: 'numbered', startDate, numberOfOccurrences: rec.count, recurrenceTimeZone: timeZone },
  };
}

const graphAttendees = (attendees) => attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: 'required' }));

const outlook = {
  async createEvent(ctx, ev) {
    const api = graphClient(ctx);
    const body = {
      subject: ev.title,
      body: { contentType: 'text', content: ev.description ?? '' },
      start: { dateTime: wallClock(ev.startAt, ev.timeZone), timeZone: ev.timeZone },
      end: { dateTime: wallClock(ev.endAt, ev.timeZone), timeZone: ev.timeZone },
      attendees: graphAttendees(ev.attendees),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      allowNewTimeProposals: true,
      // Graph de-duplicates creates with the same transactionId.
      transactionId: ev.idempotencyKey,
      ...(ev.recurrence ? { recurrence: graphRecurrence(ev.recurrence, ev.startAt, ev.timeZone) } : {}),
    };
    const res = await api.post('/v1.0/me/events', body);
    const e = res.body ?? {};
    if (!e.id) throw new ProviderError('invalid_response', 'Graph returned no event id');
    return { externalEventId: e.id, externalUrl: e.webLink ?? null, joinUrl: e.onlineMeeting?.joinUrl ?? null };
  },
  async cancelEvent(ctx, eventId, comment) {
    // Only the organiser can cancel; attendees get a cancellation message.
    await graphClient(ctx).post(`/v1.0/me/events/${encodeURIComponent(eventId)}/cancel`, { comment: comment ?? '' });
  },
  async updateAttendees(ctx, eventId, attendees) {
    await graphClient(ctx).request('PATCH', `/v1.0/me/events/${encodeURIComponent(eventId)}`, { body: { attendees: graphAttendees(attendees) } });
  },
  /** { email -> [{ start, end }] busy intervals } or per-address errors. */
  async freeBusy(ctx, { emails, startAt, endAt, timeZone }) {
    const res = await graphClient(ctx).post('/v1.0/me/calendar/getSchedule', {
      schedules: emails,
      startTime: { dateTime: wallClock(startAt, timeZone), timeZone },
      endTime: { dateTime: wallClock(endAt, timeZone), timeZone },
      availabilityViewInterval: 15,
    }, { headers: { Prefer: `outlook.timezone="${timeZone}"` } });
    const out = {};
    for (const s of res.body?.value ?? []) {
      const email = String(s.scheduleId ?? '').toLowerCase();
      if (s.error) out[email] = { error: s.error.message ?? 'unavailable' };
      else out[email] = { busy: (s.scheduleItems ?? []).filter((i) => i.status !== 'free').map((i) => ({ start: toInstant(i.start?.dateTime, i.start?.timeZone ?? timeZone)?.toISOString(), end: toInstant(i.end?.dateTime, i.end?.timeZone ?? timeZone)?.toISOString(), status: i.status })) };
    }
    return out;
  },
};

// ---- Google Calendar ------------------------------------------------------------------------------

// Event ids: base32hex characters (a-v, 0-9), 5-1024 long. Deterministic per meeting = idempotent.
export const googleEventId = (meetingId) => `workagentmeeting${meetingId}`.replace(/[^a-v0-9]/g, '0');

function googleRecurrence(rec) {
  if (!rec) return undefined;
  return [`RRULE:FREQ=${rec.frequency === 'daily' ? 'DAILY' : 'WEEKLY'};INTERVAL=${rec.interval ?? 1};COUNT=${rec.count}`];
}

const googleCalendar = {
  async createEvent(ctx, ev) {
    const api = calendarApi(ctx);
    const id = googleEventId(ev.meetingId);
    const body = {
      id,
      summary: ev.title,
      description: ev.description ?? '',
      start: { dateTime: wallClock(ev.startAt, ev.timeZone), timeZone: ev.timeZone },
      end: { dateTime: wallClock(ev.endAt, ev.timeZone), timeZone: ev.timeZone },
      attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name })),
      conferenceData: { createRequest: { requestId: ev.idempotencyKey, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      ...(ev.recurrence ? { recurrence: googleRecurrence(ev.recurrence) } : {}),
    };
    let res = await api.post('/calendar/v3/calendars/primary/events', body, { query: { conferenceDataVersion: 1, sendUpdates: 'all' }, okStatuses: [409] });
    if (res.status === 409) res = await api.get(`/calendar/v3/calendars/primary/events/${id}`); // created by an earlier attempt
    const e = res.body ?? {};
    if (!e.id) throw new ProviderError('invalid_response', 'Google returned no event id');
    return { externalEventId: e.id, externalUrl: e.htmlLink ?? null, joinUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null };
  },
  async cancelEvent(ctx, eventId) {
    await calendarApi(ctx).request('DELETE', `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { query: { sendUpdates: 'all' }, okStatuses: [410] });
  },
  async updateAttendees(ctx, eventId, attendees) {
    await calendarApi(ctx).request('PATCH', `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { query: { sendUpdates: 'all' }, body: { attendees: attendees.map((a) => ({ email: a.email, displayName: a.name })) } });
  },
  async freeBusy(ctx, { emails, startAt, endAt, timeZone }) {
    const res = await calendarApi(ctx).post('/calendar/v3/freeBusy', { timeMin: new Date(startAt).toISOString(), timeMax: new Date(endAt).toISOString(), timeZone, items: emails.map((id) => ({ id })) });
    const out = {};
    for (const [email, cal] of Object.entries(res.body?.calendars ?? {})) {
      out[email.toLowerCase()] = cal.errors?.length ? { error: cal.errors[0].reason ?? 'unavailable' } : { busy: (cal.busy ?? []).map((b) => ({ start: b.start, end: b.end, status: 'busy' })) };
    }
    return out;
  },
};

export const calendarOps = { outlook, google_calendar: googleCalendar };
