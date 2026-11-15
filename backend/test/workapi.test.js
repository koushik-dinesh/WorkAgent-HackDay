// WorkAPI: provider-independent AI layer (services/workapi/).
//
// MOCKED, NOT LIVE. The real provider SDKs (@google/genai, @anthropic-ai/sdk) run unmodified, but
// their HTTP goes to an in-process fake `fetch` that answers like the Gemini API and the Anthropic
// Messages API (JSON, SSE streams, error bodies). These tests prove WorkAgent's request shapes,
// response normalization, error mapping, retries and provider switching; they do not prove that
// a real model answers well. A live smoke test is a separate, manual step (docs/WORKAPI.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import { PermanentJobError } from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import * as meetings from '../src/repositories/meetingsRepository.js';
import * as transcripts from '../src/repositories/transcriptsRepository.js';
import { buildSystemPrompt } from '../src/services/ai/extractionPrompt.js';
import { OUTPUT_SCHEMA } from '../src/services/ai/schema.js';
import { requestExtraction } from '../src/services/extraction.js';
import { parseTranscript, renderFullText } from '../src/services/transcripts/parser.js';
import { WorkApiError, workapi } from '../src/services/workapi/index.js';
import { configureWorkApi, resetWorkApi } from '../src/services/workapi/providerManager.js';
import { retryDelay, withRetry } from '../src/services/workapi/retry.js';
import { setLogLevelForTests } from '../src/utils/logger.js';
import { closeDatabase, createUser, resetDatabase } from './helpers.js';

const GEMINI_KEY = 'AIzaFAKE-test-key-0123456789abcdefghij';
const ANTHROPIC_KEY = 'sk-ant-FAKE-test-key-0123456789abcdef';
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

// ---- fake transports --------------------------------------------------------------------------

let calls = [];
let queue = []; // responses for the next requests, consumed in order

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function geminiOk(text, { finishReason = 'STOP', usage = { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 50, totalTokenCount: 1550 }, blockReason } = {}) {
  return json(200, {
    candidates: blockReason ? [] : [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
    ...(blockReason ? { promptFeedback: { blockReason } } : {}),
    usageMetadata: usage,
    modelVersion: 'gemini-test-model-001',
  });
}
const geminiError = (status, statusText, message, details) => json(status, { error: { code: status, message, status: statusText, ...(details ? { details } : {}) } });

function anthropicStream(text, { stopReason = 'end_turn', model = 'claude-test-model' } = {}) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 120 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const anthropicError = (status, type, message, headers = {}) => json(status, { type: 'error', error: { type, message } }, headers);

async function fakeFetch(url, init = {}) {
  const u = String(url instanceof Request ? url.url : url);
  const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
  const bodyText = init.body ? String(init.body) : null;
  calls.push({ url: u, method: init.method ?? 'GET', headers, body: bodyText ? JSON.parse(bodyText) : null });
  const next = queue.shift();
  if (!next) throw new Error(`fake fetch: no response queued for ${u}`);
  if (typeof next === 'function') return next(init);
  return next;
}

const gemini = (o = {}) => configureWorkApi({ provider: 'gemini', apiKey: GEMINI_KEY, model: 'gemini-test-model', baseUrl: undefined, timeoutMs: 2000, maxRetries: 2, providerOptions: {}, fetch: fakeFetch, ...o });
const anthropic = (o = {}) => configureWorkApi({ provider: 'anthropic', apiKey: ANTHROPIC_KEY, model: 'claude-test-model', baseUrl: undefined, timeoutMs: 2000, maxRetries: 2, providerOptions: {}, fetch: fakeFetch, ...o });
const request = () => workapi.generateJson({ system: 'Return {"ok":true}.', user: 'Hello', schema: SCHEMA, purpose: 'test' });

beforeEach(() => {
  calls = [];
  queue = [];
});
after(resetWorkApi);

// ---- configuration ------------------------------------------------------------------------------

describe('WorkAPI configuration (startup validation)', () => {
  const start = (env) =>
    spawnSync(process.execPath, ['-e', "import('./src/services/workapi/index.js').then(() => { console.log('CONFIG_OK'); process.exit(0); })"], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, NODE_ENV: 'development', ...env },
      encoding: 'utf8',
    });

  it('accepts a provider, key and model', () => {
    const r = start({ WORKAPI_PROVIDER: 'gemini', WORKAPI_API_KEY: GEMINI_KEY, WORKAPI_MODEL: 'gemini-x' });
    assert.match(r.stdout, /CONFIG_OK/, r.stderr);
  });

  it('treats empty values (WORKAPI_API_KEY=) as unset: AI is simply not configured', () => {
    const r = start({ WORKAPI_PROVIDER: 'gemini', WORKAPI_API_KEY: '', WORKAPI_MODEL: '', WORKAPI_BASE_URL: '', WORKAPI_PROVIDER_OPTIONS: '' });
    assert.match(r.stdout, /CONFIG_OK/, r.stderr);
  });

  it('refuses a key without a provider or model, and never prints the key', () => {
    const r = start({ WORKAPI_PROVIDER: '', WORKAPI_API_KEY: GEMINI_KEY, WORKAPI_MODEL: '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WORKAPI_PROVIDER/);
    assert.match(r.stderr, /WORKAPI_MODEL/);
    assert.ok(!r.stderr.includes(GEMINI_KEY) && !r.stdout.includes(GEMINI_KEY));
  });

  it('refuses an unsupported provider and invalid provider options', () => {
    assert.match(start({ WORKAPI_PROVIDER: 'openai', WORKAPI_API_KEY: GEMINI_KEY, WORKAPI_MODEL: 'x' }).stderr, /WORKAPI_PROVIDER/);
    assert.match(start({ WORKAPI_PROVIDER: 'gemini', WORKAPI_PROVIDER_OPTIONS: 'not json' }).stderr, /WORKAPI_PROVIDER_OPTIONS/);
    const r = start({ WORKAPI_PROVIDER: 'gemini', WORKAPI_API_KEY: GEMINI_KEY, WORKAPI_MODEL: 'x', WORKAPI_PROVIDER_OPTIONS: '{"effort":"high"}' });
    assert.notEqual(r.status, 0, 'anthropic-only option refused for gemini at startup');
    assert.match(r.stderr, /WORKAPI_PROVIDER_OPTIONS is invalid for provider "gemini"/);
  });

  it('is not configured without a key: requests fail permanently with a clear message', async () => {
    configureWorkApi({ provider: 'gemini', apiKey: undefined, model: 'gemini-test-model' });
    assert.equal(workapi.isConfigured(), false);
    await assert.rejects(request(), (e) => e instanceof PermanentJobError && /WORKAPI_API_KEY/.test(e.message));
  });
});

// ---- Gemini adapter -------------------------------------------------------------------------------

describe('Gemini adapter (real @google/genai SDK, fake transport)', () => {
  beforeEach(() => gemini());

  it('sends system prompt, user turn and JSON schema; normalizes the response and usage', async () => {
    queue.push(geminiOk('{"ok":true}'));
    const r = await request();
    assert.deepEqual(r.data, { ok: true });
    assert.deepEqual([r.provider, r.model, r.finishReason, r.attempts], ['gemini', 'gemini-test-model-001', 'STOP', 1]);
    assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 350, thinkingTokens: 50 }, 'thinking tokens count as output');
    const [c] = calls;
    assert.match(c.url, /\/models\/gemini-test-model:generateContent$/);
    assert.equal(c.headers.get('x-goog-api-key'), GEMINI_KEY);
    assert.deepEqual(c.body.systemInstruction.parts, [{ text: 'Return {"ok":true}.' }]);
    assert.deepEqual(c.body.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }]);
    assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(c.body.generationConfig.responseJsonSchema, SCHEMA);
    assert.equal(c.body.generationConfig.maxOutputTokens, 32000);
  });

  it('passes provider options (temperature, thinking) only from WORKAPI_PROVIDER_OPTIONS', async () => {
    gemini({ providerOptions: { temperature: 0.2, thinkingLevel: 'LOW' } });
    queue.push(geminiOk('{"ok":true}'));
    await request();
    assert.equal(calls[0].body.generationConfig.temperature, 0.2);
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.throws(() => gemini({ providerOptions: { effort: 'high' } }), /invalid for provider "gemini"/);
  });

  it('maps an invalid or expired key to auth (not retried) without leaking the key', async () => {
    queue.push(geminiError(400, 'INVALID_ARGUMENT', `API key not valid. Please pass a valid API key. key=${GEMINI_KEY}`, [{ reason: 'API_KEY_INVALID' }]));
    await assert.rejects(request(), (e) => e instanceof WorkApiError && e.kind === 'auth' && e.retryable === false && !e.message.includes(GEMINI_KEY));
    assert.equal(calls.length, 1);
  });

  it('maps an unknown model to model_not_found, at request time and in verify()', async () => {
    queue.push(geminiError(404, 'NOT_FOUND', 'models/gemini-test-model is not found for API version v1beta'));
    await assert.rejects(request(), (e) => e.kind === 'model_not_found' && /gemini-test-model/.test(e.publicMessage));
    queue.push(geminiError(404, 'NOT_FOUND', 'not found'));
    await assert.rejects(workapi.verify(), (e) => e.kind === 'model_not_found');
    queue.push(json(200, { name: 'models/gemini-test-model', displayName: 'Test' }));
    assert.deepEqual(await workapi.verify(), { provider: 'gemini', model: 'gemini-test-model' });
  });

  it('retries a rate limit after the provider’s retryDelay, then succeeds', async () => {
    queue.push(geminiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }]));
    queue.push(geminiOk('{"ok":true}'));
    const r = await request();
    assert.equal(r.attempts, 2);
  });

  it('does not wait inline for long rate-limit delays (the job queue retries later)', async () => {
    queue.push(geminiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }]));
    await assert.rejects(request(), (e) => e.kind === 'rate_limited' && e.retryable && e.retryAfterMs === 120_000 && e.attempts === 1);
  });

  it('retries outages up to WORKAPI_MAX_RETRIES, then gives up as retryable', async () => {
    gemini({ maxRetries: 1 });
    queue.push(geminiError(503, 'UNAVAILABLE', 'The model is overloaded'), geminiError(503, 'UNAVAILABLE', 'The model is overloaded'));
    await assert.rejects(request(), (e) => e.kind === 'unavailable' && e.retryable && e.attempts === 2);
    assert.equal(calls.length, 2, 'the SDK’s own retries are off');
  });

  it('turns a request that exceeds WORKAPI_TIMEOUT into a timeout error', async () => {
    gemini({ timeoutMs: 100, maxRetries: 0 });
    // The SDK's timer is unref'd; keep this otherwise idle test process alive until it fires.
    queue.push(
      (init) =>
        new Promise((_, reject) => {
          const keepAlive = setInterval(() => {}, 1000);
          init.signal?.addEventListener('abort', () => {
            clearInterval(keepAlive);
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        }),
    );
    await assert.rejects(request(), (e) => e.kind === 'timeout' && e.retryable);
  });

  it('maps truncation, safety stops, blocked prompts and invalid JSON', async () => {
    gemini({ maxRetries: 0 });
    queue.push(geminiOk('{"ok":', { finishReason: 'MAX_TOKENS' }));
    await assert.rejects(request(), (e) => e.kind === 'truncated' && !e.retryable);
    queue.push(geminiOk('', { finishReason: 'SAFETY' }));
    await assert.rejects(request(), (e) => e.kind === 'refused');
    queue.push(geminiOk('', { blockReason: 'PROHIBITED_CONTENT' }));
    await assert.rejects(request(), (e) => e.kind === 'refused');
    queue.push(geminiOk('Sure! Here is the JSON you asked for'));
    await assert.rejects(request(), (e) => e.kind === 'invalid_response' && e.retryable);
  });
});

// ---- Anthropic adapter ----------------------------------------------------------------------------

describe('Anthropic adapter (real @anthropic-ai/sdk, fake transport)', () => {
  beforeEach(() => anthropic());

  it('streams a structured-output request with effort, caching and the refusal fallback', async () => {
    queue.push(anthropicStream('{"ok":true}'));
    const r = await request();
    assert.deepEqual([r.data, r.provider, r.model, r.finishReason], [{ ok: true }, 'anthropic', 'claude-test-model', 'end_turn']);
    assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 120 });
    const [c] = calls;
    assert.match(c.url, /\/v1\/messages/);
    assert.equal(c.headers.get('authorization'), `Bearer ${ANTHROPIC_KEY}`, '@anthropic-ai/sdk 1.x sends the key as a bearer token');
    assert.match(c.headers.get('anthropic-beta') ?? '', /server-side-fallback/);
    assert.deepEqual(c.body.output_config, { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } });
    assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(c.body.stream, true);
  });

  it('honours provider options (effort, no fallback)', async () => {
    anthropic({ providerOptions: { effort: 'medium', refusalFallback: false } });
    queue.push(anthropicStream('{"ok":true}'));
    await request();
    assert.equal(calls[0].body.output_config.effort, 'medium');
    assert.equal(calls[0].headers.get('anthropic-beta'), null);
  });

  it('maps invalid keys, unknown models, rate limits and overload', async () => {
    anthropic({ maxRetries: 0 });
    queue.push(anthropicError(401, 'authentication_error', 'invalid x-api-key'));
    await assert.rejects(request(), (e) => e.kind === 'auth' && !e.retryable);
    queue.push(anthropicError(404, 'not_found_error', 'model: claude-test-model'));
    await assert.rejects(request(), (e) => e.kind === 'model_not_found');
    queue.push(anthropicError(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }));
    await assert.rejects(request(), (e) => e.kind === 'rate_limited' && e.retryAfterMs === 7000);
    queue.push(anthropicError(529, 'overloaded_error', 'Overloaded'));
    await assert.rejects(request(), (e) => e.kind === 'unavailable' && e.retryable);
  });

  it('maps refusals and truncation', async () => {
    queue.push(anthropicStream('', { stopReason: 'refusal' }));
    await assert.rejects(request(), (e) => e.kind === 'refused');
    queue.push(anthropicStream('{"ok":', { stopReason: 'max_tokens' }));
    await assert.rejects(request(), (e) => e.kind === 'truncated');
  });
});

// ---- retry helper and logs --------------------------------------------------------------------------

describe('WorkAPI retries and logging', () => {
  it('backs off exponentially with jitter and never retries permanent errors', async () => {
    assert.equal(retryDelay({}, 1, () => 0), 500);
    assert.equal(retryDelay({}, 3, () => 1), 4000);
    assert.equal(retryDelay({ retryAfterMs: 2500 }, 1), 2500);
    const waits = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new WorkApiError('unavailable', 'down');
        return 'ok';
      },
      { maxRetries: 2, sleep: async (ms) => waits.push(ms) },
    );
    assert.deepEqual([r.value, r.attempts, waits.length], ['ok', 3, 2]);
    n = 0;
    await assert.rejects(
      withRetry(async () => {
        n++;
        throw new WorkApiError('auth', 'bad key');
      }, { maxRetries: 3, sleep: async () => {} }),
    );
    assert.equal(n, 1);
  });

  it('logs provider, model and tokens but never the key or the content', async () => {
    gemini();
    const lines = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    setLogLevelForTests('debug');
    // Only WorkAgent's JSON log lines are captured; the test runner's own output passes through.
    const capture = (orig) => (c, ...r) => (String(c).startsWith('{"time"') ? (lines.push(String(c)), true) : orig(c, ...r));
    process.stdout.write = capture(out);
    process.stderr.write = capture(err);
    try {
      queue.push(geminiError(503, 'UNAVAILABLE', `overloaded ${GEMINI_KEY}`), geminiOk('{"ok":true}'));
      await workapi.generateJson({ system: 'SECRET-SYSTEM-TEXT', user: 'SECRET-TRANSCRIPT-TEXT', schema: SCHEMA, purpose: 'test' });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      setLogLevelForTests('error');
    }
    const all = lines.join('');
    assert.match(all, /"msg":"workapi request".*"provider":"gemini"/);
    assert.match(all, /"msg":"workapi retry"/);
    for (const secret of [GEMINI_KEY, 'SECRET-SYSTEM-TEXT', 'SECRET-TRANSCRIPT-TEXT']) assert.ok(!all.includes(secret), `${secret} not logged`);
  });
});

// ---- extraction through WorkAPI, then switching providers -------------------------------------------

describe('Meeting-to-action extraction through WorkAPI, switching providers by configuration only', () => {
  let admin;
  let raj;
  const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ada Admin>Welcome to the planning call.</v>\n\n00:00:05.000 --> 00:00:09.000\n<v Raj Kumar>I will send the budget summary to finance.</v>\n';
  const answer = {
    action_items: [
      {
        title: 'Send the budget summary to finance',
        description: 'Raj will send the budget summary to finance.',
        assignee_name_raw: 'Raj Kumar',
        assignee_confidence: 0.95,
        due_date_raw: null,
        due_date_resolved: null,
        due_date_is_ambiguous: false,
        priority: 'medium',
        ai_confidence: 0.9,
        needs_review_reason: null,
        evidence: [{ segment_ref: 'S2', speaker: 'Raj Kumar', timestamp: '00:05', quote: 'I will send the budget summary to finance' }],
      },
    ],
  };

  before(async () => {
    await resetDatabase();
    admin = await createUser({ email: 'ada@workapi.test', role: 'admin', fullName: 'Ada Admin' });
    raj = await createUser({ email: 'raj@workapi.test', role: 'employee', fullName: 'Raj Kumar' });
  });
  after(async () => {
    resetWorkApi();
    await closeDatabase();
  });

  async function meetingWithTranscript(title) {
    const parsed = parseTranscript(VTT, { format: 'vtt' });
    return withTransaction(async (conn) => {
      const id = await meetings.create(conn, { title, meetingUrl: 'https://meet.google.com/abc-defg-hij', scheduledAt: new Date('2026-11-10T10:00:00Z'), createdBy: admin });
      await meetings.replaceParticipants(conn, id, [admin, raj]);
      await transcripts.replaceForMeeting(conn, id, { fullText: renderFullText(parsed.segments), rawJson: { source: 'test' }, detectedLanguages: [], segments: parsed.segments });
      await meetings.update(conn, id, { status: 'transcript_ready' });
      return id;
    });
  }
  async function runExtraction(meetingId) {
    await requestExtraction(meetingId, { requestedBy: admin });
    const handlers = handlersFor(['ai.extract']);
    while (await processNext('workapi-test', handlers));
  }

  it('Gemini: the unchanged prompt and schema go to Gemini; the answer passes validation, assignee matching and saving', async () => {
    gemini();
    queue.push(geminiOk(JSON.stringify(answer)));
    const id = await meetingWithTranscript('Planning (Gemini)');
    await runExtraction(id);
    const c = calls[0];
    assert.equal(c.body.systemInstruction.parts[0].text, buildSystemPrompt('English'), 'system prompt preserved');
    assert.match(c.body.contents[0].parts[0].text, /\[S2\] \[00:05\] Raj Kumar: I will send the budget summary to finance\./);
    assert.deepEqual(c.body.generationConfig.responseJsonSchema, OUTPUT_SCHEMA, 'extraction schema preserved');
    const [item] = (await pool.query('SELECT title, assignee_user_id, assignee_match, review_status FROM action_items WHERE meeting_id = ?', [id]))[0];
    assert.deepEqual([item.title, item.assignee_user_id, item.assignee_match, item.review_status], ['Send the budget summary to finance', raj, 'exact', 'pending']);
    const [run] = (await pool.query("SELECT model, status, input_tokens, output_tokens, JSON_VALUE(summary, '$.provider') AS provider FROM extraction_runs WHERE meeting_id = ?", [id]))[0];
    assert.deepEqual([run.status, run.model, run.provider, run.input_tokens, run.output_tokens], ['succeeded', 'gemini-test-model-001', 'gemini', 1200, 350]);
    assert.equal((await meetings.findById(id)).status, 'review_pending');
  });

  it('Anthropic: the same pipeline with only the WorkAPI settings changed', async () => {
    anthropic();
    queue.push(anthropicStream(JSON.stringify(answer)));
    const id = await meetingWithTranscript('Planning (Claude)');
    await runExtraction(id);
    assert.deepEqual(calls[0].body.output_config.format.schema, OUTPUT_SCHEMA);
    assert.equal(calls[0].body.system[0].text, buildSystemPrompt('English'));
    const [item] = (await pool.query('SELECT assignee_user_id FROM action_items WHERE meeting_id = ?', [id]))[0];
    assert.equal(item.assignee_user_id, raj);
    const [run] = (await pool.query("SELECT model, JSON_VALUE(summary, '$.provider') AS provider FROM extraction_runs WHERE meeting_id = ?", [id]))[0];
    assert.deepEqual([run.model, run.provider], ['claude-test-model', 'anthropic']);
  });

  it('a provider failure marks the meeting failed with WorkAPI wording', async () => {
    gemini({ maxRetries: 0 });
    queue.push(geminiError(400, 'INVALID_ARGUMENT', 'API key expired. Please renew the API key.', [{ reason: 'API_KEY_INVALID' }]));
    const id = await meetingWithTranscript('Planning (bad key)');
    await runExtraction(id);
    const m = await meetings.findById(id);
    assert.deepEqual([m.status, m.last_error], ['failed', 'The AI provider rejected the WorkAPI API key']);
  });
});
