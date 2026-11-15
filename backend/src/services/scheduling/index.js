// Scheduling meetings with group invitations (Feature: department and group-based invitations;
// also used by the assistant's create_meeting command).
//
//   preview   resolve individuals + groups - exclusions at this moment: the final attendee list,
//             why each person is on it (via), counts, large-group warning, free/busy conflicts,
//             and a hash of the list. Nothing is written.
//   schedule  explicit confirmation required: the client sends back the hash it showed; membership
//             is resolved again at send time and a changed list is refused (409 RECIPIENTS_CHANGED)
//             so nobody is invited who wasn't on the confirmed list. Lists or groups above
//             GROUP_LARGE_THRESHOLD need a second confirmation (largeConfirmed). Then: meeting +
//             schedule + invitees in one transaction, and a 'meeting.invite_send' job that creates
//             the calendar event as the organiser (or, WorkAgent-only, sends in-app invitations).
//   cancel    organiser or admin; cancels the provider event (attendees are told by the provider).
//   refresh   recurring meetings with dynamic membership re-resolve their groups (worker, daily)
//             and update the event's attendees; pinned meetings keep the confirmed list.
import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import { RescheduleJob } from '../../jobs/queue.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import * as meetings from '../../repositories/meetingsRepository.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { audit, recordAudit } from '../audit.js';
import { groupScope, canSeeGroup, findGroup, resolveGroup, ensureDerivedGroups } from '../groups/index.js';
import { buildContext } from '../integrations/context.js';
import { ProviderError } from '../integrations/errors.js';
import { registry } from '../integrations/registry.js';
import { isTimeZone, notify } from '../notifications/inbox.js';
import { isAdmin } from '../permissions.js';
import { accessScope, canSeeProject } from '../records/access.js';
import { calendarOps, calendarOptions, contextFor, toInstant, wallClock } from './calendars.js';

export const JOB_TYPE = 'meeting.invite_send';
export const REFRESH_JOB_TYPE = 'meeting.attendees_refresh';
const MAX_ATTENDEES = 1000;
const DAY = 86_400_000;

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
export const largeThreshold = () => config.features.groupLargeThreshold;
export const recipientsHash = (ids) => createHash('sha256').update([...ids].sort((a, b) => a - b).join(',')).digest('hex');

// ---- attendee resolution --------------------------------------------------------------------------

/**
 * Resolves individuals and groups minus exclusions, checking the actor may invite each group.
 * @returns { invitees: [{ id, fullName, email, via }], excluded, groups, total, requiresLargeConfirmation, recipientsHash }
 */
export async function resolveAttendees(actor, { userIds = [], groupIds = [], excludedUserIds = [], organizerId = actor.id, pinned = null } = {}, conn = pool) {
  await ensureDerivedGroups(conn);
  const scope = await groupScope(actor, conn);
  const byId = new Map();
  const add = (u, via) => {
    const e = byId.get(u.id) ?? { id: u.id, fullName: u.fullName, email: u.email, via: [] };
    if (!e.via.some((v) => v.type === via.type && v.groupId === via.groupId)) e.via.push(via);
    byId.set(u.id, e);
  };

  const ids = [...new Set(userIds)];
  if (ids.length) {
    const [rows] = await conn.query('SELECT id, full_name, email, is_active FROM users WHERE id IN (?)', [ids]);
    const found = new Map(rows.map((r) => [r.id, r]));
    const bad = ids.filter((i) => !found.get(i)?.is_active);
    if (bad.length) throw badRequest('Unknown or inactive people', bad.map((b) => ({ field: 'userIds', message: `User ${b} is not active` })));
    for (const r of rows) add({ id: r.id, fullName: r.full_name, email: r.email }, { type: 'individual' });
  }

  const groups = [];
  for (const gid of [...new Set(groupIds)]) {
    const g = await findGroup(gid, conn);
    // Groups the actor may not see are reported exactly like missing ones.
    if (!g || !g.isActive || !canSeeGroup(scope, g)) throw badRequest('Unknown group', [{ field: 'groupIds', message: `Group ${gid} not found` }]);
    let members;
    if (pinned?.[gid]) {
      // Pinned membership (recurring meeting): the confirmed ids, still only active people.
      const [rows] = pinned[gid].length ? await conn.query('SELECT id, full_name, email FROM users WHERE id IN (?) AND is_active = TRUE', [pinned[gid]]) : [[]];
      members = rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email }));
    } else {
      members = [...(await resolveGroup(g, conn)).members.values()];
    }
    groups.push({ id: g.id, name: g.name, type: g.type, source: g.source, memberCount: members.length, memberIds: members.map((m) => m.id), large: members.length > largeThreshold() });
    for (const m of members) add(m, { type: 'group', groupId: g.id, name: g.name });
  }

  // The organiser is the event's organiser, not an attendee.
  byId.delete(organizerId);
  const excludedSet = new Set(excludedUserIds);
  const excluded = [...byId.values()].filter((p) => excludedSet.has(p.id));
  const invitees = [...byId.values()].filter((p) => !excludedSet.has(p.id)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  if (invitees.length > MAX_ATTENDEES) throw new AppError(422, 'TOO_MANY_ATTENDEES', `At most ${MAX_ATTENDEES} people can be invited to one meeting`);
  const total = invitees.length;
  return {
    invitees,
    excluded: excluded.map((p) => ({ id: p.id, fullName: p.fullName })),
    groups,
    total,
    threshold: largeThreshold(),
    requiresLargeConfirmation: total > largeThreshold() || groups.some((g) => g.large),
    recipientsHash: recipientsHash(invitees.map((p) => p.id)),
  };
}

// ---- input checks ---------------------------------------------------------------------------------

function checkTimes({ startAt, durationMinutes, timeZone }, now = new Date()) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw badRequest('Invalid start time', [{ field: 'startAt', message: 'Use an ISO date-time' }]);
  if (start.getTime() < now.getTime() - 5 * 60_000) throw badRequest('The meeting starts in the past', [{ field: 'startAt', message: 'Choose a future time' }]);
  if (!isTimeZone(timeZone)) throw badRequest('Unknown time zone', [{ field: 'timeZone', message: 'Use an IANA time zone such as Asia/Kolkata' }]);
  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}

async function checkProject(actor, projectId) {
  if (!projectId) return;
  const scope = await accessScope(actor);
  const [[p]] = await pool.query('SELECT id, status FROM projects WHERE id = ?', [projectId]);
  if (!p || !canSeeProject(scope, projectId)) throw badRequest('Unknown project', [{ field: 'projectId', message: 'Not found' }]);
  if (p.status === 'archived') throw badRequest('The project is archived', [{ field: 'projectId', message: 'Archived' }]);
}

async function chosenCalendar(actor, provider, connectionId) {
  const options = await calendarOptions(actor);
  if (provider === 'workagent') return options[0];
  const opt = options.find((o) => o.provider === provider && o.connectionId === connectionId);
  if (!opt) throw badRequest('Choose one of your own connected calendars', [{ field: 'connectionId', message: 'Not one of your calendar connections' }]);
  return opt;
}

// ---- availability ---------------------------------------------------------------------------------

const overlaps = (a, b) => new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);

/**
 * Free/busy for the invitees around the requested slot, through one of the organiser's calendar
 * connections (read access is enough). Returns { checked, conflicts, unknown, suggestions, problem }.
 * Never throws: availability is advice, not a gate.
 */
export async function checkAvailability(actor, { invitees, start, end, timeZone, connectionId = null }) {
  const options = (await calendarOptions(actor)).filter((o) => o.connectionId);
  const opt = options.find((o) => o.connectionId === connectionId) ?? options[0];
  if (!opt) return { checked: false, problem: 'Connect your Outlook or Google calendar to check availability', conflicts: [], unknown: [], suggestions: [] };
  try {
    const conn = await connectionsRepo.findById(opt.connectionId);
    const connector = registry.getAvailable(conn.provider);
    if (!connector) return { checked: false, problem: registry.problem(conn.provider), conflicts: [], unknown: [], suggestions: [] };
    const ctx = buildContext(connector, conn);
    const emails = invitees.slice(0, 100).map((p) => p.email.toLowerCase());
    const windowEnd = new Date(Math.max(end.getTime(), start.getTime() + 5 * DAY));
    const result = await calendarOps[conn.provider].freeBusy(ctx, { emails, startAt: start, endAt: windowEnd, timeZone });
    const slot = { start, end };
    const conflicts = [];
    const unknown = [];
    const busyAll = [];
    for (const p of invitees.slice(0, 100)) {
      const r = result[p.email.toLowerCase()];
      if (!r || r.error) {
        unknown.push({ userId: p.id, fullName: p.fullName, reason: r?.error ?? 'No free/busy information' });
        continue;
      }
      const busy = r.busy.map((b) => ({ start: toInstant(b.start, timeZone), end: toInstant(b.end, timeZone) })).filter((b) => b.start && b.end);
      busyAll.push(...busy);
      const hit = busy.filter((b) => overlaps(b, slot));
      if (hit.length) conflicts.push({ userId: p.id, fullName: p.fullName, busy: hit.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })) });
    }
    return { checked: true, provider: conn.provider, conflicts, unknown, suggestions: conflicts.length ? suggestSlots(busyAll, start, end.getTime() - start.getTime(), timeZone) : [] };
  } catch (err) {
    logger.warn('free/busy check failed', { error: err.message });
    return { checked: false, problem: err.publicMessage ?? 'The calendar did not answer the availability check', conflicts: [], unknown: [], suggestions: [] };
  }
}

/** Up to 3 free slots of the same length within 09:00-18:00 (organiser's time zone), next 5 days, 30-minute steps. */
export function suggestSlots(busy, start, durationMs, timeZone) {
  const out = [];
  for (let t = start.getTime() + 30 * 60_000; t < start.getTime() + 5 * DAY && out.length < 3; t += 30 * 60_000) {
    const s = new Date(t);
    const e = new Date(t + durationMs);
    const hs = Number(wallClock(s, timeZone).slice(11, 13));
    const he = wallClock(e, timeZone).slice(11, 16);
    if (hs < 9 || he > '18:00' || wallClock(s, timeZone).slice(0, 10) !== wallClock(e, timeZone).slice(0, 10)) continue;
    if (!busy.some((b) => overlaps(b, { start: s, end: e }))) out.push({ startAt: s.toISOString(), endAt: e.toISOString() });
  }
  return out;
}

// ---- preview / schedule ---------------------------------------------------------------------------

export async function previewMeeting(actor, input) {
  const { start, end } = checkTimes(input);
  await checkProject(actor, input.projectId);
  const calendar = await chosenCalendar(actor, input.provider, input.connectionId ?? null);
  const resolved = await resolveAttendees(actor, { userIds: input.attendees?.userIds, groupIds: input.attendees?.groupIds, excludedUserIds: input.excludedUserIds });
  const availability = input.checkAvailability === false ? { checked: false, problem: null, conflicts: [], unknown: [], suggestions: [] } : await checkAvailability(actor, { invitees: resolved.invitees, start, end, timeZone: input.timeZone, connectionId: input.connectionId ?? null });
  return {
    meeting: { title: input.title, startAt: start.toISOString(), endAt: end.toISOString(), timeZone: input.timeZone, recurrence: input.recurrence ?? null, membershipMode: input.membershipMode ?? 'pinned' },
    calendar,
    ...resolved,
    availability,
    warnings: [
      ...(calendar.provider === 'workagent' ? ['No calendar event will be created: invitees are told inside WorkAgent only.'] : []),
      ...(!calendar.canWrite ? [calendar.problem] : []),
      ...(resolved.total === 0 ? ['Nobody would be invited.'] : []),
    ],
  };
}

const toSchedule = (r) =>
  r && {
    meetingId: r.meeting_id,
    provider: r.provider,
    connectionId: r.connection_id,
    organizerUserId: r.organizer_user_id,
    startAt: r.start_at,
    endAt: r.end_at,
    timeZone: r.time_zone,
    recurrence: parse(r.recurrence),
    membershipMode: r.membership_mode,
    status: r.status,
    externalEventId: r.external_event_id,
    externalUrl: r.external_url,
    joinUrl: r.join_url,
    recipientCount: r.recipient_count,
    largeConfirmed: Boolean(r.large_confirmed),
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    sentAt: r.sent_at,
    cancelledAt: r.cancelled_at,
    lastError: r.last_error,
    lastResolvedAt: r.last_resolved_at,
  };

/**
 * Creates the meeting after explicit confirmation. `input.confirm` must be true and
 * `input.recipientsHash` the hash of the list the organiser saw.
 * @returns { meetingId }
 */
export async function scheduleMeeting(actor, input, { ip = null, commandId = null } = {}) {
  if (input.confirm !== true) throw badRequest('Confirm the attendee list before sending', [{ field: 'confirm', message: 'Required' }]);
  const { start, end } = checkTimes(input);
  await checkProject(actor, input.projectId);
  const calendar = await chosenCalendar(actor, input.provider, input.connectionId ?? null);
  if (!calendar.canWrite) throw new AppError(409, 'CALENDAR_READ_ONLY', calendar.problem);
  const resolved = await resolveAttendees(actor, { userIds: input.attendees?.userIds, groupIds: input.attendees?.groupIds, excludedUserIds: input.excludedUserIds });
  if (resolved.recipientsHash !== input.recipientsHash) {
    throw new AppError(409, 'RECIPIENTS_CHANGED', 'The attendee list changed since you reviewed it. Review the new list and confirm again.', { preview: { invitees: resolved.invitees, total: resolved.total, recipientsHash: resolved.recipientsHash, groups: resolved.groups } });
  }
  if (resolved.total === 0) throw badRequest('Nobody would be invited');
  if (resolved.requiresLargeConfirmation && input.largeConfirmed !== true) {
    throw new AppError(409, 'LARGE_CONFIRMATION_REQUIRED', `This meeting invites ${resolved.total} people${resolved.groups.some((g) => g.large) ? ' (a group has more than ' + largeThreshold() + ' members)' : ''}. Confirm the large invitation explicitly.`, { total: resolved.total, threshold: largeThreshold() });
  }
  const membershipMode = input.recurrence ? (input.membershipMode ?? 'pinned') : 'pinned';

  const meetingId = await withTransaction(async (conn) => {
    const id = await meetings.create(conn, { title: input.title, meetingUrl: '', scheduledAt: start, languageHint: null, projectId: input.projectId ?? null, createdBy: actor.id });
    await meetings.replaceParticipants(conn, id, [actor.id, ...resolved.invitees.map((p) => p.id)]);
    await conn.execute(
      `INSERT INTO meeting_schedules (meeting_id, provider, connection_id, organizer_user_id, start_at, end_at, time_zone, recurrence, membership_mode, status,
         recipients_hash, recipient_count, large_confirmed, confirmed_by, confirmed_at, last_resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, NOW(), NOW())`,
      [id, calendar.provider, calendar.connectionId, actor.id, start, end, input.timeZone, input.recurrence ? JSON.stringify(input.recurrence) : null, membershipMode, resolved.recipientsHash, resolved.total, Boolean(input.largeConfirmed), actor.id],
    );
    for (const g of resolved.groups) {
      await conn.execute('INSERT INTO meeting_invite_groups (meeting_id, group_id, group_name, group_type, member_count, pinned_user_ids) VALUES (?, ?, ?, ?, ?, ?)', [id, g.id, g.name, g.type, g.memberCount, membershipMode === 'pinned' ? JSON.stringify(g.memberIds) : null]);
    }
    const rows = [
      ...resolved.invitees.map((p) => [id, p.id, p.email, JSON.stringify(p.via), false, null]),
      ...resolved.excluded.map((p) => [id, p.id, '', JSON.stringify([{ type: 'excluded' }]), true, actor.id]),
    ];
    if (rows.length) await conn.query('INSERT INTO meeting_invitees (meeting_id, user_id, email, via, excluded, excluded_by) VALUES ?', [rows]);
    await recordAudit(conn, {
      actorUserId: actor.id,
      action: 'meeting.scheduled',
      entityType: 'meeting',
      entityId: id,
      after: { title: input.title, provider: calendar.provider, startAt: start.toISOString(), recipients: resolved.total, groups: resolved.groups.map((g) => ({ id: g.id, name: g.name, members: g.memberCount })), excluded: resolved.excluded.length, largeConfirmed: Boolean(input.largeConfirmed), membershipMode, commandId },
      ip,
    });
    await queue.enqueue(JOB_TYPE, { meetingId: id }, { dedupeKey: `${JOB_TYPE}:${id}`, conn });
    return id;
  });
  return { meetingId, recipients: resolved.total };
}

// ---- sending (worker) -----------------------------------------------------------------------------

async function loadSchedule(meetingId, conn = pool, forUpdate = false) {
  const [[r]] = await conn.query(`SELECT * FROM meeting_schedules WHERE meeting_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [meetingId]);
  return toSchedule(r);
}

async function activeInvitees(meetingId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT i.user_id, u.email, u.full_name FROM meeting_invitees i JOIN users u ON u.id = i.user_id WHERE i.meeting_id = ? AND i.excluded = FALSE AND u.is_active = TRUE ORDER BY u.full_name`,
    [meetingId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.full_name }));
}

async function notifyInvitees(conn, meetingId, userIds, { title, body, key }) {
  for (const userId of userIds) await notify(conn, { userId, kind: 'meeting_invited', title, body, link: `/meetings/scheduled/${meetingId}`, entityType: 'meeting', entityId: meetingId, dedupeKey: `${key}:${meetingId}` });
}

/** Worker: creates the calendar event (or sends in-app invitations). Returns 'sent' | 'failed' | 'skipped'. */
export async function sendInvitations(meetingId) {
  const s = await loadSchedule(meetingId);
  if (!s || s.status !== 'sending') return 'skipped';
  const meeting = await meetings.findById(meetingId);
  const attendees = await activeInvitees(meetingId);
  const [[organizer]] = await pool.query('SELECT full_name FROM users WHERE id = ?', [s.organizerUserId]);
  const when = `${wallClock(s.startAt, s.timeZone).replace('T', ' ').slice(0, 16)} (${s.timeZone})`;

  let result = { externalEventId: null, externalUrl: null, joinUrl: null };
  if (s.provider !== 'workagent') {
    try {
      const { ctx } = await contextFor(s.provider, s.connectionId, s.organizerUserId);
      result = await calendarOps[s.provider].createEvent(ctx, {
        meetingId,
        idempotencyKey: `workagent-meeting-${meetingId}`,
        title: meeting.title,
        description: `Scheduled in WorkAgent by ${organizer?.full_name ?? 'the organiser'}.`,
        startAt: s.startAt,
        endAt: s.endAt,
        timeZone: s.timeZone,
        recurrence: s.recurrence,
        attendees,
      });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'rate_limited') throw new RescheduleJob(err.waitMs(), 'calendar rate limit');
      if (err.kind === 'transient') throw err;
      await markFailed(meetingId, err.publicMessage ?? err.message);
      return 'failed';
    }
  }

  let cancelledMeanwhile = false;
  await withTransaction(async (conn) => {
    const now = await loadSchedule(meetingId, conn, true);
    if (now.status === 'cancelled') {
      cancelledMeanwhile = true;
      return;
    }
    await conn.execute("UPDATE meeting_schedules SET status = 'sent', sent_at = NOW(), external_event_id = ?, external_url = ?, join_url = ?, last_error = NULL WHERE meeting_id = ?", [result.externalEventId, result.externalUrl, result.joinUrl, meetingId]);
    if (result.joinUrl) await meetings.update(conn, meetingId, { meetingUrl: result.joinUrl.slice(0, 1024), platform: s.provider === 'outlook' ? 'teams' : 'google_meet' });
    await notifyInvitees(conn, meetingId, attendees.map((a) => a.userId), { title: `${organizer?.full_name ?? 'Someone'} invited you: ${meeting.title}`, body: when, key: 'invited' });
    await recordAudit(conn, { actorUserId: s.organizerUserId, action: 'meeting.invitations_sent', entityType: 'meeting', entityId: meetingId, after: { provider: s.provider, recipients: attendees.length, externalEventId: result.externalEventId } });
  });
  if (cancelledMeanwhile && result.externalEventId) {
    // Cancelled while the event was being created: cancel the new event too.
    const { ctx } = await contextFor(s.provider, s.connectionId, s.organizerUserId);
    await calendarOps[s.provider].cancelEvent(ctx, result.externalEventId, 'Cancelled').catch((err) => logger.error('could not cancel event created after cancellation', { meetingId, error: err.message }));
    return 'skipped';
  }
  return 'sent';
}

export async function markFailed(meetingId, message) {
  await pool.execute("UPDATE meeting_schedules SET status = 'failed', last_error = ? WHERE meeting_id = ? AND status = 'sending'", [String(message).slice(0, 1000), meetingId]);
  const s = await loadSchedule(meetingId);
  if (s) await notify(pool, { userId: s.organizerUserId, kind: 'meeting_invited', title: 'Meeting invitations could not be sent', body: String(message).slice(0, 300), link: `/meetings/scheduled/${meetingId}`, entityType: 'meeting', entityId: meetingId, dedupeKey: `send_failed:${meetingId}` });
  await audit({ actorUserId: null, action: 'meeting.invitations_failed', entityType: 'meeting', entityId: meetingId, after: { error: String(message).slice(0, 500) } });
}

// ---- reads ----------------------------------------------------------------------------------------

async function canViewScheduled(user, s) {
  if (isAdmin(user) || s.organizerUserId === user.id) return true;
  const [[r]] = await pool.query('SELECT 1 AS ok FROM meeting_invitees WHERE meeting_id = ? AND user_id = ? AND excluded = FALSE', [s.meetingId, user.id]);
  return Boolean(r);
}

export async function getScheduled(user, meetingId) {
  const s = await loadSchedule(meetingId);
  if (!s || !(await canViewScheduled(user, s))) throw notFound('Meeting not found');
  const meeting = await meetings.findById(meetingId);
  const [invitees] = await pool.query(
    `SELECT i.user_id, u.full_name, i.email, i.via, i.excluded FROM meeting_invitees i JOIN users u ON u.id = i.user_id WHERE i.meeting_id = ? ORDER BY i.excluded, u.full_name`,
    [meetingId],
  );
  const [groups] = await pool.query('SELECT group_id, group_name, group_type, member_count, pinned_user_ids IS NOT NULL AS pinned FROM meeting_invite_groups WHERE meeting_id = ? ORDER BY group_name', [meetingId]);
  const [[organizer]] = await pool.query('SELECT id, full_name FROM users WHERE id = ?', [s.organizerUserId]);
  const organizerView = isAdmin(user) || s.organizerUserId === user.id;
  return {
    meeting: { id: meeting.id, title: meeting.title, projectId: meeting.projectId ?? meeting.project_id ?? null, meetingUrl: meeting.meeting_url || null },
    schedule: { ...s, organizer: organizer ? { id: organizer.id, fullName: organizer.full_name } : null },
    // Attendees see who else is invited (as in any calendar invitation); only the organiser sees why and who was excluded.
    invitees: invitees.filter((r) => organizerView || !r.excluded).map((r) => ({ userId: r.user_id, fullName: r.full_name, ...(organizerView ? { email: r.email, via: parse(r.via), excluded: Boolean(r.excluded) } : {}) })),
    groups: groups.map((g) => ({ id: g.group_id, name: g.group_name, type: g.group_type, memberCount: g.member_count, pinned: Boolean(g.pinned) })),
    permissions: { canCancel: organizerView && ['sending', 'sent', 'failed'].includes(s.status) },
  };
}

export async function listScheduled(user, { scope = 'mine', limit = 50 } = {}) {
  const params = [];
  let where;
  if (scope === 'all' && isAdmin(user)) where = '1=1';
  else {
    where = '(s.organizer_user_id = ? OR EXISTS (SELECT 1 FROM meeting_invitees i WHERE i.meeting_id = s.meeting_id AND i.user_id = ? AND i.excluded = FALSE))';
    params.push(user.id, user.id);
  }
  const [rows] = await pool.query(
    `SELECT s.*, m.title, u.full_name AS organizer_name FROM meeting_schedules s JOIN meetings m ON m.id = s.meeting_id JOIN users u ON u.id = s.organizer_user_id
     WHERE ${where} ORDER BY s.start_at DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map((r) => ({ ...toSchedule(r), title: r.title, organizerName: r.organizer_name }));
}

// ---- cancel ---------------------------------------------------------------------------------------

/** Cancels a scheduled meeting. Returns { cancelled, providerCancelled }. Throws if the provider refuses. */
export async function cancelMeeting(user, meetingId, { ip = null, reason = null } = {}) {
  const s = await loadSchedule(meetingId);
  if (!s || !(await canViewScheduled(user, s))) throw notFound('Meeting not found');
  if (!(isAdmin(user) || s.organizerUserId === user.id)) throw forbidden('Only the organiser can cancel this meeting');
  if (s.status === 'cancelled') throw conflict('The meeting is already cancelled');
  let providerCancelled = false;
  if (s.status === 'sent' && s.externalEventId) {
    try {
      const { ctx } = await contextFor(s.provider, s.connectionId, s.organizerUserId);
      await calendarOps[s.provider].cancelEvent(ctx, s.externalEventId, reason ?? 'Cancelled in WorkAgent');
      providerCancelled = true;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      throw new AppError(502, 'CALENDAR_CANCEL_FAILED', `The calendar event could not be cancelled: ${err.publicMessage ?? err.message}. Nothing was changed.`);
    }
  }
  const attendees = await activeInvitees(meetingId);
  await withTransaction(async (conn) => {
    await conn.execute("UPDATE meeting_schedules SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ? WHERE meeting_id = ?", [user.id, meetingId]);
    const meeting = await meetings.findById(meetingId, conn);
    if (s.status === 'sent') await notifyInvitees(conn, meetingId, attendees.map((a) => a.userId), { title: `Cancelled: ${meeting.title}`, body: reason, key: 'cancelled' });
    await recordAudit(conn, { actorUserId: user.id, action: 'meeting.cancelled', entityType: 'meeting', entityId: meetingId, before: { status: s.status }, after: { status: 'cancelled', providerCancelled, reason }, ip });
  });
  return { cancelled: true, providerCancelled, provider: s.provider, previousStatus: s.status };
}

// ---- dynamic membership (recurring meetings) ------------------------------------------------------

/** Re-resolves one dynamic recurring meeting; updates invitees and the provider event when the list changed. */
export async function refreshAttendees(meetingId) {
  const s = await loadSchedule(meetingId);
  if (!s || s.status !== 'sent' || s.membershipMode !== 'dynamic' || !s.recurrence) return 'skipped';
  const [organizerRow] = await pool.query('SELECT id, role FROM users WHERE id = ? AND is_active = TRUE', [s.organizerUserId]);
  if (!organizerRow.length) return 'skipped';
  const organizer = { id: organizerRow[0].id, role: organizerRow[0].role };
  const [rows] = await pool.query('SELECT user_id, via, excluded FROM meeting_invitees WHERE meeting_id = ?', [meetingId]);
  const individuals = rows.filter((r) => !r.excluded && parse(r.via).some((v) => v.type === 'individual')).map((r) => r.user_id);
  const excludedIds = rows.filter((r) => r.excluded).map((r) => r.user_id);
  const [groupRows] = await pool.query('SELECT group_id FROM meeting_invite_groups WHERE meeting_id = ?', [meetingId]);
  let resolved;
  try {
    resolved = await resolveAttendees(organizer, { userIds: individuals, groupIds: groupRows.map((g) => g.group_id), excludedUserIds: excludedIds, organizerId: s.organizerUserId });
  } catch (err) {
    logger.warn('dynamic attendee refresh skipped', { meetingId, error: err.message });
    return 'skipped';
  }
  if (resolved.recipientsHash === (await pool.query('SELECT recipients_hash FROM meeting_schedules WHERE meeting_id = ?', [meetingId]))[0][0].recipients_hash) {
    await pool.execute('UPDATE meeting_schedules SET last_resolved_at = NOW() WHERE meeting_id = ?', [meetingId]);
    return 'unchanged';
  }
  if (s.externalEventId) {
    const { ctx } = await contextFor(s.provider, s.connectionId, s.organizerUserId);
    await calendarOps[s.provider].updateAttendees(ctx, s.externalEventId, resolved.invitees.map((p) => ({ email: p.email, name: p.fullName })));
  }
  const before = new Set(rows.filter((r) => !r.excluded).map((r) => r.user_id));
  const added = resolved.invitees.filter((p) => !before.has(p.id));
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM meeting_invitees WHERE meeting_id = ? AND excluded = FALSE', [meetingId]);
    if (resolved.invitees.length) await conn.query('INSERT INTO meeting_invitees (meeting_id, user_id, email, via) VALUES ?', [resolved.invitees.map((p) => [meetingId, p.id, p.email, JSON.stringify(p.via)])]);
    await meetings.replaceParticipants(conn, meetingId, [s.organizerUserId, ...resolved.invitees.map((p) => p.id)]);
    await conn.execute('UPDATE meeting_schedules SET recipients_hash = ?, recipient_count = ?, last_resolved_at = NOW() WHERE meeting_id = ?', [resolved.recipientsHash, resolved.total, meetingId]);
    const meeting = await meetings.findById(meetingId, conn);
    await notifyInvitees(conn, meetingId, added.map((p) => p.id), { title: `You were added to: ${meeting.title}`, body: 'Group membership changed', key: 'added' });
    await recordAudit(conn, { actorUserId: null, action: 'meeting.attendees_refreshed', entityType: 'meeting', entityId: meetingId, after: { recipients: resolved.total, added: added.length, removed: [...before].filter((id) => !resolved.invitees.some((p) => p.id === id)).length } });
  });
  return 'updated';
}

/** Worker tick: queue a refresh for every dynamic recurring meeting not refreshed in the last day. */
export async function enqueueDueRefreshes() {
  const [rows] = await pool.query(
    `SELECT meeting_id FROM meeting_schedules WHERE status = 'sent' AND membership_mode = 'dynamic' AND recurrence IS NOT NULL
       AND (last_resolved_at IS NULL OR last_resolved_at < DATE_SUB(NOW(), INTERVAL 1 DAY)) LIMIT 100`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await queue.enqueue(REFRESH_JOB_TYPE, { meetingId: r.meeting_id }, { dedupeKey: `${REFRESH_JOB_TYPE}:${r.meeting_id}` });
      n += 1;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  return n;
}
