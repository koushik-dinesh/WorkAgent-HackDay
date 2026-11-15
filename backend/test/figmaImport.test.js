// Figma OAuth and import, against a fake Figma on 127.0.0.1 (MOCKED: no real Figma account):
// authorization URL (scopes, state, redirect), state validation, token handling (user_id_string,
// Basic auth, refresh on "Invalid token"), file metadata attribution, paginated version history,
// comments and replies with reactions, work-graph events (design created/updated, feedback,
// revision published), person matching by e-mail, Jira-key correlation, 429 handling, the
// dashboard states (not configured / connected / syncing / disconnected) and disconnect.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import { ProviderError } from '../src/services/integrations/errors.js';
import { configureFigma, figmaSettings, resetFigmaSettings } from '../src/services/integrations/providers/figma/index.js';
import { registry } from '../src/services/integrations/registry.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { CLIENT_ID, CLIENT_SECRET, TEAM_ID, file, project, startFakeFigma } from './integrations/fakeFigma.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let fake;
let cookie;
const ids = {};
const as = { get: (u) => request(app).get(u).set('Cookie', cookie), post: (u, b) => request(app).post(u).set('Cookie', cookie).send(b ?? {}), patch: (u, b) => request(app).patch(u).set('Cookie', cookie).send(b) };
const card = async () => (await as.get('/api/v1/integrations/overview')).body.cards.find((c) => c.provider === 'figma');
const one = async (sql, p) => (await pool.query(sql, p))[0][0];

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

describe('Figma OAuth and import', () => {
  before(async () => {
    await resetDatabase();
    fake = await startFakeFigma();
    ids.admin = await createUser({ email: 'admin@fig.test', role: 'admin', fullName: 'Fig Admin' });
    ids.ada = await createUser({ email: 'ada@acme.test', fullName: 'Ada Lovelace' });
    cookie = await loginCookie(app, 'admin@fig.test');
    ids.P = (await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Checkout', ?, 'active')", [ids.admin]))[0].insertId;
    const p = project(fake.state, { id: 601, name: 'Checkout design' });
    project(fake.state, { id: 602, name: 'Specs', parent: 601 });
    // 7 versions in pages of 3 (pagination.next_page), a comment thread with a reply and reactions.
    fake.state.versionPageSize = 3;
    file(p, {
      key: 'KEYcart',
      name: 'Cart and checkout',
      modified: ago(1),
      creator: { id: 'fig-user-1', handle: 'ada' },
      lastTouchedBy: { id: 'u9', handle: 'lucas' },
      comments: [
        { id: 'c1', message: 'The total jumps when PAY-77 lands, please check', user: { id: 'u9', handle: 'lucas' }, created_at: ago(1), resolved_at: null, parent_id: '', reactions: [{ emoji: ':eyes:', user: { id: 'fig-user-1' }, created_at: ago(1) }] },
        { id: 'c2', message: 'Fixed in v3', user: { id: 'fig-user-1', handle: 'ada' }, created_at: ago(0.5), resolved_at: null, parent_id: 'c1' },
      ],
      versions: Array.from({ length: 7 }, (_, i) => ({ id: String(7000 + 7 - i), label: i === 0 ? 'Ready for dev' : '', description: '', created_at: ago(1 + i), user: { id: 'fig-user-1', handle: 'ada' } })),
    });
  });
  after(async () => {
    resetFigmaSettings();
    await fake.close();
    await closeDatabase();
  });

  it('shows a configuration-required state naming what is missing', async () => {
    resetFigmaSettings();
    const c = await card();
    assert.equal(c.state, 'not_configured');
    assert.match(c.problem, /FIGMA_CLIENT_ID/);
    assert.equal(c.setupDoc, 'docs/integrations/FIGMA_SETUP.md');
    assert.equal((await as.post('/api/v1/integrations/figma/connect')).status, 503);
  });

  it('starts OAuth with the documented URL, scopes, state and the configured redirect URI', async () => {
    configureFigma({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, teamId: TEAM_ID, authUrl: fake.url, apiUrl: fake.url, appPublicUrl: 'http://localhost:5173', redirectUri: 'http://localhost:5173/integrations/figma/setup' });
    assert.equal((await card()).state, 'disconnected');
    const res = await as.post('/api/v1/integrations/figma/connect');
    const url = new URL(res.body.redirectUrl);
    assert.equal(url.pathname, '/oauth');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/integrations/figma/setup');
    // Exactly the scopes of the endpoints used; no deprecated (files:read, file_read, projects:read)
    // or unused (file_content:read) scope.
    assert.equal(url.searchParams.get('scope'), 'current_user:read file_metadata:read file_versions:read file_comments:read folders:read');
    // Figma accepts it when the app has these scopes selected (the fake mirrors Figma's check)...
    const ok = await fetch(url, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    // ...and answers exactly the reported error when a requested scope is not on the app.
    fake.state.appScopes = ['current_user:read', 'file_metadata:read', 'file_versions:read', 'file_comments:read'];
    const refused = await fetch(url, { redirect: 'manual' });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: true, status: 400, message: 'Invalid scopes for app' });
    fake.state.appScopes = ['current_user:read', 'file_metadata:read', 'file_versions:read', 'file_comments:read', 'folders:read'];
    assert.ok(url.searchParams.get('state').length >= 40);
    ids.state = url.searchParams.get('state');
  });

  it('refuses a forged or reused state, then completes with Basic-auth token exchange', async () => {
    const forged = await as.post('/api/v1/integrations/figma/callback', { state: 'x'.repeat(43), params: { code: fake.grantCode() } });
    assert.equal(forged.body.error.code, 'INVALID_STATE');
    const ok = await as.post('/api/v1/integrations/figma/callback', { state: ids.state, params: { code: fake.grantCode() } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ids.conn = ok.body.connection.id;
    assert.equal(ok.body.connection.settings.me.id, 'fig-user-1', 'user_id_string from the token response');
    assert.equal(ok.body.connection.settings.teamName, null, 'team names need teams:read, which is not requested');
    assert.equal(ok.body.connection.displayName, `Figma · team ${TEAM_ID}`);
    assert.deepEqual(ok.body.resources.map((r) => r.name).sort(), ['Checkout design', 'Checkout design / Specs'], 'folders and subfolders via v2');
    assert.ok(!fake.state.calls.some((c) => /^GET \/v1\/(teams|projects)\//.test(c.sig)), 'no deprecated v1 project endpoints');
    const reused = await as.post('/api/v1/integrations/figma/callback', { state: ids.state, params: { code: fake.grantCode() } });
    assert.equal(reused.body.error.code, 'INVALID_STATE');
    // Tokens are stored encrypted, never returned.
    assert.ok(!JSON.stringify(ok.body).includes('figd_'));
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM integration_credentials WHERE connection_id = ?', [ids.conn])).n), 2);
  });

  it('imports files with metadata, every page of versions, comments, replies and reactions', async () => {
    const res = (await as.get(`/api/v1/integrations/${ids.conn}/resources`)).body.resources.find((r) => r.name === 'Checkout design');
    await as.patch(`/api/v1/integrations/${ids.conn}/resources/${res.id}`, { isEnabled: true, projectId: ids.P });
    ids.res = res.id;
    // A 429 with Retry-After on the first file listing: the sync is rescheduled, not failed.
    fake.state.failNext.push({ match: /GET \/v2\/folders\/601\/files/, status: 429, headers: { 'retry-after': '7' } });
    await assert.rejects(syncEngine.syncResource(res.id), (err) => err instanceof queue.RescheduleJob && err.delayMs >= 5000 && err.delayMs <= 7000);
    await pool.execute('UPDATE integration_connections SET paused_until = NULL WHERE id = ?', [ids.conn]);
    await syncAll(res.id);
    const counts = Object.fromEntries((await pool.query("SELECT record_type, COUNT(*) AS n FROM external_records WHERE provider = 'figma' GROUP BY record_type"))[0].map((r) => [r.record_type, Number(r.n)]));
    assert.deepEqual(counts, { comment: 2, design_file: 1, version: 7 });
    assert.equal(fake.state.calls.filter((c) => c.sig === 'GET /v1/files/KEYcart/versions').length, 3, 'three pages of versions');
    const f = await one("SELECT title, metadata, project_id, author_identity_id FROM external_records WHERE external_id = 'KEYcart'");
    const meta = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
    assert.deepEqual([meta.creator, meta.lastTouchedBy, f.project_id], ['ada', 'lucas', ids.P]);
    const reply = await one("SELECT metadata, body FROM external_records WHERE external_id = 'c2'");
    assert.equal((typeof reply.metadata === 'string' ? JSON.parse(reply.metadata) : reply.metadata).replyTo, 'c1');
    const c1 = await one("SELECT metadata FROM external_records WHERE external_id = 'c1'");
    assert.deepEqual((typeof c1.metadata === 'string' ? JSON.parse(c1.metadata) : c1.metadata).reactions, [':eyes:']);
  });

  it('puts design events in the work graph with source ids, times and attribution', async () => {
    const acts = (await pool.query("SELECT a.activity_type, a.summary, i.user_id AS actor_user_id, a.occurred_at FROM activities a LEFT JOIN external_identities i ON i.id = a.actor_identity_id WHERE a.provider = 'figma' ORDER BY a.occurred_at"))[0];
    const types = acts.map((a) => a.activity_type);
    assert.ok(types.includes('created'), 'design created (full history read)');
    assert.ok(acts.some((a) => a.activity_type === 'updated' && /updated the design/.test(a.summary)));
    assert.ok(acts.some((a) => /published the design revision “Ready for dev”/.test(a.summary)));
    assert.ok(acts.some((a) => /gave design feedback/.test(a.summary)));
    assert.ok(acts.some((a) => /replied to design feedback/.test(a.summary)));
    const created = acts.find((a) => a.activity_type === 'created');
    assert.equal(created.actor_user_id, ids.ada, 'the creator is matched to the WorkAgent user by the e-mail /v1/me returned');
    const id = await one("SELECT user_id, match_method, email FROM external_identities WHERE provider = 'figma' AND external_user_id = 'fig-user-1'");
    assert.deepEqual([id.user_id, id.match_method], [ids.ada, 'email']);
    // The comment that mentions PAY-77 is searchable text for Jira correlation (Phase 5 matchers).
    const rec = await one("SELECT body FROM external_records WHERE external_id = 'c1'");
    assert.match(rec.body, /PAY-77/);
  });

  it('shows the connected card with account, team, projects, files and last sync; syncing while queued', async () => {
    let c = await card();
    assert.equal(c.state, 'connected');
    assert.equal(c.figma.account, 'ada@acme.test');
    assert.deepEqual(c.figma.teams, [{ id: TEAM_ID, name: `Team ${TEAM_ID}` }]);
    assert.equal(c.figma.files, 1);
    assert.equal(c.figma.comments, 2);
    assert.equal(c.figma.versions, 7);
    assert.ok(c.connection.lastSyncSucceededAt);
    const sync = await as.post(`/api/v1/integrations/${ids.conn}/sync`);
    assert.ok([200, 202].includes(sync.status));
    c = await card();
    assert.equal(c.state, 'syncing');
    await pool.query("DELETE FROM jobs WHERE type = 'integration.sync'");
  });

  it('refreshes an expired access token with the refresh token', async () => {
    fake.state.access.clear(); // every access token now answers 403 "Invalid token"
    await pool.execute('UPDATE integration_resources SET next_sync_at = NULL WHERE id = ?', [ids.res]);
    await syncAll(ids.res);
    assert.ok(fake.state.calls.some((c) => c.sig === 'POST /v1/oauth/refresh'));
  });

  it('disconnects: credentials deleted, data kept, card disconnected', async () => {
    const res = await as.post(`/api/v1/integrations/${ids.conn}/disconnect`, {});
    assert.equal(res.status, 200);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM integration_credentials WHERE connection_id = ?', [ids.conn])).n), 0);
    assert.equal((await card()).state, 'disconnected');
    assert.equal(Number((await one("SELECT COUNT(*) AS n FROM external_records WHERE provider = 'figma'")).n), 10);
    assert.ok(registry.get('figma'));
    assert.ok(figmaSettings.clientId);
    assert.ok(new ProviderError('rate_limited', 'x', { retryAfterMs: 1 }));
  });
});
