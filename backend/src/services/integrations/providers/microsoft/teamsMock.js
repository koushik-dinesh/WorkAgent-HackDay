// Microsoft Teams DEVELOPMENT MOCK connector (TEAMS_INTEGRATION_MODE=mock; refused in production).
//
// Same provider id and contract as the real Teams connector (teams.js), so every downstream part of
// WorkAgent — resources, the sync engine, ingest, the work graph, identities, transcript import,
// WorkAPI extraction, review — runs unchanged. The only difference is where data comes from: the
// fictional Violin Technologies fixture (../../mock/violinFixture.js) instead of Microsoft Graph.
// Graph-shaped objects are built from the fixture and passed through the real Teams mappers.
//
// It never calls Microsoft, stores no credentials, and is always labelled: the connection's
// display name says "Development mock", settings.mode = 'mock', and every record carries
// metadata.isMock = true under its own source instance (microsoft.mock-violin-technologies), so mock
// records can never be confused or mixed with records of a real tenant.
import { ProviderError } from '../../errors.js';
import { EMPLOYEES, MEETINGS, MESSAGES, MOCK_ACCOUNT, ORGANISATION, TEAMS, byId, channelKey, meetingVtt } from '../../mock/violinFixture.js';
import { TEAMS_SCOPES, meetingEnvelopes, messageEnvelopes } from './teams.js';
import { config } from '../../../../config/index.js';
import { pool } from '../../../../db/pool.js';

export const MOCK_SOURCE = 'microsoft.mock-violin-technologies';
export const MOCK_ACCOUNT_ID = 'mock-demo-user';
const MEETINGS_RESOURCE_ID = 'me/meetings';
const DAY = 86_400_000;

/** Midnight UTC of the day before `now`: every fixture meeting is then in the past. */
export const anchorFor = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY).toISOString();
const anchorOf = (ctx) => ctx.connection?.settings?.anchor ?? anchorFor();
const at = (anchor, day, hhmm, plusMinutes = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(anchor) + day * DAY + (h * 60 + m + plusMinutes) * 60_000).toISOString();
};

const teamId = (key) => `mock-team-${key}`;
const channelId = (team, channel) => `mock-ch-${channelKey(team, channel).replace(':', '-')}`;
const user = (id) => ({ user: { id: byId(id).aadId, displayName: byId(id).name } });
// Identities with e-mail (Graph messages carry none), so authors match WorkAgent users by e-mail.
const identityFor = (id) => ({ type: 'identity', externalUserId: byId(id).aadId, login: byId(id).name, displayName: byId(id).name, email: byId(id).email, isBot: false });

/** Marks mock envelopes and replaces the e-mail-less identities with full ones. */
function mark(envelopes, authorId, reactions = []) {
  return [
    identityFor(authorId),
    ...envelopes
      .filter((e) => e.type !== 'identity')
      .map((e) => (e.type === 'record' ? { ...e, metadata: { ...(e.metadata ?? {}), isMock: true, organisation: ORGANISATION, ...(reactions.length ? { reactions } : {}) } } : e)),
  ];
}

function graphMessage(anchor, msg, reply = null) {
  const created = reply ? at(anchor, msg.day, msg.at, reply.minutes) : at(anchor, msg.day, msg.at);
  const author = reply ? reply.author : msg.author;
  return {
    id: reply ? reply.id : msg.id,
    messageType: 'message',
    subject: reply ? null : msg.subject,
    body: { contentType: 'text', content: reply ? reply.body : msg.body },
    from: user(author),
    createdDateTime: created,
    lastModifiedDateTime: created,
    webUrl: `https://teams.example.com/mock/${teamId(msg.team)}/${channelId(msg.team, msg.channel)}/${reply ? reply.id : msg.id}`,
  };
}

function graphEvent(anchor, m) {
  const start = at(anchor, m.day, m.at);
  const end = at(anchor, m.day, m.at, m.minutes);
  const org = byId(m.organizer);
  return {
    id: m.id,
    subject: m.title,
    bodyPreview: `${m.title} — ${TEAMS.find((t) => t.key === m.team).name}`,
    start: { dateTime: start.replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: end.replace('Z', ''), timeZone: 'UTC' },
    organizer: { emailAddress: { address: org.email, name: org.name } },
    attendees: m.attendees.map((id) => ({ emailAddress: { address: byId(id).email, name: byId(id).name } })),
    isCancelled: false,
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    onlineMeeting: { joinUrl: `https://teams.example.com/l/meetup-join/${m.id}` },
    webLink: `https://teams.example.com/mock/calendar/${m.id}`,
    createdDateTime: at(anchor, m.day - 3, '09:00'),
    lastModifiedDateTime: at(anchor, m.day - 3, '09:00'),
  };
}

export const teamsMock = {
  id: 'microsoft_teams',
  displayName: 'Microsoft Teams (development mock)',
  sourceInstance: MOCK_SOURCE,
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: false },
  configProblem: () => (config.isProd ? 'The Teams development mock is not available in production' : null),

  // No Microsoft sign-in: straight back to WorkAgent's setup page, with the usual single-use state.
  beginConnect({ state }) {
    const base = config.email.appPublicUrl ?? 'http://localhost:5173';
    return { redirectUrl: `${base}/integrations/microsoft_teams/setup?code=mock&state=${encodeURIComponent(state)}` };
  },
  async completeConnect(ctx, { params }) {
    if (params?.code !== 'mock') throw new ProviderError('invalid_request', 'Not a mock connection request', { publicMessage: 'This server runs the Teams development mock; start the connection from the Integrations page.' });
    return {
      account: { externalAccountId: MOCK_ACCOUNT_ID, login: MOCK_ACCOUNT, type: 'user', displayName: `Microsoft Teams · Development mock (${ORGANISATION})` },
      settings: { mode: 'mock', mock: true, organisation: ORGANISATION, account: MOCK_ACCOUNT, anchor: anchorFor(), scopes: TEAMS_SCOPES, verified: false },
      credentials: [],
    };
  },
  async disconnect() {},

  async listResources() {
    const out = [];
    for (const t of TEAMS) {
      for (const ch of t.channels) {
        out.push({ resourceType: 'channel', externalId: `${teamId(t.key)}/${channelId(t.key, ch)}`, name: `${t.name} / ${ch}`, url: null, metadata: { teamId: teamId(t.key), channelId: channelId(t.key, ch), team: t.name, channel: ch, membershipType: 'standard', isMock: true, teamKey: t.key, project: t.project } });
      }
    }
    out.push({ resourceType: 'meetings', externalId: MEETINGS_RESOURCE_ID, name: `Teams meetings (${MOCK_ACCOUNT})`, url: null, metadata: { kind: 'calendar', isMock: true } });
    return out;
  },

  async health() {
    return { status: 'healthy', detail: 'Development mock (no Microsoft connection)' };
  },

  // DEVELOPMENT MOCK: "sending" records the message in mock_records (outbox); Microsoft is never called.
  canSendMessages: () => true,
  async sendChannelMessage(ctx, { teamId, channelId, html, marker, executionId }) {
    const key = `outbox:${marker ?? `${teamId}/${channelId}/${Date.now()}`}`.slice(0, 191);
    const [[found]] = await pool.query("SELECT id FROM mock_records WHERE source = 'teams_mock' AND natural_key = ?", [key]);
    if (found) return { id: `mock-${found.id}`, url: null, existed: true, mock: true };
    const [r] = await pool.execute("INSERT INTO mock_records (source, entity_type, entity_id, natural_key, metadata) VALUES ('teams_mock', 'outbound_message', ?, ?, ?)", [executionId ?? 0, key, JSON.stringify({ teamId, channelId, html, sentAt: new Date().toISOString(), isMock: true })]);
    return { id: `mock-${r.insertId}`, url: null, existed: false, mock: true };
  },

  streams: (resource) => (resource?.resourceType === 'meetings' ? ['meetings'] : ['messages']),
  async syncStream(ctx, { resource, stream }) {
    const anchor = anchorOf(ctx);
    if (stream === 'meetings') {
      const envelopes = MEETINGS.flatMap((m) => mark(meetingEnvelopes(MOCK_SOURCE, graphEvent(anchor, m)), m.organizer).map((e) => (e.type === 'record' ? { ...e, metadata: { ...e.metadata, team: TEAMS.find((t) => t.key === m.team).name, mockMeetingKey: m.key } } : e)));
      // Organizer identities are keyed by e-mail in the real mapper; add the attendees too.
      const people = new Set(MEETINGS.flatMap((m) => [m.organizer, ...m.attendees]));
      const extra = [...people].map((id) => ({ type: 'identity', externalUserId: byId(id).email, login: byId(id).email, displayName: byId(id).name, email: byId(id).email, isBot: false }));
      return { envelopes: [...extra, ...envelopes], cursor: { seeded: true }, phase: 'incremental', done: true };
    }
    if (stream === 'messages') {
      const [tid, cid] = resource.externalId.split('/');
      const posts = MESSAGES.filter((m) => teamId(m.team) === tid && channelId(m.team, m.channel) === cid);
      const envelopes = [];
      for (const post of posts) {
        envelopes.push(...mark(messageEnvelopes(MOCK_SOURCE, cid, graphMessage(anchor, post)), post.author, post.reactions));
        for (const r of post.replies) envelopes.push(...mark(messageEnvelopes(MOCK_SOURCE, cid, graphMessage(anchor, post, r), post.id), r.author));
      }
      return { envelopes, cursor: { seeded: true }, phase: 'incremental', done: true };
    }
    throw new ProviderError('invalid_request', `Unknown Teams stream ${stream}`);
  },

  // The fixture transcript of a mock meeting, through the normal transcript import.
  async fetchTranscript(ctx, record) {
    const m = MEETINGS.find((x) => x.id === record.externalId);
    if (!m) return { status: 'none', reason: 'Not a mock meeting' };
    return { status: 'ready', transcriptRef: `mock-transcript-${m.key}`, format: 'vtt', content: meetingVtt(m) };
  },
  transcriptRecordTypes: ['teams_meeting'],
};

export { EMPLOYEES };
export default teamsMock;
