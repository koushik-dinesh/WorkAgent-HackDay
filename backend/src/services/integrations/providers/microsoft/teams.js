// Microsoft Teams connector: channel conversations and (optionally) Teams meetings with their
// transcripts, through Microsoft Graph (delegated).
//
// Resources: the channels of the teams the connected account belongs to (one per channel), plus
// one "Teams meetings" resource for the account's calendar when the meeting scopes were granted.
// Records: message (a channel post; title = subject or its first words) and its replies (children);
// teams_meeting (a calendar event that is a Teams online meeting).
// Sync: channel messages delta (top-level posts, edits and deletions), then the replies of every
// post seen in that run. Meetings: calendarView delta over the backfill window and the next
// MEETING_LOOKAHEAD_DAYS days, keeping only Teams online meetings. Mentions such as PAY-42 or
// acme/api#12 feed relationship suggestions.
// Transcripts: fetchTranscript() finds the online meeting by its join URL and downloads the newest
// transcript as WebVTT; services/transcripts/importer.js decides when to call it and what to do
// with it. Graph only returns transcripts of meetings the connected account can access (in
// practice: meetings it organized), and only after the tenant has granted admin consent for
// OnlineMeetingTranscript.Read.All (runbook §12).
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { beginMicrosoftConnect, completeMicrosoftConnect, deltaPage, graphClient, hasScopes, htmlToText, listAll, microsoftConfigProblem, refreshMicrosoftTokens, tenantInstance } from './graph.js';

// Required: the connection is refused without them.
export const TEAMS_CHANNEL_SCOPES = ['offline_access', 'User.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'];
// Optional: meeting discovery and transcripts turn on only when all of these were granted.
export const TEAMS_MEETING_SCOPES = ['Calendars.Read', 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'];
export const TEAMS_SCOPES = [...TEAMS_CHANNEL_SCOPES, ...TEAMS_MEETING_SCOPES];
// Optional (TEAMS_MESSAGE_SEND=true): posting approved notifications to a channel.
export const TEAMS_SEND_SCOPE = 'ChannelMessage.Send';
const scopesToRequest = () => [...TEAMS_SCOPES, ...(config.features.teamsMessageSend ? [TEAMS_SEND_SCOPE] : [])];
export const canSendMessages = (connection) => hasScopes(connection?.settings?.scopes, [TEAMS_SEND_SCOPE]);
const REPLY_POSTS_PER_CHUNK = 5;
const MEETING_LOOKAHEAD_DAYS = 14;
const MEETINGS_RESOURCE_ID = 'me/meetings';

/** Whether a connection's grant covers meeting discovery and transcripts. */
export const meetingsEnabled = (connection) => hasScopes(connection?.settings?.scopes, TEAMS_MEETING_SCOPES);

const identityOf = (from) => {
  const u = from?.user;
  return u?.id ? [{ type: 'identity', externalUserId: u.id, login: u.displayName ?? null, displayName: u.displayName ?? null, isBot: false }] : from?.application?.id ? [{ type: 'identity', externalUserId: from.application.id, login: from.application.displayName ?? null, displayName: from.application.displayName ?? null, isBot: true }] : [];
};
const authorRef = (from) => (from?.user?.id ? { externalUserId: from.user.id } : from?.application?.id ? { externalUserId: from.application.id } : null);
const titleOf = (m, text) => m.subject || (text ? (text.length > 80 ? `${text.slice(0, 77)}…` : text) : 'Message');

/** Envelopes for a channel post or a reply (`parent` = the post's message id). */
export function messageEnvelopes(source, channelId, m, parent = null) {
  // Message ids are unique within a channel; the record id carries the channel.
  const ref = { recordType: 'message', externalId: `${channelId}/${m.id}` };
  if (m['@removed'] || m.deletedDateTime) {
    // A tombstone: ingest marks the stored message deleted and keeps its content.
    return [{ type: 'record', ...ref, title: null, body: null, deleted: true, sourceUpdatedAt: m.deletedDateTime ?? m.lastModifiedDateTime ?? null }];
  }
  if (m.messageType && m.messageType !== 'message') return []; // system events (member added, …)
  const text = htmlToText(m.body?.contentType === 'html' ? m.body.content : m.body?.content);
  const who = m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'someone';
  return [
    ...identityOf(m.from),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: m.webUrl ?? null,
      title: titleOf(m, text),
      body: text,
      state: null,
      statusCategory: 'unknown',
      authorRef: authorRef(m.from),
      parentRef: parent ? { recordType: 'message', externalId: `${channelId}/${parent}` } : null,
      sourceCreatedAt: m.createdDateTime ?? null,
      sourceUpdatedAt: m.lastEditedDateTime ?? m.lastModifiedDateTime ?? m.createdDateTime ?? null,
      metadata: { importance: m.importance ?? null, mentions: (m.mentions ?? []).map((x) => x.mentioned?.user?.displayName).filter(Boolean), replyTo: parent },
    },
    {
      type: 'activity',
      dedupeKey: `microsoft_teams:${source}:message:${channelId}/${m.id}:created`.slice(0, 191),
      activityType: parent ? 'commented' : 'created',
      recordRef: ref,
      actorRef: authorRef(m.from),
      occurredAt: m.createdDateTime ?? new Date().toISOString(),
      summary: parent ? `${who} replied in a Teams thread` : `${who} posted “${titleOf(m, text)}” in Teams`,
    },
  ];
}

async function syncMessages(ctx, { resource, cursor, phase, since }) {
  const api = graphClient(ctx);
  const { teamId, channelId } = resource.metadata ?? {};
  if (!teamId || !channelId) throw new ProviderError('invalid_request', 'Teams channel resource without ids');
  const base = `/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`;
  let c = { pendingReplies: [], ...(cursor ?? {}) };
  const source = tenantInstance();

  if (c.pendingReplies.length) {
    const batch = c.pendingReplies.slice(0, REPLY_POSTS_PER_CHUNK);
    const envelopes = [];
    for (const postId of batch) {
      try {
        const replies = await listAll(api, `${base}/messages/${encodeURIComponent(postId)}/replies`, { $top: 50 }, 10);
        for (const r of replies) envelopes.push(...messageEnvelopes(source, channelId, r, postId));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err;
      }
    }
    const pendingReplies = c.pendingReplies.slice(batch.length);
    if (!pendingReplies.length && c.listed) return { envelopes, cursor: { next: null, delta: c.delta, pendingReplies: [] }, phase: 'incremental', done: true };
    return { envelopes, cursor: { ...c, pendingReplies }, phase, done: false };
  }

  const filter = !c.delta && since ? { $filter: `lastModifiedDateTime gt ${new Date(since).toISOString()}` } : undefined;
  const page = await deltaPage(api, c, { path: `${base}/messages/delta`, query: { $top: 50, ...(filter ?? {}) } });
  const envelopes = page.items.flatMap((m) => messageEnvelopes(source, channelId, m));
  const posts = page.items.filter((m) => !m['@removed'] && !m.deletedDateTime && (!m.messageType || m.messageType === 'message')).map((m) => m.id);
  const pendingReplies = [...new Set([...c.pendingReplies, ...posts])];
  if (!page.done) return { envelopes, cursor: { ...page.cursor, pendingReplies }, phase, done: false };
  if (pendingReplies.length) return { envelopes, cursor: { ...page.cursor, pendingReplies, listed: true }, phase, done: false };
  return { envelopes, cursor: { ...page.cursor, pendingReplies: [] }, phase: 'incremental', done: true };
}

// ---- meetings -----------------------------------------------------------------------------------

/** Graph event times are UTC wall-clock without a zone unless a Prefer header asks otherwise. */
const graphTime = (t) => {
  if (!t?.dateTime) return null;
  const s = String(t.dateTime);
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const emailOf = (p) => (p?.emailAddress?.address ? String(p.emailAddress.address).toLowerCase() : null);
const isTeamsMeeting = (ev) => Boolean(ev.isOnlineMeeting && ev.onlineMeeting?.joinUrl && (!ev.onlineMeetingProvider || ev.onlineMeetingProvider === 'teamsForBusiness'));

/** Envelopes for a calendar event that is a Teams meeting (others produce nothing). */
export function meetingEnvelopes(source, ev, now = new Date()) {
  const ref = { recordType: 'teams_meeting', externalId: String(ev.id).slice(0, 191) };
  if (ev['@removed']) return [{ type: 'record', ...ref, title: null, body: null, deleted: true }];
  if (!isTeamsMeeting(ev)) return [];
  const start = graphTime(ev.start);
  const end = graphTime(ev.end);
  const organizer = emailOf(ev.organizer);
  const cancelled = Boolean(ev.isCancelled);
  const ended = end && new Date(end) < now;
  return [
    ...(organizer ? [{ type: 'identity', externalUserId: organizer, login: organizer, displayName: ev.organizer?.emailAddress?.name ?? null, email: organizer, isBot: false }] : []),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: ev.webLink ?? null,
      title: ev.subject || '(no title)',
      body: ev.bodyPreview ? String(ev.bodyPreview).slice(0, 2000) : null,
      state: cancelled ? 'cancelled' : ended ? 'ended' : 'scheduled',
      statusCategory: cancelled ? 'cancelled' : ended ? 'done' : 'todo',
      authorRef: organizer ? { externalUserId: organizer } : null,
      sourceCreatedAt: ev.createdDateTime ?? null,
      sourceUpdatedAt: ev.lastModifiedDateTime ?? null,
      metadata: {
        start,
        end,
        joinUrl: ev.onlineMeeting.joinUrl,
        organizer,
        attendees: (ev.attendees ?? []).map(emailOf).filter(Boolean).slice(0, 200),
        iCalUId: ev.iCalUId ?? null,
        cancelled,
      },
    },
    {
      type: 'activity',
      dedupeKey: `microsoft_teams:${source}:meeting:${ev.id}:scheduled`.slice(0, 191),
      activityType: 'scheduled',
      recordRef: ref,
      actorRef: organizer ? { externalUserId: organizer } : null,
      occurredAt: ev.createdDateTime ?? start ?? new Date().toISOString(),
      summary: `${ev.organizer?.emailAddress?.name ?? organizer ?? 'someone'} scheduled “${ev.subject || '(no title)'}” on Teams`,
    },
  ];
}

async function syncMeetings(ctx, { cursor, phase, since }) {
  if (!meetingsEnabled(ctx.connection)) {
    throw new ProviderError('forbidden', 'Teams meeting scopes not granted', { publicMessage: 'Meetings need Calendars.Read, OnlineMeetings.Read and OnlineMeetingTranscript.Read.All with admin consent; reconnect Teams after granting them.' });
  }
  const api = graphClient(ctx);
  // A calendarView delta keeps the window of its first request. Start a new window when less than
  // half of the look-ahead is left, so meetings scheduled further ahead keep appearing.
  const halfLookahead = (MEETING_LOOKAHEAD_DAYS / 2) * 86_400_000;
  let c = cursor ?? null;
  if (c && !c.next && (!c.windowEnd || Date.parse(c.windowEnd) - Date.now() < halfLookahead)) c = null;
  const from = since ? new Date(since) : new Date(Date.now() - 30 * 86_400_000);
  const to = new Date(Date.now() + MEETING_LOOKAHEAD_DAYS * 86_400_000);
  const windowEnd = c?.windowEnd ?? to.toISOString();
  const page = await deltaPage(api, c, { path: '/v1.0/me/calendarView/delta', query: { startDateTime: from.toISOString(), endDateTime: to.toISOString() } });
  const envelopes = page.items.flatMap((ev) => meetingEnvelopes(tenantInstance(), ev));
  return { envelopes, cursor: { ...page.cursor, windowEnd }, phase: page.done ? 'incremental' : phase, done: page.done };
}

/**
 * The newest transcript of a synced teams_meeting record, as WebVTT.
 * Returns { status: 'ready', transcriptRef, format: 'vtt', content } | { status: 'not_ready' } |
 * { status: 'none', reason }. Throws ProviderError (forbidden = missing consent or not allowed).
 */
async function fetchTranscript(ctx, record) {
  if (!meetingsEnabled(ctx.connection)) {
    throw new ProviderError('forbidden', 'Teams transcript scopes not granted', { publicMessage: 'Teams transcripts need OnlineMeetings.Read and OnlineMeetingTranscript.Read.All with admin consent.' });
  }
  const joinUrl = record.metadata?.joinUrl;
  if (!joinUrl) return { status: 'none', reason: 'The meeting has no Teams join link' };
  const api = graphClient(ctx);
  const found = await api.get('/v1.0/me/onlineMeetings', { query: { $filter: `JoinWebUrl eq '${String(joinUrl).replace(/'/g, "''")}'` } });
  const meeting = found.body?.value?.[0];
  if (!meeting?.id) return { status: 'none', reason: 'Microsoft Graph did not return this meeting for the connected account (it usually must be the organizer)' };
  const base = `/v1.0/me/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`;
  const transcripts = await listAll(api, base, undefined, 5);
  if (!transcripts.length) return { status: 'not_ready' };
  const latest = [...transcripts].sort((a, b) => String(b.createdDateTime ?? '').localeCompare(String(a.createdDateTime ?? '')))[0];
  const res = await api.get(`${base}/${encodeURIComponent(latest.id)}/content`, { query: { $format: 'text/vtt' }, headers: { Accept: 'text/vtt' } });
  const content = typeof res.body === 'string' ? res.body : null;
  if (!content?.trim()) throw new ProviderError('invalid_response', 'Teams transcript content was empty');
  return { status: 'ready', transcriptRef: `${meeting.id}/${latest.id}`.slice(0, 191), format: 'vtt', content };
}

/**
 * Posts a channel message (Graph POST /teams/{id}/channels/{id}/messages, ChannelMessage.Send).
 * Graph has no idempotency key, so `marker` (hidden in the HTML) is looked for in the channel's
 * recent messages first; a retry after an unknown outcome then returns the earlier message.
 * @returns { id, url, existed }
 */
async function sendChannelMessage(ctx, { teamId, channelId, html, marker }) {
  if (!canSendMessages(ctx.connection)) {
    throw new ProviderError('forbidden', 'Teams grant lacks ChannelMessage.Send', { publicMessage: 'Teams messages need TEAMS_MESSAGE_SEND=true and the ChannelMessage.Send permission; connect Teams again.' });
  }
  const api = graphClient(ctx);
  const path = `/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  if (marker) {
    const recent = await api.get(path, { query: { $top: 20 } });
    const found = (recent.body?.value ?? []).find((m) => String(m.body?.content ?? '').includes(marker));
    if (found) return { id: found.id, url: found.webUrl ?? null, existed: true };
  }
  const res = await api.post(path, { body: { contentType: 'html', content: `${html}${marker ? `<span style="display:none">${marker}</span>` : ''}` } });
  return { id: res.body?.id ?? null, url: res.body?.webUrl ?? null, existed: false };
}

export const microsoftTeams = {
  id: 'microsoft_teams',
  displayName: 'Microsoft Teams',
  get sourceInstance() {
    return tenantInstance();
  },
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: true },
  configProblem: microsoftConfigProblem,
  beginConnect: ({ state }) => beginMicrosoftConnect('microsoft_teams', scopesToRequest(), state),
  completeConnect: (ctx, { params }) => completeMicrosoftConnect(ctx, { providerId: 'microsoft_teams', params, scopes: scopesToRequest(), requiredScopes: TEAMS_CHANNEL_SCOPES, label: 'Teams' }),
  // Refresh asks only for what was granted: asking for a scope without consent would fail the refresh.
  refreshCredentials: (ctx) => refreshMicrosoftTokens(ctx, meetingsEnabled(ctx.connection) ? TEAMS_SCOPES : TEAMS_CHANNEL_SCOPES),
  fetchTranscript,
  transcriptRecordTypes: ['teams_meeting'],
  canSendMessages,
  sendChannelMessage,
  async disconnect() {
    // Delegated grants are revoked in Entra (Enterprise applications) or by the user at myaccount.microsoft.com.
  },

  async listResources(ctx) {
    const api = graphClient(ctx);
    const teams = await listAll(api, '/v1.0/me/joinedTeams', { $select: 'id,displayName' });
    const out = [];
    for (const t of teams) {
      const channels = await listAll(api, `/v1.0/teams/${encodeURIComponent(t.id)}/channels`, { $select: 'id,displayName,membershipType,webUrl' });
      for (const ch of channels) {
        out.push({
          resourceType: 'channel',
          externalId: `${t.id}/${ch.id}`.slice(0, 191),
          name: `${t.displayName} / ${ch.displayName}`.slice(0, 255),
          url: ch.webUrl ?? null,
          metadata: { teamId: t.id, channelId: ch.id, team: t.displayName, channel: ch.displayName, membershipType: ch.membershipType ?? 'standard' },
        });
      }
    }
    if (meetingsEnabled(ctx.connection)) {
      const who = ctx.connection.settings?.userPrincipalName ?? 'the connected account';
      out.push({ resourceType: 'meetings', externalId: MEETINGS_RESOURCE_ID, name: `Teams meetings (${who})`.slice(0, 255), url: null, metadata: { kind: 'calendar' } });
    }
    return out;
  },

  async health(ctx) {
    await graphClient(ctx).get('/v1.0/me', { query: { $select: 'id' } });
    return { status: 'healthy' };
  },

  streams: (resource) => (resource?.resourceType === 'meetings' ? ['meetings'] : ['messages']),
  syncStream(ctx, args) {
    if (args.stream === 'messages') return syncMessages(ctx, args);
    if (args.stream === 'meetings') return syncMeetings(ctx, args);
    throw new ProviderError('invalid_request', `Unknown Teams stream ${args.stream}`);
  },
};

export default microsoftTeams;
