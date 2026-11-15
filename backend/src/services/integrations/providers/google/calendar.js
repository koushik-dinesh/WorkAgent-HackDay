// Google Calendar connector (Google Workspace), delegated OAuth 2.0 with offline access.
//
// It replaces the former standalone "Google Meet" connector: Google Meet transcripts now come from
// the Vexa meeting bot (services/vexa/autoTranscribe.js), so this connector only reads calendars.
// Its synced events are what automatic transcription uses to discover Google Meet meetings, and the
// same connection serves free/busy, event creation (opt-in write scope) and directory sync.
//
// Connect: the user signs in with an account of GOOGLE_WORKSPACE_DOMAIN (or, with
// GOOGLE_ALLOW_PERSONAL_ACCOUNTS=true and no domain, any Google account) and grants read-only
// Calendar access; WorkAgent refuses other domains and partial (granular) consent.
// Resources: the account's calendars. Stream per calendar:
//   events       Calendar events that have a Google Meet conference (others are skipped); first run
//                from the backfill window, then Google's sync token (deletions as cancelled events;
//                an expired token (410) restarts from the window)
// Google push (Calendar watch channels) is not implemented: changes arrive with the scheduled sync
// (runbook §13). Google refresh tokens do not rotate.
//
// SSRF: requests go only to the configured token and Calendar origins.
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_SCOPE];
// Optional scopes (opt-in, docs/FEATURES.md): creating/cancelling events with Meet links, and
// reading the Workspace directory (needs a Workspace admin account).
export const GOOGLE_CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const GOOGLE_DIRECTORY_SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.readonly', 'https://www.googleapis.com/auth/admin.directory.group.readonly'];
export const googleScopesToRequest = () => [...GOOGLE_SCOPES, ...(config.features.googleCalendarWrite ? [GOOGLE_CALENDAR_WRITE_SCOPE] : []), ...(config.features.googleDirectorySync ? GOOGLE_DIRECTORY_SCOPES : [])];
export const canWriteGoogleCalendar = (connection) => (connection?.settings?.scopes ?? []).includes(GOOGLE_CALENDAR_WRITE_SCOPE);
export const canReadGoogleDirectory = (connection) => GOOGLE_DIRECTORY_SCOPES.every((s) => (connection?.settings?.scopes ?? []).includes(s));
const PAGE = 100;

const fromConfig = () => ({ directoryUrl: 'https://admin.googleapis.com', ...config.google, appPublicUrl: config.email.appPublicUrl, fetch: undefined });
export const googleSettings = fromConfig();
export const configureGoogle = (o) => Object.assign(googleSettings, o);
export function resetGoogleSettings() {
  for (const k of Object.keys(googleSettings)) delete googleSettings[k];
  Object.assign(googleSettings, fromConfig());
}

function configProblem() {
  if (!googleSettings.clientId) return 'GOOGLE_CLIENT_ID is not set';
  if (!googleSettings.clientSecret) return 'GOOGLE_CLIENT_SECRET is not set';
  if (!googleSettings.domain && !googleSettings.allowPersonal) return 'GOOGLE_WORKSPACE_DOMAIN is not set (or set GOOGLE_ALLOW_PERSONAL_ACCOUNTS=true)';
  if (!googleSettings.appPublicUrl) return 'APP_PUBLIC_URL is not set (needed for the OAuth redirect)';
  return null;
}

const source = () => (googleSettings.domain ? `google:${googleSettings.domain}` : googleSettings.allowPersonal ? 'google:accounts' : 'google.unconfigured');
const redirectUri = () => `${googleSettings.appPublicUrl}/integrations/google_calendar/setup`;
const tokenOptions = () => ({ tokenUrl: googleSettings.tokenUrl, fetch: googleSettings.fetch, format: 'form', clientId: googleSettings.clientId, clientSecret: googleSettings.clientSecret, providerName: 'Google' });

function classify({ status, body, rateLimit }) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(reason))) {
    return new ProviderError('rate_limited', `Google rate limit (${status})`, { status, retryAfterMs: rateLimit.retryAfterMs ?? 60_000 });
  }
  return null;
}

export const calendarApi = (ctx) => bearerClient(ctx, { baseUrl: googleSettings.calendarUrl, fetch: googleSettings.fetch, classify, providerName: 'Google' });
/** Admin SDK Directory API (directory sync; optional scopes). */
export const directoryApi = (ctx) => bearerClient(ctx, { baseUrl: googleSettings.directoryUrl, fetch: googleSettings.fetch, classify, providerName: 'Google' });

// ---- mapping --------------------------------------------------------------------------------------

const meetOf = (ev) => {
  const c = ev.conferenceData;
  if (c?.conferenceSolution?.key?.type !== 'hangoutsMeet') return null;
  return { code: c.conferenceId ?? null, joinUrl: ev.hangoutLink ?? c.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null };
};
const personOf = (p) => (p?.email ? [{ type: 'identity', externalUserId: p.email.toLowerCase(), login: p.email.toLowerCase(), displayName: p.displayName ?? null, email: p.email.toLowerCase(), isBot: false }] : []);
const personRef = (p) => (p?.email ? { externalUserId: p.email.toLowerCase() } : null);
const timeOf = (t) => (t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? new Date(`${t.date}T00:00:00Z`).toISOString() : null);

export function eventEnvelopes(src, calendarId, ev, now = new Date()) {
  const ref = { recordType: 'calendar_event', externalId: `${calendarId}/${ev.id}`.slice(0, 191) };
  if (ev.status === 'cancelled') return [{ type: 'record', ...ref, title: null, body: null, deleted: true }]; // tombstone
  const meet = meetOf(ev);
  if (!meet) return []; // not a Google Meet event
  const end = timeOf(ev.end);
  return [
    ...personOf(ev.organizer),
    {
      type: 'record',
      ...ref,
      externalKey: meet.code,
      url: ev.htmlLink ?? null,
      title: ev.summary || '(no title)',
      body: ev.description ? String(ev.description).replace(/<[^>]+>/g, ' ').slice(0, 2000) : null,
      state: 'scheduled',
      statusCategory: end && new Date(end) < now ? 'done' : 'todo',
      authorRef: personRef(ev.organizer),
      sourceCreatedAt: ev.created ?? null,
      sourceUpdatedAt: ev.updated ?? null,
      metadata: {
        calendarId,
        start: timeOf(ev.start),
        end,
        allDay: Boolean(ev.start?.date && !ev.start?.dateTime),
        meetCode: meet.code,
        joinUrl: meet.joinUrl,
        organizer: ev.organizer?.email?.toLowerCase() ?? null,
        // Attendee e-mails (WorkAgent participants and transcription eligibility), capped.
        attendees: (ev.attendees ?? []).filter((a) => a?.email && !a.resource).slice(0, 200).map((a) => a.email.toLowerCase()),
        attendeeCount: (ev.attendees ?? []).length,
        // The connected account's own answer: a declined meeting is never transcribed.
        selfResponse: (ev.attendees ?? []).find((a) => a?.self)?.responseStatus ?? null,
        recurring: Boolean(ev.recurringEventId),
      },
    },
    { type: 'activity', dedupeKey: `google_calendar:${src}:event:${ev.id}:scheduled`.slice(0, 191), activityType: 'scheduled', recordRef: ref, actorRef: personRef(ev.organizer), occurredAt: ev.created ?? timeOf(ev.start) ?? new Date().toISOString(), summary: `${ev.organizer?.displayName ?? ev.organizer?.email ?? 'someone'} scheduled “${ev.summary || '(no title)'}” (Google Meet)` },
  ];
}

// ---- sync ---------------------------------------------------------------------------------------

async function syncEvents(ctx, { resource, cursor, phase, since }) {
  const api = calendarApi(ctx);
  const path = `/calendar/v3/calendars/${encodeURIComponent(resource.externalId)}/events`;
  const c = cursor ?? {};
  const base = { maxResults: PAGE, showDeleted: true, singleEvents: true };
  const firstQuery = () => ({ ...base, timeMin: (since ? new Date(since) : new Date(Date.now() - 30 * 86_400_000)).toISOString() });
  let query = c.pageToken ? { ...(c.syncToken ? { ...base, syncToken: c.syncToken } : firstQuery()), pageToken: c.pageToken } : c.syncToken ? { ...base, syncToken: c.syncToken } : firstQuery();
  let res;
  try {
    res = await api.get(path, { query });
  } catch (err) {
    // 410: the sync token expired; start again from the window.
    if (err instanceof ProviderError && err.status === 410) {
      query = firstQuery();
      res = await api.get(path, { query });
    } else throw err;
  }
  const items = res.body?.items ?? [];
  const envelopes = items.flatMap((ev) => eventEnvelopes(source(), resource.externalId, ev));
  if (res.body?.nextPageToken) return { envelopes, cursor: { syncToken: query.syncToken ?? null, pageToken: res.body.nextPageToken }, phase, done: false };
  return { envelopes, cursor: { syncToken: res.body?.nextSyncToken ?? c.syncToken ?? null, pageToken: null }, phase: 'incremental', done: true };
}

// ---- connector ------------------------------------------------------------------------------------

export const googleCalendar = {
  id: 'google_calendar',
  displayName: 'Google Calendar',
  get sourceInstance() {
    return source();
  },
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: true },
  configProblem,

  beginConnect({ state }) {
    return {
      redirectUrl: authorizeUrl(`${googleSettings.authUrl}/o/oauth2/v2/auth`, {
        clientId: googleSettings.clientId,
        redirectUri: redirectUri(),
        scope: googleScopesToRequest().join(' '),
        state,
        extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', ...(googleSettings.domain ? { hd: googleSettings.domain } : {}) },
      }),
    };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Google');
    const { credentials, scope } = await requestTokens(ctx, { ...tokenOptions(), params: { grant_type: 'authorization_code', code, redirect_uri: redirectUri() } });
    const granted = (scope ?? '').split(/\s+/).filter(Boolean);
    const missing = [CALENDAR_SCOPE].filter((s) => !granted.includes(s));
    if (missing.length) {
      throw new ProviderError('forbidden', 'Google grant is missing scopes', { publicMessage: 'Google access was only partly granted. Connect again and allow read access to Google Calendar.' });
    }
    if (!credentials.some((c) => c.kind === 'refresh_token')) {
      throw new ProviderError('invalid_response', 'Google returned no refresh token', { publicMessage: 'Google did not grant offline access; connect again.' });
    }
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const primary = (await ctx.http({ baseUrl: googleSettings.calendarUrl, fetch: googleSettings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) }).get('/calendar/v3/calendars/primary')).body;
    const email = String(primary?.id ?? '').toLowerCase();
    if (googleSettings.domain ? !email.endsWith(`@${googleSettings.domain}`) : !email.includes('@')) {
      throw new ProviderError('forbidden', 'Google account outside the Workspace domain', {
        publicMessage: googleSettings.domain ? `Only accounts of ${googleSettings.domain} can be connected.` : 'The Google account has no usable email address.',
      });
    }
    return {
      account: { externalAccountId: email, login: email, type: 'user', displayName: `Google Calendar · ${email}` },
      settings: { domain: googleSettings.domain ?? null, scopes: granted, timeZone: primary.timeZone ?? null, webhooks: false },
      credentials,
    };
  },

  refreshCredentials: (ctx) => refreshTokens(ctx, tokenOptions()),

  async disconnect(ctx) {
    // Google supports revoking the grant: best effort, the stored tokens are deleted regardless.
    const token = await ctx.credentials.peek('refresh_token');
    if (!token) return;
    const url = new URL(googleSettings.tokenUrl);
    await ctx.http({ baseUrl: url.origin, fetch: googleSettings.fetch }).postForm('/revoke', { token }).catch(() => {});
  },

  async listResources(ctx) {
    const api = calendarApi(ctx);
    const out = [];
    let pageToken;
    for (let i = 0; i < 20; i++) {
      const res = await api.get('/calendar/v3/users/me/calendarList', { query: { maxResults: 250, pageToken } });
      for (const cal of res.body?.items ?? []) {
        out.push({ resourceType: 'calendar', externalId: cal.id, name: `Calendar: ${cal.summaryOverride ?? cal.summary ?? cal.id}`.slice(0, 255), metadata: { primary: Boolean(cal.primary), accessRole: cal.accessRole ?? null, timeZone: cal.timeZone ?? null } });
      }
      pageToken = res.body?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },

  async health(ctx) {
    await calendarApi(ctx).get('/calendar/v3/calendars/primary');
    return { status: 'healthy' };
  },

  streams: () => ['events'],
  syncStream(ctx, args) {
    if (args.stream === 'events') return syncEvents(ctx, args);
    throw new ProviderError('invalid_request', `Unknown Google Calendar stream ${args.stream}`);
  },
};

export default googleCalendar;
