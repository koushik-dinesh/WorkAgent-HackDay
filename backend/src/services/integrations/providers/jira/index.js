// Jira Cloud connector, implementing the Phase 3A contract with an OAuth 2.0 (3LO) app.
//
// Connect: the admin consents on Atlassian (scopes read:jira-work read:jira-user offline_access, plus
// write:jira-work when JIRA_ISSUE_CREATION=true, used only by createIssue for approved action items);
// (write:jira-work is also used by confirmed assistant commands: create, update and undo, docs/FEATURES.md)
// the setup page posts the code back; completeConnect exchanges it and checks that the grant covers
// the configured site (JIRA_SITE_URL). One site per deployment: the connection's account id is the
// site host and its cloud id is kept in settings.
// Tokens: access tokens last 1 h; refresh tokens rotate on every refresh (stored with the new
// access token). Atlassian has no revocation endpoint for 3LO grants: disconnecting deletes the
// stored tokens, and an admin removes the app from their Atlassian account settings.
// Sync: one stream per project, JQL ordered by `updated`, resumable by page token. Webhooks: an
// admin-registered Jira webhook signed with JIRA_WEBHOOK_SECRET (X-Hub-Signature: sha256=...).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';
import { commentEnvelopes, issueEnvelopes, resourceOf, userRef } from './mappers.js';
import { jiraConfigProblem, settings, sourceInstanceOf } from './settings.js';

export const READ_SCOPES = 'read:jira-work read:jira-user offline_access';
export const WRITE_SCOPE = 'write:jira-work';
/** Scopes asked for on Connect: write only when JIRA_ISSUE_CREATION is on (the Atlassian app must list it). */
export const scopesToRequest = () => (settings.issueCreation ? `read:jira-work ${WRITE_SCOPE} read:jira-user offline_access` : READ_SCOPES);
/** Whether a connection's grant allows creating issues (older connections were read-only). */
export const canWrite = (connection) => (connection?.settings?.scopes ?? []).includes(WRITE_SCOPE);
export const itemLabel = (itemId) => `workagent-item-${itemId}`;
export const STREAMS = ['issues'];
const PAGE_SIZE = 50;
const COMMENTS_PER_CHUNK = 5;
const OVERLAP_MS = 5 * 60 * 1000;
const ISSUE_FIELDS = 'summary,status,assignee,reporter,creator,priority,issuetype,created,updated,duedate,labels,description,parent,subtasks,issuelinks,resolution,resolutiondate,comment,project';

const source = () => sourceInstanceOf(settings.siteUrl);
const tokenOptions = () => ({ tokenUrl: `${settings.authUrl}/oauth/token`, fetch: settings.fetch, format: 'json', clientId: settings.clientId, clientSecret: settings.clientSecret, providerName: 'Jira' });
const cloudIdOf = (ctx) => {
  const id = ctx.connection.settings?.cloudId;
  if (!id || !/^[0-9a-f-]{8,64}$/i.test(id)) throw new ProviderError('auth', 'Jira connection has no cloud id', { publicMessage: 'Connect Jira again' });
  return id;
};

/** Jira REST v3 for the connected site, through api.atlassian.com. */
function jiraApi(ctx) {
  const client = bearerClient(ctx, { baseUrl: settings.apiUrl, fetch: settings.fetch, providerName: 'Jira' });
  const base = `/ex/jira/${cloudIdOf(ctx)}/rest/api/3`;
  return {
    get: (path, opts) => client.get(`${base}${path}`, opts),
    post: (path, body, opts) => client.post(`${base}${path}`, body, opts),
    // Assistant commands (update an issue, undo a create).
    put: (path, body, opts) => client.request('PUT', `${base}${path}`, { ...opts, body }),
    delete: (path, opts) => client.request('DELETE', `${base}${path}`, opts),
  };
}

/** "yyyy-MM-dd HH:mm" in the API user's time zone, which is how JQL reads dates. */
export function jqlTime(date, timeZone = 'UTC') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const quoteJql = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

async function syncIssues(ctx, { resource, cursor, phase, since }) {
  const api = jiraApi(ctx);
  let c = cursor ?? { pass: phase === 'backfill' ? 'open' : 'recent', pageToken: null, pendingComments: [] };
  c = { pendingComments: [], ...c };
  const site = settings.siteUrl;

  // Issues with more comments than the search returned: fetch the rest, a few per chunk.
  if (c.pendingComments.length) {
    const batch = c.pendingComments.slice(0, COMMENTS_PER_CHUNK);
    const envelopes = [];
    for (const { id, key } of batch) {
      try {
        let startAt = 0;
        for (let page = 0; page < 20; page++) {
          const res = await api.get(`/issue/${encodeURIComponent(id)}/comment`, { query: { startAt, maxResults: 100 } });
          for (const cm of res.body?.comments ?? []) envelopes.push(...commentEnvelopes(source(), site, { id, key }, cm));
          startAt += res.body?.comments?.length ?? 0;
          if (!res.body?.comments?.length || startAt >= (res.body?.total ?? 0)) break;
        }
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err; // deleted meanwhile
      }
    }
    const pendingComments = c.pendingComments.slice(batch.length);
    if (!pendingComments.length && c.listed) return { envelopes, ...finish(c) };
    return { envelopes, cursor: { ...c, pendingComments }, phase, done: false };
  }

  if (!c.timeZone) c = { ...c, timeZone: (await api.get('/myself')).body?.timeZone || 'UTC' };
  if (c.pass === 'recent' && !c.pageToken && !c.runSince) {
    const start = c.watermark ? new Date(Date.parse(c.watermark) - OVERLAP_MS) : since ? new Date(since) : null;
    c = { ...c, runSince: start ? start.toISOString() : null };
  }
  const project = `project = ${quoteJql(resource.metadata?.key ?? resource.name)}`;
  const jql =
    c.pass === 'open'
      ? `${project} AND statusCategory != Done ORDER BY updated ASC`
      : `${project}${c.runSince ? ` AND updated >= ${quoteJql(jqlTime(c.runSince, c.timeZone))}` : ''} ORDER BY updated ASC`;
  const res = await api.get('/search/jql', { query: { jql, fields: ISSUE_FIELDS, maxResults: PAGE_SIZE, nextPageToken: c.pageToken ?? undefined } });
  const issues = res.body?.issues ?? [];
  const envelopes = issues.flatMap((i) => issueEnvelopes(source(), site, i));
  const more = issues.filter((i) => (i.fields?.comment?.total ?? 0) > (i.fields?.comment?.comments?.length ?? 0)).map((i) => ({ id: String(i.id), key: i.key }));
  const pendingComments = [...c.pendingComments, ...more.filter((m) => !c.pendingComments.some((p) => p.id === m.id))];
  const nextWatermark = issues.reduce((w, i) => maxIso(w, i.fields?.updated ? new Date(i.fields.updated).toISOString() : null), c.nextWatermark ?? null);

  if (res.body?.nextPageToken && !res.body?.isLast) return { envelopes, cursor: { ...c, pageToken: res.body.nextPageToken, pendingComments, nextWatermark }, phase, done: false };
  if (c.pass === 'open') {
    const start = since ? new Date(since).toISOString() : null;
    return { envelopes, cursor: { ...c, pass: 'recent', pageToken: null, runSince: start, pendingComments, nextWatermark }, phase, done: false };
  }
  if (pendingComments.length) return { envelopes, cursor: { ...c, pageToken: null, pendingComments, nextWatermark, listed: true }, phase, done: false };
  return { envelopes, ...finish({ ...c, nextWatermark }) };
}

function finish(c) {
  return {
    cursor: { pass: 'recent', pageToken: null, runSince: null, pendingComments: [], timeZone: c.timeZone, watermark: maxIso(c.watermark, c.nextWatermark) ?? null, nextWatermark: null },
    phase: 'incremental',
    done: true,
  };
}

// ---- issue creation (approved action items) ------------------------------------------------------

const PRIORITY_NOTE = { high: 'High', medium: 'Medium', low: 'Low' };
const paragraph = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

/** Atlassian Document Format body: the item's description plus where it came from. */
export function issueDescription(item) {
  const lines = [
    ...(item.description ? String(item.description).split(/\n+/).filter(Boolean).slice(0, 50) : []),
    `Priority in WorkAgent: ${PRIORITY_NOTE[item.priority] ?? item.priority ?? 'Medium'}`,
    ...(item.meetingTitle ? [`From the meeting “${item.meetingTitle}”${item.meetingDate ? ` (${item.meetingDate})` : ''}.`] : []),
    ...(item.assigneeName && !item.assigneeAccountId ? [`Owner in WorkAgent: ${item.assigneeName} (no linked Jira account, so the issue is unassigned).`] : []),
    ...(item.requestedBy ? [`Requested by ${item.requestedBy} through the WorkAgent assistant.`] : [`Created by WorkAgent from approved action item #${item.id}.`]),
  ];
  return { type: 'doc', version: 1, content: lines.map((l) => paragraph(l.slice(0, 3000))) };
}

async function issueTypeFor(api, projectKey) {
  const res = await api.get(`/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`, { query: { maxResults: 50 } });
  const types = res.body?.issueTypes ?? res.body?.values ?? [];
  const usable = types.filter((t) => !t.subtask);
  const pick = usable.find((t) => /^task$/i.test(t.name)) ?? usable[0];
  if (!pick?.id) throw new ProviderError('invalid_request', `No issue type available in ${projectKey}`, { publicMessage: `Jira project ${projectKey} has no issue type WorkAgent can create` });
  return pick;
}

/**
 * Creates (or finds again) the Jira issue for an approved action item in the resource's project.
 * Idempotent: the issue carries the label workagent-item-<id>; an existing one is returned instead
 * of creating a second. The assignee is set only from a mapped Jira account; when Jira refuses it
 * the issue is created unassigned.
 * @param item { id, title, description, priority, dueDate: 'YYYY-MM-DD'|null, assigneeAccountId, assigneeName, meetingTitle, meetingDate }
 * @returns { externalId, key, url, assigneeSet, existed, envelopes }
 */
async function createIssue(ctx, { resource, item }) {
  if (!canWrite(ctx.connection)) {
    throw new ProviderError('forbidden', 'Jira grant lacks write:jira-work', { publicMessage: 'This Jira connection can only read. Turn on JIRA_ISSUE_CREATION, add write:jira-work to the Atlassian app, then connect Jira again.' });
  }
  const api = jiraApi(ctx);
  const projectKey = resource.metadata?.key;
  if (!projectKey) throw new ProviderError('invalid_request', 'Jira project resource without a key');
  // Assistant commands pass their own label (workagent-command-<id>) for the same idempotency.
  const label = item.label ?? itemLabel(item.id);
  const site = settings.siteUrl;

  const found = await api.get('/search/jql', { query: { jql: `project = ${quoteJql(projectKey)} AND labels = ${quoteJql(label)} ORDER BY created ASC`, fields: ISSUE_FIELDS, maxResults: 1 } });
  let issue = found.body?.issues?.[0] ?? null;
  let existed = Boolean(issue);
  let assigneeSet = issue ? Boolean(issue.fields?.assignee) : false;

  if (!issue) {
    const type = await issueTypeFor(api, projectKey);
    const fields = {
      project: { key: projectKey },
      issuetype: { id: type.id },
      summary: String(item.title).replace(/\s+/g, ' ').trim().slice(0, 254),
      description: issueDescription(item),
      labels: ['workagent', label],
      ...(item.dueDate ? { duedate: item.dueDate } : {}),
      ...(item.assigneeAccountId ? { assignee: { accountId: item.assigneeAccountId } } : {}),
      ...(item.jiraPriority ? { priority: { name: item.jiraPriority } } : {}),
    };
    let res = await api.post('/issue', { fields }, { okStatuses: [400] });
    if (res.status === 400 && fields.priority && res.body?.errors?.priority) {
      delete fields.priority; // priority not on this project's screen or scheme
      res = await api.post('/issue', { fields }, { okStatuses: [400] });
    }
    if (res.status === 400 && fields.assignee && res.body?.errors?.assignee) {
      // The mapped person cannot be assigned in this project: create it unassigned instead.
      const { assignee, ...rest } = fields;
      res = await api.post('/issue', { fields: rest }, { okStatuses: [400] });
    } else if (res.status === 400 && fields.duedate && res.body?.errors?.duedate) {
      const { duedate, ...rest } = fields; // due date field not on this project's screen
      res = await api.post('/issue', { fields: rest }, { okStatuses: [400] });
    }
    if (res.status === 400 || !res.body?.id) {
      const fieldsWithErrors = Object.keys(res.body?.errors ?? {}).join(', ');
      throw new ProviderError('invalid_request', `Jira refused the issue${fieldsWithErrors ? ` (fields: ${fieldsWithErrors})` : ''}`, { publicMessage: `Jira refused the issue${fieldsWithErrors ? ` because of: ${fieldsWithErrors}` : ''}` });
    }
    issue = (await api.get(`/issue/${encodeURIComponent(res.body.id)}`, { query: { fields: ISSUE_FIELDS } })).body;
    assigneeSet = Boolean(issue?.fields?.assignee);
    existed = false;
  }
  if (!issue?.id || !issue.key) throw new ProviderError('invalid_response', 'Jira returned no issue');
  return {
    externalId: String(issue.id),
    key: issue.key,
    url: `${site}/browse/${encodeURIComponent(issue.key)}`,
    assigneeSet,
    existed,
    envelopes: issueEnvelopes(source(), site, issue, { withComments: false }),
  };
}

// ---- assistant commands: permission checks, updates, undo ---------------------------------------

/**
 * Whether a Jira account holds a project permission (CREATE_ISSUES, EDIT_ISSUES, ASSIGN_ISSUES,
 * DELETE_ISSUES). Used so a command only does what the requesting person could do in Jira.
 */
async function userHasPermission(ctx, { accountId, projectKey, permission }) {
  const res = await jiraApi(ctx).get('/user/permission/search', { query: { permissions: permission, projectKey, accountId, maxResults: 50 } });
  return (res.body ?? []).some((u) => u.accountId === accountId);
}

/** Current values of the fields an update can change (for undo). */
async function issueFields(ctx, key) {
  const res = await jiraApi(ctx).get(`/issue/${encodeURIComponent(key)}`, { query: { fields: 'summary,priority,duedate,assignee,project,status' } });
  const f = res.body?.fields ?? {};
  return { key: res.body?.key, id: res.body?.id, projectKey: f.project?.key ?? null, summary: f.summary ?? null, priority: f.priority?.name ?? null, dueDate: f.duedate ?? null, assigneeAccountId: f.assignee?.accountId ?? null, status: f.status?.name ?? null };
}

/**
 * Updates an issue's summary/priority/due date/assignee. `changes` uses null to clear.
 * @returns { envelopes } the issue after the change (to ingest)
 */
async function updateIssue(ctx, { key, changes }) {
  if (!canWrite(ctx.connection)) throw new ProviderError('forbidden', 'Jira grant lacks write:jira-work', { publicMessage: 'This Jira connection can only read.' });
  const api = jiraApi(ctx);
  const fields = {};
  if ('summary' in changes) fields.summary = String(changes.summary).slice(0, 254);
  if ('priority' in changes) fields.priority = changes.priority ? { name: changes.priority } : null;
  if ('dueDate' in changes) fields.duedate = changes.dueDate;
  if ('assigneeAccountId' in changes) fields.assignee = changes.assigneeAccountId ? { accountId: changes.assigneeAccountId } : null;
  const res = await api.put(`/issue/${encodeURIComponent(key)}`, { fields }, { okStatuses: [400] });
  if (res.status === 400) {
    const bad = Object.keys(res.body?.errors ?? {}).join(', ');
    throw new ProviderError('invalid_request', `Jira refused the update (${bad})`, { publicMessage: `Jira refused the change${bad ? ` to: ${bad}` : ''}` });
  }
  const issue = (await api.get(`/issue/${encodeURIComponent(key)}`, { query: { fields: ISSUE_FIELDS } })).body;
  return { envelopes: issueEnvelopes(source(), settings.siteUrl, issue, { withComments: false }) };
}

/** Deletes an issue (undo of an assistant create, within the undo window). */
async function deleteIssue(ctx, { key }) {
  await jiraApi(ctx).delete(`/issue/${encodeURIComponent(key)}`);
}

// ---- comments, transitions, links (execution engine, services/execution) -----------------------

const requireWrite = (ctx) => {
  if (!canWrite(ctx.connection)) throw new ProviderError('forbidden', 'Jira grant lacks write:jira-work', { publicMessage: 'This Jira connection can only read. Turn on JIRA_ISSUE_CREATION, add write:jira-work, then connect Jira again.' });
};

/**
 * Adds a comment (POST /rest/api/3/issue/{key}/comment, ADF body). Idempotent through `marker`:
 * a comment whose text contains it already is returned instead of posting a second one.
 * @returns { id, existed }
 */
async function addComment(ctx, { key, text, marker }) {
  requireWrite(ctx);
  const api = jiraApi(ctx);
  const path = `/issue/${encodeURIComponent(key)}/comment`;
  if (marker) {
    const existing = await api.get(path, { query: { maxResults: 100, orderBy: '-created' } });
    const found = (existing.body?.comments ?? []).find((c) => JSON.stringify(c.body ?? '').includes(marker));
    if (found) return { id: String(found.id), existed: true };
  }
  const lines = [...String(text).split(/\n+/).filter(Boolean).slice(0, 60), ...(marker ? [marker] : [])];
  const res = await api.post(path, { body: { type: 'doc', version: 1, content: lines.map((l) => paragraph(l.slice(0, 3000))) } });
  return { id: String(res.body?.id ?? ''), existed: false };
}

/** Moves an issue to the transition whose target status is `statusName` (case-insensitive). */
async function transitionIssue(ctx, { key, statusName }) {
  requireWrite(ctx);
  const api = jiraApi(ctx);
  const res = await api.get(`/issue/${encodeURIComponent(key)}/transitions`);
  const t = (res.body?.transitions ?? []).find((x) => String(x.to?.name ?? x.name).toLowerCase() === String(statusName).toLowerCase());
  if (!t) throw new ProviderError('invalid_request', `No transition to ${statusName}`, { publicMessage: `Jira offers no transition from the issue's current status to “${statusName}” (or you may not perform it)` });
  await api.post(`/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
  return { transitionId: t.id, status: t.to?.name ?? statusName };
}

/** Links two issues (POST /rest/api/3/issueLink), unless they are linked already. */
async function linkIssues(ctx, { fromKey, toKey, linkType = 'Relates' }) {
  requireWrite(ctx);
  const api = jiraApi(ctx);
  const issue = (await api.get(`/issue/${encodeURIComponent(fromKey)}`, { query: { fields: 'issuelinks' } })).body;
  const already = (issue?.fields?.issuelinks ?? []).some((l) => [l.inwardIssue?.key, l.outwardIssue?.key].includes(toKey));
  if (already) return { existed: true };
  await api.post('/issueLink', { type: { name: linkType }, inwardIssue: { key: fromKey }, outwardIssue: { key: toKey } });
  return { existed: false };
}

// ---- webhooks ---------------------------------------------------------------------------------

export const SUPPORTED_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'comment_updated', 'comment_deleted'];

const header = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : null;
  return Array.isArray(v) ? v[0] : v;
};

export const signatureFor = (secret, rawBody) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

function verifyWebhook({ headers, rawBody }) {
  if (!settings.webhookSecret || !Buffer.isBuffer(rawBody)) return false; // polling only without a secret
  const given = header(headers, 'x-hub-signature');
  if (typeof given !== 'string' || !given.startsWith('sha256=')) return false;
  const expected = Buffer.from(signatureFor(settings.webhookSecret, rawBody));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseWebhook({ headers, body }) {
  const deliveryId = header(headers, 'x-atlassian-webhook-identifier');
  const eventType = body?.webhookEvent;
  if (!deliveryId || typeof eventType !== 'string') throw new ProviderError('invalid_request', 'Jira webhook without identifier or event');
  // Jira webhooks come from the configured site; the connection's account id is that site's host.
  return { deliveryId: String(deliveryId), eventType, action: body.issue_event_type_name ?? null, externalAccountId: source() };
}

function handleWebhook(delivery) {
  const body = delivery.payload ?? {};
  const issue = body.issue;
  if (!SUPPORTED_EVENTS.includes(delivery.eventType) || !issue?.id) return { envelopes: [] };
  const projectId = issue.fields?.project?.id;
  const resourceRef = projectId ? { resourceType: 'project', externalId: String(projectId) } : undefined;
  const site = settings.siteUrl;
  const src = source();
  let envelopes;
  switch (delivery.eventType) {
    case 'jira:issue_created':
    case 'jira:issue_updated': {
      envelopes = issueEnvelopes(src, site, issue, { withComments: false });
      // Assignment changes carry their own event (status changes are derived by ingest).
      for (const item of body.changelog?.items ?? []) {
        if (item.field === 'assignee' && body.changelog.id) {
          envelopes.push({
            type: 'activity',
            dedupeKey: `jira:${src}:changelog:${body.changelog.id}:assignee`,
            activityType: item.to ? 'assigned' : 'unassigned',
            recordRef: { recordType: 'issue', externalId: String(issue.id) },
            actorRef: userRef(body.user),
            occurredAt: new Date(body.timestamp ?? Date.now()).toISOString(),
            summary: item.to ? `${body.user?.displayName ?? 'someone'} assigned ${issue.key} to ${item.toString ?? 'someone'}` : `${body.user?.displayName ?? 'someone'} unassigned ${issue.key}`,
          });
        }
      }
      break;
    }
    case 'jira:issue_deleted':
      envelopes = issueEnvelopes(src, site, issue, { withComments: false }).map((e) => (e.type === 'record' ? { ...e, deleted: true } : e));
      break;
    case 'comment_created':
    case 'comment_updated':
    case 'comment_deleted':
      if (!body.comment?.id) return { envelopes: [] };
      envelopes = commentEnvelopes(src, site, issue, body.comment).map((e) => (e.type === 'record' && delivery.eventType === 'comment_deleted' ? { ...e, deleted: true } : e));
      break;
    default:
      envelopes = [];
  }
  return { envelopes, resourceRef };
}

// ---- connector --------------------------------------------------------------------------------

export const jira = {
  id: 'jira',
  displayName: 'Jira',
  get sourceInstance() {
    return source();
  },
  capabilities: { install: 'oauth2', webhooks: true, polling: true, credentials: true },

  configProblem: jiraConfigProblem,

  beginConnect({ state }) {
    return {
      redirectUrl: authorizeUrl(`${settings.authUrl}/authorize`, {
        clientId: settings.clientId,
        redirectUri: settings.redirectUri,
        scope: scopesToRequest(),
        state,
        extra: { audience: 'api.atlassian.com', prompt: 'consent' },
      }),
    };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Jira');
    const { credentials } = await requestTokens(ctx, { ...tokenOptions(), params: { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri } });
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const res = await ctx
      .http({ baseUrl: settings.apiUrl, fetch: settings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) })
      .get('/oauth/token/accessible-resources');
    const site = (res.body ?? []).find((r) => String(r.url ?? '').replace(/\/+$/, '') === settings.siteUrl);
    if (!site) {
      throw new ProviderError('forbidden', 'Jira grant does not include the configured site', {
        publicMessage: `Access was granted, but not to ${settings.siteUrl}. Connect again and choose that site on the Atlassian consent screen.`,
      });
    }
    if (!(site.scopes ?? []).includes('read:jira-work')) {
      throw new ProviderError('forbidden', 'Jira grant lacks read:jira-work', { publicMessage: 'WorkAgent needs permission to read Jira work items; connect again and accept all requested permissions.' });
    }
    if (!credentials.some((c) => c.kind === 'refresh_token')) {
      throw new ProviderError('invalid_response', 'Jira returned no refresh token', { publicMessage: 'Jira did not grant offline access; connect again and accept all requested permissions.' });
    }
    return {
      account: { externalAccountId: source(), login: site.name ?? null, type: 'site', displayName: `Jira · ${site.name ?? source()}` },
      settings: { cloudId: site.id, siteUrl: settings.siteUrl, siteName: site.name ?? null, scopes: site.scopes ?? [], webhooks: Boolean(settings.webhookSecret) },
      credentials,
    };
  },

  refreshCredentials(ctx) {
    return refreshTokens(ctx, tokenOptions());
  },

  async disconnect() {
    // Nothing to call: 3LO grants are revoked by the user at id.atlassian.com (runbook §11).
  },

  async listResources(ctx) {
    const api = jiraApi(ctx);
    const out = [];
    let startAt = 0;
    for (let page = 0; page < 100; page++) {
      const res = await api.get('/project/search', { query: { startAt, maxResults: 50, orderBy: 'key' } });
      const values = res.body?.values ?? [];
      out.push(...values.map((p) => resourceOf(settings.siteUrl, p)));
      startAt += values.length;
      if (res.body?.isLast !== false || !values.length) break;
    }
    return out;
  },

  async health(ctx) {
    await jiraApi(ctx).get('/myself');
    return { status: 'healthy' };
  },

  streams: () => STREAMS,

  syncStream(ctx, args) {
    if (args.stream !== 'issues') throw new ProviderError('invalid_request', `Unknown Jira stream ${args.stream}`);
    return syncIssues(ctx, args);
  },

  createIssue,
  updateIssue,
  deleteIssue,
  issueFields,
  addComment,
  transitionIssue,
  linkIssues,
  userHasPermission,

  verifyWebhook,
  parseWebhook,

  async handleWebhook(_ctx, delivery) {
    return handleWebhook(delivery);
  },
};

export default jira;
