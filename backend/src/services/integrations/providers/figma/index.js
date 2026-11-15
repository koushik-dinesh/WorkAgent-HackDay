// Figma connector, OAuth 2.0 (Figma REST API v1, webhooks v2).
//
// One Figma team per deployment (FIGMA_TEAM_ID): the connection's account id is that team, and
// the person who connects must be able to read it. Resources: the team's projects.
// Records per project: design_file (name, last modified, thumbnail, link), its comments and its
// named/autosaved versions (children of the file). Files are revisited only when their
// last_modified moved past the stored watermark. Comments mentioning PAY-42 or acme/api#12 feed
// relationship suggestions.
// Webhooks (optional): registered for the team with FIGMA_WEBHOOK_PASSCODE; Figma puts the
// passcode in every payload (there is no signature header), compared in constant time. Because
// the payload itself is not signed, a webhook is only a nudge: WorkAgent takes the file key from
// it and re-reads the file, its comments and versions (or confirms its deletion) from the API.
// Deleted files are also detected by sync (files that disappear from a project and are gone).
// Tokens: access tokens expire (~90 days) and are refreshed with the refresh token, which Figma
// does not rotate. Figma has no token revocation endpoint (runbook §14).
// Checked against developers.figma.com on 2026-11-15 (docs/integrations/FIGMA_SETUP.md): token
// POST /v1/oauth/token and refresh POST /v1/oauth/refresh with Basic client auth; team ids cannot
// be listed through the API (FIGMA_TEAM_ID); the v1 project endpoints are deprecated in favour of
// v2 folders and are no longer used: folders are listed with GET /v2/teams/:id/folders,
// /v2/folders/:id/folders and /v2/folders/:id/files (folders:read; private OAuth apps only).
// Also read per file: GET /v1/files/:key/meta (creator, last_touched_by/at; needs
// file_metadata:read) for attribution, and every page of the version history (pagination.next_page).
import { timingSafeEqual } from 'node:crypto';
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';

// Exactly the scopes of the endpoints used (developers.figma.com, checked 2026-11-15); the app's
// scope settings in Figma must include every one, or Figma answers "Invalid scopes for app":
//   current_user:read   GET /v1/me
//   file_metadata:read  GET /v1/files/:key/meta
//   file_versions:read  GET /v1/files/:key/versions
//   file_comments:read  GET /v1/files/:key/comments
//   folders:read        GET /v2/teams/:team_id/folders, /v2/folders/:id/folders, /v2/folders/:id/files
// Not requested: file_content:read (GET /v1/files/:key is never called) and projects:read
// (deprecated in favour of folders:read; the v1 project endpoints are no longer used).
export const FIGMA_SCOPES = ['current_user:read', 'file_metadata:read', 'file_versions:read', 'file_comments:read', 'folders:read'];
const FOLDER_DEPTH = 3;
const FILES_PER_CHUNK = 5;
const VERSION_PAGES = 10;
const SOURCE = 'figma.com';
// fileKey -> { projectId, at }: process-local, filled by sync and webhook lookups (10 minutes).
const projectOfFile = new Map();

const fromConfig = () => ({ ...config.figma, appPublicUrl: config.email.appPublicUrl, fetch: undefined });
export const figmaSettings = fromConfig();
export const configureFigma = (o) => Object.assign(figmaSettings, o);
export function resetFigmaSettings() {
  for (const k of Object.keys(figmaSettings)) delete figmaSettings[k];
  Object.assign(figmaSettings, fromConfig());
}

function configProblem() {
  if (!figmaSettings.clientId) return 'FIGMA_CLIENT_ID is not set';
  if (!figmaSettings.clientSecret) return 'FIGMA_CLIENT_SECRET is not set';
  if (!figmaSettings.teamId) return 'FIGMA_TEAM_ID is not set';
  if (!figmaSettings.appPublicUrl && !figmaSettings.redirectUri) return 'FIGMA_REDIRECT_URI (or APP_PUBLIC_URL) is not set (needed for the OAuth redirect)';
  return null;
}

const redirectUri = () => figmaSettings.redirectUri ?? `${figmaSettings.appPublicUrl}/integrations/figma/setup`;
// Figma's token endpoint takes the client credentials as HTTP Basic auth.
const tokenOptions = (path) => ({ tokenUrl: `${figmaSettings.apiUrl}${path}`, fetch: figmaSettings.fetch, format: 'form', clientId: figmaSettings.clientId, clientSecret: figmaSettings.clientSecret, basicAuth: true, providerName: 'Figma' });

function classify({ status, body, rateLimit }) {
  if (status === 429) return new ProviderError('rate_limited', 'Figma rate limit', { status, retryAfterMs: rateLimit.retryAfterMs ?? 60_000 });
  // Figma answers an invalid or expired token with 403 "Invalid token": refresh and retry once.
  if (status === 403 && /token/i.test(String(body?.err ?? body?.message ?? ''))) return new ProviderError('auth', 'Figma token rejected', { status });
  return null;
}
const api = (ctx) => bearerClient(ctx, { baseUrl: figmaSettings.apiUrl, fetch: figmaSettings.fetch, classify, providerName: 'Figma' });

// Folders (formerly "projects"), Figma REST v2. Response bodies of the list endpoints are not
// documented in detail, so both the folders-era and the projects-era field names are accepted.
const folderList = (body) => body?.folders ?? body?.projects ?? [];
const fileList = (body) => body?.files ?? [];
const teamFolders = async (client, teamId) => folderList((await client.get(`/v2/teams/${encodeURIComponent(teamId)}/folders`)).body);
const subFolders = async (client, folderId) => folderList((await client.get(`/v2/folders/${encodeURIComponent(folderId)}/folders`)).body);
const folderFiles = async (client, folderId) => fileList((await client.get(`/v2/folders/${encodeURIComponent(folderId)}/files`)).body);

/** Every folder of the team, with subfolders up to FOLDER_DEPTH levels: [{ id, name, path }]. */
async function allFolders(client, teamId) {
  const out = [];
  const walk = async (folders, prefix, depth) => {
    for (const f of folders) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ id: String(f.id), name: f.name, path });
      if (depth < FOLDER_DEPTH) await walk(await subFolders(client, f.id), path, depth + 1);
    }
  };
  await walk(await teamFolders(client, teamId), '', 1);
  return out;
}

// ---- mapping --------------------------------------------------------------------------------------

const personOf = (u) => (u?.id ? [{ type: 'identity', externalUserId: String(u.id), login: u.handle ?? null, displayName: u.handle ?? null, email: u.email || null, isBot: false }] : []);
const personRef = (u) => (u?.id ? { externalUserId: String(u.id) } : null);
const fileUrl = (key) => `https://www.figma.com/design/${encodeURIComponent(key)}`;

export function fileEnvelopes(file, projectId, meta = null) {
  const ref = { recordType: 'design_file', externalId: file.key };
  return [
    ...(meta ? [...personOf(meta.creator), ...personOf(meta.last_touched_by)] : []),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: fileUrl(file.key),
      title: file.name || 'Untitled',
      body: null,
      state: null,
      statusCategory: 'unknown',
      authorRef: meta ? personRef(meta.creator) : undefined,
      sourceUpdatedAt: file.last_modified ?? null,
      metadata: {
        projectId: projectId ? String(projectId) : null,
        thumbnail: file.thumbnail_url ?? null,
        lastModified: file.last_modified ?? null,
        ...(meta
          ? { creator: meta.creator?.handle ?? null, lastTouchedBy: meta.last_touched_by?.handle ?? null, lastTouchedAt: meta.last_touched_at ?? null, editorType: meta.editorType ?? null, folderName: meta.folder_name ?? null }
          : {}),
      },
    },
    // "Design updated": one event per modification time, attributed to whoever last touched it.
    ...(meta?.last_touched_at
      ? [{ type: 'activity', dedupeKey: `figma:${SOURCE}:file:${file.key}:touched:${meta.last_touched_at}`.slice(0, 191), activityType: 'updated', recordRef: ref, actorRef: personRef(meta.last_touched_by), occurredAt: meta.last_touched_at, summary: `${meta.last_touched_by?.handle ?? 'someone'} updated the design “${file.name || 'Untitled'}” in Figma` }]
      : []),
  ];
}

/** "Design created": the first version of a file (only when the whole history was read). */
export function createdEnvelope(file, firstVersion, meta) {
  if (!firstVersion?.created_at) return [];
  const who = meta?.creator ?? firstVersion.user;
  return [{ type: 'activity', dedupeKey: `figma:${SOURCE}:file:${file.key}:created`, activityType: 'created', recordRef: { recordType: 'design_file', externalId: file.key }, actorRef: personRef(who), occurredAt: firstVersion.created_at, summary: `${who?.handle ?? 'someone'} created the design “${file.name || 'Untitled'}” in Figma` }];
}

export function commentEnvelopes(fileKey, c) {
  const ref = { recordType: 'comment', externalId: String(c.id) };
  return [
    ...personOf(c.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: `${fileUrl(fileKey)}?comment-id=${encodeURIComponent(c.id)}`,
      title: `Comment on a Figma file`,
      body: c.message ?? null,
      state: c.resolved_at ? 'resolved' : 'open',
      statusCategory: c.resolved_at ? 'done' : 'todo',
      authorRef: personRef(c.user),
      parentRef: { recordType: 'design_file', externalId: fileKey },
      sourceCreatedAt: c.created_at ?? null,
      sourceUpdatedAt: c.resolved_at ?? c.created_at ?? null,
      metadata: { replyTo: c.parent_id || null, resolvedAt: c.resolved_at ?? null, reactions: (c.reactions ?? []).map((r) => r.emoji).filter(Boolean).slice(0, 50) },
    },
    { type: 'activity', dedupeKey: `figma:${SOURCE}:comment:${c.id}:created`, activityType: 'commented', recordRef: ref, actorRef: personRef(c.user), occurredAt: c.created_at ?? new Date().toISOString(), summary: c.parent_id ? `${c.user?.handle ?? 'someone'} replied to design feedback in Figma` : `${c.user?.handle ?? 'someone'} gave design feedback in Figma` },
  ];
}

export function versionEnvelopes(fileKey, v) {
  const ref = { recordType: 'version', externalId: `${fileKey}/${v.id}` };
  const label = v.label || 'Autosave';
  return [
    ...personOf(v.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: `${fileUrl(fileKey)}?version-id=${encodeURIComponent(v.id)}`,
      title: label,
      body: v.description || null,
      state: v.label ? 'named' : 'autosave',
      statusCategory: 'unknown',
      authorRef: personRef(v.user),
      parentRef: { recordType: 'design_file', externalId: fileKey },
      sourceCreatedAt: v.created_at ?? null,
      sourceUpdatedAt: v.created_at ?? null,
      metadata: { versionId: String(v.id) },
    },
    // Only named versions are worth a timeline entry; autosaves happen every few minutes.
    ...(v.label ? [{ type: 'activity', dedupeKey: `figma:${SOURCE}:version:${fileKey}/${v.id}`, activityType: 'updated', recordRef: ref, actorRef: personRef(v.user), occurredAt: v.created_at ?? new Date().toISOString(), summary: `${v.user?.handle ?? 'someone'} published the design revision “${label}” in Figma` }] : []),
  ];
}

/** File metadata (creator, last editor), or null when the grant or plan does not allow it. */
async function fileMeta(client, fileKey) {
  try {
    return (await client.get(`/v1/files/${encodeURIComponent(fileKey)}/meta`)).body?.file ?? null;
  } catch (err) {
    if (err instanceof ProviderError && ['forbidden', 'not_found', 'invalid_request'].includes(err.kind)) return null;
    throw err;
  }
}

/** Every page of the version history (Figma's pagination.next_page), up to VERSION_PAGES pages. */
async function allVersions(client, fileKey) {
  const out = [];
  let next = `/v1/files/${encodeURIComponent(fileKey)}/versions`;
  let complete = false;
  for (let i = 0; i < VERSION_PAGES && next; i++) {
    const body = (await client.get(next)).body ?? {};
    out.push(...(body.versions ?? []));
    next = body.pagination?.next_page ?? null;
    if (!next) complete = true;
  }
  return { versions: out, complete };
}

async function fileDetails(client, fileKey, projectId = null) {
  const envelopes = [];
  const meta = await fileMeta(client, fileKey);
  const comments = (await client.get(`/v1/files/${encodeURIComponent(fileKey)}/comments`)).body?.comments ?? [];
  for (const c of comments) envelopes.push(...commentEnvelopes(fileKey, c));
  const { versions, complete } = await allVersions(client, fileKey);
  for (const v of versions) envelopes.push(...versionEnvelopes(fileKey, v));
  if (meta) {
    const file = { key: fileKey, name: meta.name, thumbnail_url: meta.thumbnail_url ?? null, last_modified: meta.last_touched_at ?? null };
    envelopes.unshift(...fileEnvelopes(file, projectId, meta));
    if (complete && versions.length) {
      const first = versions.reduce((a, b) => (String(a.created_at) <= String(b.created_at) ? a : b));
      envelopes.push(...createdEnvelope(file, first, meta));
    }
  }
  return envelopes;
}

/** Whether a file is gone at Figma (its versions endpoint answers 404). */
async function isGone(client, key) {
  try {
    await client.get(`/v1/files/${encodeURIComponent(key)}/versions`, { query: { page_size: 1 } });
    return false;
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') return true;
    throw err;
  }
}

const tombstone = (key) => ({ type: 'record', recordType: 'design_file', externalId: key, title: null, body: null, deleted: true });

async function syncFiles(ctx, { resource, cursor, phase, since }) {
  const client = api(ctx);
  const c = { pending: [], known: [], ...(cursor ?? {}) };
  if (c.pending.length) {
    const batch = c.pending.slice(0, FILES_PER_CHUNK);
    const envelopes = [];
    for (const key of batch) {
      try {
        envelopes.push(...(await fileDetails(client, key, resource.externalId)));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err; // deleted meanwhile
      }
    }
    const pending = c.pending.slice(batch.length);
    if (!pending.length) return { envelopes, cursor: { pending: [], known: c.known, watermark: c.nextWatermark ?? c.watermark ?? null }, phase: 'incremental', done: true };
    return { envelopes, cursor: { ...c, pending }, phase, done: false };
  }
  const files = await folderFiles(client, resource.externalId);
  const listed = new Set(files.map((f) => f.key));
  // The connecting person (with e-mail, only /v1/me returns it), so their activity matches a user.
  const me = ctx.connection.settings?.me;
  for (const key of listed) projectOfFile.set(key, { projectId: String(resource.externalId), at: Date.now() });
  // Files that left the project: deleted ones become tombstones; moved ones are left alone.
  const envelopes = me?.id ? personOf(me) : [];
  for (const key of c.known.filter((k) => !listed.has(k)).slice(0, 20)) if (await isGone(client, key)) envelopes.push(tombstone(key));
  const from = c.watermark ?? (since ? new Date(since).toISOString() : null);
  // Without a modification time in the listing, a file counts as changed (its meta is re-read).
  const changed = files.filter((f) => !from || !f.last_modified || f.last_modified > from);
  envelopes.push(...changed.flatMap((f) => fileEnvelopes(f, resource.externalId)));
  const nextWatermark = changed.reduce((w, f) => (!w || f.last_modified > w ? f.last_modified : w), c.watermark ?? null);
  const pending = changed.map((f) => f.key);
  const known = [...listed].slice(0, 2000);
  if (!pending.length) return { envelopes, cursor: { pending: [], known, watermark: nextWatermark }, phase: 'incremental', done: true };
  return { envelopes, cursor: { pending, known, watermark: c.watermark ?? null, nextWatermark }, phase, done: false };
}

// ---- webhooks -----------------------------------------------------------------------------------

export const FIGMA_EVENTS = ['FILE_UPDATE', 'FILE_VERSION_UPDATE', 'FILE_COMMENT', 'FILE_DELETE', 'PING'];

/** The file's project and its current listing entry, read from the API (cached 10 minutes). */
async function findFile(client, fileKey) {
  const hit = projectOfFile.get(fileKey);
  const lookIn = async (projectId) => (await folderFiles(client, projectId)).find((f) => f.key === fileKey);
  if (hit && Date.now() - hit.at < 600_000) {
    const f = await lookIn(hit.projectId);
    if (f) return { projectId: hit.projectId, file: f };
  }
  const projects = await allFolders(client, figmaSettings.teamId);
  for (const p of projects) {
    const files = await folderFiles(client, p.id);
    for (const f of files) projectOfFile.set(f.key, { projectId: String(p.id), at: Date.now() });
    const f = files.find((x) => x.key === fileKey);
    if (f) return { projectId: String(p.id), file: f };
  }
  return { projectId: hit?.projectId ?? null, file: null };
}

function verifyWebhook({ rawBody }) {
  if (!figmaSettings.webhookPasscode || !Buffer.isBuffer(rawBody)) return false;
  let passcode;
  try {
    passcode = JSON.parse(rawBody.toString('utf8'))?.passcode;
  } catch {
    return false;
  }
  if (typeof passcode !== 'string') return false;
  const a = Buffer.from(passcode);
  const b = Buffer.from(figmaSettings.webhookPasscode);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseWebhook({ body }) {
  if (!FIGMA_EVENTS.includes(body?.event_type) || !body.webhook_id) throw new ProviderError('invalid_request', 'Not a Figma webhook');
  const distinct = body.comment_id ?? body.version_id ?? body.timestamp ?? '';
  return { deliveryId: `${body.webhook_id}:${body.event_type}:${body.file_key ?? ''}:${distinct}`, eventType: body.event_type, action: null, externalAccountId: figmaSettings.teamId ?? null };
}

async function handleWebhook(ctx, delivery) {
  const body = delivery.payload ?? {};
  const key = typeof body.file_key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.file_key) ? body.file_key : null;
  if (body.event_type === 'PING' || !key) return { envelopes: [] };
  const client = api(ctx);
  // Only the file key comes from the (unsigned) payload; everything else is read from Figma.
  const { projectId, file } = await findFile(client, key);
  if (!file) {
    // Not listed any more: if Figma confirms it is gone and its project is known, mark it deleted;
    // otherwise sync handles it (it compares project listings).
    if (projectId && (await isGone(client, key))) return { envelopes: [tombstone(key)], resourceRef: { resourceType: 'project', externalId: projectId } };
    return { envelopes: [] };
  }
  return { envelopes: [...fileEnvelopes(file, projectId), ...(await fileDetails(client, key, projectId))], resourceRef: { resourceType: 'project', externalId: projectId } };
}

// ---- connector ------------------------------------------------------------------------------------

export const figma = {
  id: 'figma',
  displayName: 'Figma',
  sourceInstance: SOURCE,
  capabilities: { install: 'oauth2', webhooks: true, polling: true, credentials: true },
  configProblem,

  beginConnect({ state }) {
    return { redirectUrl: authorizeUrl(`${figmaSettings.authUrl}/oauth`, { clientId: figmaSettings.clientId, redirectUri: redirectUri(), scope: FIGMA_SCOPES.join(' '), state }) };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Figma');
    const { credentials, extra } = await requestTokens(ctx, { ...tokenOptions('/v1/oauth/token'), params: { grant_type: 'authorization_code', code, redirect_uri: redirectUri() } });
    if (!credentials.some((c) => c.kind === 'refresh_token')) throw new ProviderError('invalid_response', 'Figma returned no refresh token');
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const client = ctx.http({ baseUrl: figmaSettings.apiUrl, fetch: figmaSettings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) });
    const me = (await client.get('/v1/me')).body;
    let teamName = null;
    try {
      // Checks that the account can read the team's folders. (The team's name is only available
      // through GET /v1/teams/:id with teams:read, which is not requested; kept if a listing has it.)
      teamName = (await client.get(`/v2/teams/${encodeURIComponent(figmaSettings.teamId)}/folders`)).body?.name ?? null;
    } catch (err) {
      if (err instanceof ProviderError && ['forbidden', 'not_found'].includes(err.kind)) {
        throw new ProviderError('forbidden', 'Figma account cannot read the configured team', { publicMessage: `This Figma account cannot see team ${figmaSettings.teamId}. Connect with a member of that team.` });
      }
      throw err;
    }
    return {
      account: { externalAccountId: String(figmaSettings.teamId), login: me?.handle ?? null, type: 'team', displayName: `Figma · ${teamName ?? `team ${figmaSettings.teamId}`}` },
      settings: {
        teamId: figmaSettings.teamId,
        teamName,
        connectedAs: me?.handle ?? null,
        // user_id_string from the token response (numeric user_id is deprecated) and /v1/me.
        me: { id: String(extra?.user_id_string ?? me?.id ?? ''), handle: me?.handle ?? null, email: me?.email ?? null, imgUrl: me?.img_url ?? null },
        scopes: FIGMA_SCOPES,
        webhooks: Boolean(figmaSettings.webhookPasscode),
      },
      credentials,
    };
  },

  refreshCredentials: (ctx) => refreshTokens(ctx, tokenOptions('/v1/oauth/refresh')),
  async disconnect() {},

  async listResources(ctx) {
    // Resources keep the type 'project' (Figma's former name for folders) so mappings and records stay stable.
    const folders = await allFolders(api(ctx), figmaSettings.teamId);
    return folders.map((p) => ({ resourceType: 'project', externalId: p.id, name: p.path.slice(0, 255), url: `https://www.figma.com/files/project/${p.id}`, metadata: { teamId: figmaSettings.teamId, folder: true } }));
  },

  async health(ctx) {
    await api(ctx).get('/v1/me');
    return { status: 'healthy' };
  },

  streams: () => ['files'],
  syncStream(ctx, args) {
    if (args.stream !== 'files') throw new ProviderError('invalid_request', `Unknown Figma stream ${args.stream}`);
    return syncFiles(ctx, args);
  },

  verifyWebhook,
  parseWebhook,
  handleWebhook,
};

export default figma;
