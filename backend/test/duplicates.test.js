// Feature: duplicate work detection. Normalisation, lexical fallback, embeddings (versioned, no
// mixing), structural evidence, tiers, AI adjudication (WorkAPI STUBBED), notifications, dismissal
// feedback and threshold tuning, linking permissions, on-demand queries, and the Gemini embedding
// adapter through the real SDK against a fake endpoint. MOCKED: no real AI provider is called.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as dup from '../src/services/duplicates/index.js';
import { workapi } from '../src/services/workapi/index.js';
import { configureWorkApi, resetWorkApi } from '../src/services/workapi/providerManager.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const original = { ...workapi };
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body ?? {}),
});
const one = async (sql, params) => (await pool.query(sql, params))[0][0];
let adjudications = 0;

async function record({ provider = 'jira', type = 'issue', key, title, body = '', project = ids.P, metadata = {} }) {
  const [r] = await pool.execute(
    `INSERT INTO external_records (provider, source_instance, record_type, external_id, external_key, connection_id, title, body, status_category, project_id, metadata, content_hash, source_created_at, source_updated_at)
     VALUES (?, 'test', ?, ?, ?, ?, ?, ?, 'todo', ?, ?, REPEAT('a', 64), NOW(3), NOW(3))`,
    [provider, type, key, key, ids.conn, title, body, project, JSON.stringify(metadata)],
  );
  return r.insertId;
}

describe('duplicate work detection', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@d.test', role: 'admin', fullName: 'Ada Admin' });
    ids.mgr = await createUser({ email: 'mgr@d.test', role: 'manager', fullName: 'Max Manager' });
    ids.emp = await createUser({ email: 'emp@d.test', fullName: 'Eve Employee' });
    ids.raj = await createUser({ email: 'raj@d.test', fullName: 'Raj Kumar' });
    for (const k of ['admin', 'mgr', 'emp']) cookies[k] = await loginCookie(app, `${k}@d.test`);
    ids.P = (await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Auth', ?, 'active')", [ids.mgr]))[0].insertId;
    ids.Q = (await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Secret', ?, 'active')", [ids.admin]))[0].insertId;
    await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', [ids.P, ids.emp]);
    ids.conn = (await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status) VALUES ('jira', 'test', 'x', 'Jira', 'active')"))[0].insertId;
    await pool.execute("INSERT INTO external_identities (provider, source_instance, external_user_id, user_id, match_method) VALUES ('jira', 'test', 'acc-eve', ?, 'manual'), ('github', 'test', '77', ?, 'manual')", [ids.emp, ids.raj]);
    ids.jira1 = await record({ key: 'AUTH-1', title: 'OAuth token refresh fails after expiry', body: 'Users are logged out. See src/auth/refresh.js and INC-42.', metadata: { assignees: [{ id: 'acc-eve' }], labels: ['auth'] } });
    ids.pr = await record({ provider: 'github', type: 'pull_request', key: 'acme/web#7', title: 'Fix OAuth token refresh after expiry', body: 'Changes src/auth/refresh.js to retry the refresh token. INC-42', metadata: { assignees: [{ id: '77' }], headRef: 'fix/auth/refresh' } });
    ids.other = await record({ key: 'AUTH-2', title: 'Dark mode colours for the settings page', body: 'Design tweak' });
    ids.secret = await record({ key: 'SEC-1', title: 'OAuth token refresh fails after expiry in admin', body: 'src/auth/refresh.js', project: ids.Q });
    const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, status, created_by, project_id) VALUES ('Auth sync', '', 'approved', ?, ?)", [ids.mgr, ids.P]);
    ids.task = (await pool.execute("INSERT INTO action_items (meeting_id, project_id, title, description, assignee_user_id, review_status, task_status) VALUES (?, ?, 'Fix the OAuth token refresh after expiry', 'Look at src/auth/refresh.js', ?, 'approved', 'todo')", [m.insertId, ids.P, ids.raj]))[0].insertId;
    workapi.isConfigured = () => true;
    workapi.generateJson = async () => {
      adjudications += 1;
      const data = { verdict: 'same', explanation: 'Both fix the refresh token expiry in src/auth/refresh.js for INC-42.' };
      return { text: JSON.stringify(data), data, provider: 'test', model: 'stub', usage: {}, attempts: 1 };
    };
  });
  after(async () => {
    Object.assign(workapi, original);
    resetWorkApi();
    await closeDatabase();
  });

  it('normalises items with structural signals', async () => {
    const items = await dup.loadItems();
    const jira = items.find((i) => i.ref.id === ids.jira1 && i.ref.type === 'external_record');
    assert.deepEqual(jira.files, ['src/auth/refresh.js']);
    assert.deepEqual(jira.incidents, ['INC-42']);
    assert.equal(jira.ownerUserId, ids.emp, 'Jira assignee mapped to the WorkAgent user');
    const pr = items.find((i) => i.ref.id === ids.pr);
    assert.ok(pr.modules.includes('src/auth'));
    const s = dup.structuralEvidence(jira, pr);
    assert.equal(s.strong, true);
    assert.deepEqual(s.evidence.map((e) => e.kind).sort(), ['same_incident', 'same_project', 'shared_files'].sort());
  });

  it('lexical mode (no embeddings): finds the overlap, adjudicates, tiers, and notifies both owners once', async () => {
    const r = await dup.sweep();
    assert.equal(r.method, 'lexical');
    const [rows] = await pool.query('SELECT * FROM duplicate_candidates');
    const pair = rows.find((x) => [x.a_id, x.b_id].includes(ids.jira1) && [x.a_id, x.b_id].includes(ids.pr));
    assert.ok(pair, JSON.stringify(rows.map((x) => [x.a_id, x.b_id, x.similarity])));
    assert.equal(pair.tier, 'high');
    assert.equal(pair.verdict, 'same');
    assert.ok(!rows.some((x) => [x.a_id, x.b_id].includes(ids.other) && x.a_type === 'external_record' && x.b_type === 'external_record'), 'unrelated work is not a candidate');
    const notified = (await pool.query("SELECT user_id FROM notifications WHERE kind = 'duplicate_work'"))[0].map((n) => n.user_id);
    assert.ok(notified.includes(ids.emp) && notified.includes(ids.raj));
    const before = notified.length;
    const calls = adjudications;
    await dup.sweep();
    assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'duplicate_work'"))[0][0].n, before, 'no second alert');
    assert.equal(adjudications, calls, 'a verdict is reused, not asked again');
  });

  it('visibility: a pair shows only when both items are visible; employees cannot link', async () => {
    const empList = (await as('emp').get('/api/v1/duplicates?status=all')).body.candidates;
    assert.ok(empList.length > 0);
    assert.ok(!empList.some((c) => [c.a.id, c.b.id].includes(ids.secret)), 'items of invisible projects never appear');
    const forItem = (await as('emp').get(`/api/v1/duplicates?itemType=external_record&itemId=${ids.jira1}&tier=high`)).body.candidates;
    assert.equal(forItem.length, 1);
    const id = forItem[0].id;
    assert.equal(forItem[0].permissions.canLink, false);
    assert.equal((await as('emp').post(`/api/v1/duplicates/${id}/link`)).status, 403);
    const linked = await as('mgr').post(`/api/v1/duplicates/${id}/link`);
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.candidate.status, 'linked');
    const l = await one("SELECT link_type, origin FROM record_links WHERE link_type = 'duplicates'");
    assert.deepEqual([l.link_type, l.origin], ['duplicates', 'manual']);
  });

  it('“Not a duplicate” is permanent and tunes the thresholds', async () => {
    const list = (await as('mgr').get('/api/v1/duplicates?status=open')).body.candidates;
    const target = list[0];
    const res = await as('mgr').post(`/api/v1/duplicates/${target.id}/dismiss`, { reason: 'Different services' });
    assert.equal(res.body.candidate.status, 'dismissed');
    await dup.sweep();
    assert.equal((await one('SELECT status FROM duplicate_candidates WHERE id = ?', [target.id])).status, 'dismissed', 'a re-run keeps the dismissal');
    await pool.query("UPDATE duplicate_candidates SET status = 'dismissed', tier = 'high'");
    for (let i = 0; i < 5; i++) await pool.execute("INSERT INTO duplicate_candidates (a_type, a_id, b_type, b_id, method, similarity, structural_score, tier, status) VALUES ('action_item', ?, 'action_item', ?, 'lexical', 0.9, 0.5, 'high', 'dismissed')", [900000 + i, 910000 + i]);
    const tuned = await dup.tuneThresholds();
    assert.ok(tuned.adjustment > 0);
    assert.equal((await dup.getSettings()).adjustment, tuned.adjustment);
  });

  it('embedding mode: vectors are versioned and never mixed; a model change re-indexes', async () => {
    await pool.query('DELETE FROM duplicate_candidates');
    await pool.query("DELETE FROM app_settings WHERE setting_key = 'duplicates'");
    const vec = (text) => {
      const t = text.toLowerCase();
      return [t.includes('oauth') ? 1 : 0, t.includes('refresh') ? 1 : 0, t.includes('dark') ? 1 : 0, 0.05];
    };
    let model = 'emb-1';
    workapi.embeddingsConfigured = () => true;
    workapi.embeddingInfo = () => ({ provider: 'gemini', model, dimensions: 4 });
    workapi.embed = async (texts) => ({ vectors: texts.map(vec), provider: 'gemini', model, dimensions: 4, version: `gemini:${model}:4` });
    const r = await dup.sweep();
    assert.equal(r.method, 'embedding');
    assert.ok((await one("SELECT COUNT(*) AS n FROM work_item_embeddings WHERE embedding_version = 'gemini:emb-1:4'")).n > 0);
    const c = await one("SELECT method, embedding_version, tier FROM duplicate_candidates WHERE tier = 'high' LIMIT 1");
    assert.deepEqual([c.method, c.embedding_version], ['embedding', 'gemini:emb-1:4']);
    model = 'emb-2';
    await dup.sweep();
    const versions = (await pool.query('SELECT DISTINCT embedding_version FROM work_item_embeddings'))[0].map((x) => x.embedding_version).sort();
    assert.deepEqual(versions, ['gemini:emb-1:4', 'gemini:emb-2:4'], 'old vectors are kept but not compared');
    const reidx = await as('admin').post('/api/v1/duplicates/reindex');
    assert.ok(reidx.body.removed > 0);
    assert.deepEqual((await pool.query('SELECT DISTINCT embedding_version FROM work_item_embeddings'))[0].map((x) => x.embedding_version), ['gemini:emb-2:4']);
    const q = await as('emp').post('/api/v1/duplicates/query', { text: 'Is anyone fixing the OAuth refresh problem?' });
    assert.equal(q.status, 200);
    assert.equal(q.body.method, 'embedding');
    assert.ok(q.body.results.some((x) => x.item.id === ids.jira1));
    assert.ok(!q.body.results.some((x) => x.item.id === ids.secret));
    Object.assign(workapi, { embeddingsConfigured: original.embeddingsConfigured, embeddingInfo: original.embeddingInfo, embed: original.embed });
  });

  it('WorkAPI embeddings through the real Gemini SDK (fake endpoint): batch, version, key never in errors', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ embeddings: JSON.parse(init.body).requests.map((_, i) => ({ values: [i, 1, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    configureWorkApi({ provider: 'anthropic', apiKey: 'sk-ant-test-key-123456', model: 'claude-test', embedding: { provider: 'gemini', apiKey: 'gemini-test-key-123456', model: 'gemini-embedding-test', dimensions: 3 }, fetch });
    assert.equal(original.embeddingsConfigured(), true, 'embeddings can use Gemini while generation uses Claude');
    const res = await original.embed(['a', 'b'], { purpose: 'test' });
    assert.equal(res.version, 'gemini:gemini-embedding-test:3');
    assert.deepEqual(res.vectors, [[0, 1, 0], [1, 1, 0]]);
    assert.match(calls[0].url, /gemini-embedding-test:batchEmbedContents/);
    assert.equal(calls[0].body.requests[0].outputDimensionality, 3);
    configureWorkApi({ provider: 'anthropic', embedding: { provider: null, apiKey: undefined, model: null } });
    assert.match(original.embeddingProblem(), /no embeddings API|WORKAPI_EMBEDDING_MODEL/);
    resetWorkApi();
  });
});
