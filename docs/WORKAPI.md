# WorkAPI — provider-independent AI in WorkAgent

WorkAPI is the single AI layer of WorkAgent. Every AI request (today: action-item extraction from meeting transcripts) goes through it. Which provider answers — Google Gemini, Anthropic Claude, or another provider later — is configuration, not code.

## Switching providers

Only `backend/.env` changes; restart the API and the worker afterwards.

```
# Google Gemini
WORKAPI_PROVIDER=gemini
WORKAPI_API_KEY=<Gemini API key from Google AI Studio>
WORKAPI_MODEL=<a Gemini model id your key can use>
```

```
# Anthropic Claude
WORKAPI_PROVIDER=anthropic
WORKAPI_API_KEY=<Claude API key from the Claude Console>
WORKAPI_MODEL=claude-opus-5-5
```

- `WORKAPI_API_KEY` always holds the key of the **selected** provider. Only one key is needed at a time.
- If you set `WORKAPI_PROVIDER_OPTIONS` or `WORKAPI_PRICE_*`, update them too: options are provider-specific and prices are model-specific.
- The worker logs `workapi provider verified` with the provider and model at startup (a model lookup, no tokens), or `workapi provider check failed` with the reason (bad key, unknown model).
- Extractions already running finish on the provider they started with; new ones use the new provider. Every extraction run records its model, and its summary records the provider.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WORKAPI_PROVIDER` | with a key | — | `gemini` or `anthropic` |
| `WORKAPI_API_KEY` | to enable AI | — | Key of the selected provider. Backend only; never logged, never sent to the browser. Empty = AI extraction disabled, the rest of WorkAgent works |
| `WORKAPI_MODEL` | with a key | — | Model id of the selected provider (no default: model names change) |
| `WORKAPI_BASE_URL` | no | provider default | Another endpoint for the selected provider (proxy, regional or compatible gateway) |
| `WORKAPI_TIMEOUT` | no | `60000` | Per-request timeout in ms. Raise for long meetings on slower models (e.g. `300000`) |
| `WORKAPI_MAX_RETRIES` | no | `2` | Retries of rate limits, timeouts and outages within one job attempt (0–5) |
| `WORKAPI_MAX_OUTPUT_TOKENS` | no | `32000` | Output limit per request |
| `WORKAPI_PROVIDER_OPTIONS` | no | `{}` | Provider-specific JSON, validated by the selected adapter at startup (below) |
| `WORKAPI_PRICE_INPUT_USD_PER_MTOK`, `WORKAPI_PRICE_OUTPUT_USD_PER_MTOK` | no | — | Your prices for the configured model; set both or neither. Without them only token counts are shown |

Startup validation (`backend/src/config/index.js`, `services/workapi/providerManager.js`): a key without provider or model, an unknown provider, non-JSON options, options the selected adapter does not accept, or only one of the two prices stop the API and worker with a message naming the variable (never its value). Empty values (`VAR=`) count as unset.

Provider options:

| Provider | Options | Default |
|---|---|---|
| `anthropic` | `effort` (`low`…`max`), `refusalFallback` (server-side refusal fallback beta), `cacheSystemPrompt` | `{"effort":"high","refusalFallback":true,"cacheSystemPrompt":true}` — same behaviour as before WorkAPI |
| `gemini` | `temperature` (0–2), `thinkingLevel` (`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`), `thinkingBudget` | model defaults |

Variables from before WorkAPI (`ANTHROPIC_*`, `AI_PRICE_*`) are **no longer read**; the worker warns if they are still set. The local `backend/.env` was migrated on 2026-11-15 (backup `backups/backend.env.bak-20261115-064336`): the old lines are commented out and a WorkAPI block was added with `WORKAPI_PROVIDER=gemini` and an empty key/model.

## Architecture

```
aiExtract job / extraction service / worker startup
          │  workapi.generateJson({ system, user, schema, purpose })   workapi.verify()
          ▼
services/workapi/index.js          one request & response shape, JSON parsing, retries, usage, cost, logs
services/workapi/providerManager.js  adapter registry, selection from config, option validation, client cache
services/workapi/retry.js          retries for rate_limited / timeout / unavailable (provider Retry-After honoured)
services/workapi/errors.js         WorkApiError { kind, retryable, status, retryAfterMs, publicMessage }, key redaction
services/workapi/pricing.js        cost from WORKAPI_PRICE_* (also used by the operations center)
services/workapi/adapters/
  gemini.js      @google/genai (official Google Gen AI SDK), Gemini API
  anthropic.js   @anthropic-ai/sdk (official), Messages API — moved from services/ai/claudeClient.js
```

Unchanged and provider-independent: the prompt (`services/ai/extractionPrompt.js`), the response schema (`services/ai/schema.js`, now exported as `OUTPUT_SCHEMA`), validation, assignee matching and deadline resolution (`services/ai/validator.js`, `services/matching/*`, `utils/dates.js`), review, and transcript sources (uploads, Vexa, Teams, Google Meet all reach extraction through `queueAutoExtraction`).

### Response shape

```js
{ text, data, finishReason, provider, model, usage: { inputTokens, outputTokens, thinkingTokens? }, costUsd, attempts, durationMs }
```

`outputTokens` includes thinking/reasoning tokens where the provider bills them as output (Gemini `thoughtsTokenCount`).

### Errors

| `kind` | Retried | Typical cause |
|---|---|---|
| `not_configured` | no (job fails) | key/provider/model missing |
| `auth` | no | invalid or expired key (Gemini reports it as 400 `API_KEY_INVALID`) |
| `model_not_found` | no | wrong `WORKAPI_MODEL` for this key |
| `rate_limited` | yes; inline only if the provider asks to wait ≤ 30 s, else via the job queue | quota |
| `timeout` | yes | `WORKAPI_TIMEOUT` exceeded |
| `unavailable` | yes | 5xx, overload, network |
| `invalid_request` | no | provider rejected the request |
| `refused` | no | safety/refusal stop |
| `truncated` | no | output hit `WORKAPI_MAX_OUTPUT_TOKENS` |
| `invalid_response` | yes (job queue) | not JSON / empty |

SDK-level retries are disabled in both adapters (the Gemini SDK retries 5 times by default) so attempts are counted once. The job queue (`JOB_MAX_ATTEMPTS`) still retries retryable failures across job attempts.

### Logging and secrets

`workapi request` / `workapi retry` / `workapi request failed` log provider, model, purpose, finish reason, tokens, cost, attempts and duration. They never log the key, the prompt or the transcript. Error messages pass through `sanitize()` (removes the configured key and key-like strings, truncates). The key is only in `backend/.env` and process memory; the frontend shows WorkAPI variable names, never values.

### Structured output per provider

| Provider | How the JSON schema is sent |
|---|---|
| Gemini | `config.responseMimeType: 'application/json'` + `config.responseJsonSchema` (supports the schema's `type`, `enum`, `anyOf` nullables, `required`, `additionalProperties`) |
| Anthropic | `output_config.format: { type: 'json_schema', schema }` |

Providers do not enforce numeric ranges or string lengths; `validator.js` re-checks every item (unchanged).

## Embeddings (added 2026-11-15)

Used by duplicate work detection (`docs/FEATURES.md` §3). Optional: without them the detector uses text similarity.

| Variable | Default | Meaning |
|---|---|---|
| `WORKAPI_EMBEDDING_MODEL` | — | Embedding model id (e.g. a Gemini embedding model). Unset = embeddings off |
| `WORKAPI_EMBEDDING_PROVIDER` | `WORKAPI_PROVIDER` | Provider with an embeddings API (`gemini`; Anthropic has none) |
| `WORKAPI_EMBEDDING_API_KEY` | `WORKAPI_API_KEY` when the provider is the same | Key of the embedding provider |
| `WORKAPI_EMBEDDING_DIMENSIONS` | `768` | Output dimensionality |

`workapi.embed(texts, { purpose, taskType })` → `{ vectors, provider, model, dimensions, version, attempts, durationMs }`, batches of 50, same retries/logging as generation, never logs text or key. `version` = `provider:model:dimensions`; callers must not compare vectors of different versions. Adapter method: optional `embed(client, settings, { texts, taskType, dimensions })` (Gemini: `models.embedContent` → `batchEmbedContents`). Tested with the real SDK against a fake endpoint (`backend/test/duplicates.test.js`); **not run live** yet.

Other new WorkAPI callers (all `generateJson` with strict schemas): assistant intent parsing (`assistant.parse`), duplicate adjudication (`duplicates.adjudicate`), meeting decisions (`decisions.extract`), digest narrative (`digest.narrative`).

## Adding a provider (e.g. OpenAI)

1. Create `backend/src/services/workapi/adapters/<id>.js` exporting `{ id, displayName, optionsSchema, createClient, generateJson, verify, classifyError }` (contract in `providerManager.js`). Use the provider's official SDK, disable its retries, map its structured-output option to the given JSON Schema, and return the normalized `{ text, finishReason, model, usage }`.
2. Register it in `ADAPTERS` (`providerManager.js`) and add the id to `WORKAPI_PROVIDERS` (`config/index.js`). Startup fails if the two lists disagree.
3. Add tests like `backend/test/workapi.test.js` (real SDK, fake `fetch`).

No other file changes. OpenAI is **not implemented** yet.

## Testing

- `backend/test/workapi.test.js` (23 tests) — **mocked transport, real SDKs**: configuration validation; Gemini and Anthropic request shapes, response and usage normalization; invalid keys, unknown models, rate limits (with and without inline wait), outages, timeouts, truncation, safety stops, invalid JSON; retry policy; no key or content in logs; the full extraction job through Gemini and then through Anthropic with only settings changed, producing the same validated, assignee-matched item.
- Other suites mock `workapi` itself (`extraction.test.js`, `vexa.test.js`, `meetingPipeline.test.js`).
- **No automated test calls a real provider.** A live smoke test needs a key: set the three variables, start the worker (watch for `workapi provider verified`), then run an extraction on a short real transcript and check the items, `extraction_runs` tokens and Ops → AI usage.
- **Prompt quality on Gemini has not been measured.** The prompt and schema are unchanged and accepted by Gemini's structured output, but answer quality (precision of action items, verbatim quotes, deadline handling) must be checked on real transcripts before relying on it.

## Live verification log

### 2026-11-15 — Gemini (Gemini API key, SDK `@google/genai` 2.32.0)

| Check | Result |
|---|---|
| `workapi.verify()` with `WORKAPI_MODEL=gemini-2.5-flash` | Passed — but see next row |
| Generation with `gemini-2.5-flash` | **404** "no longer available to new users" → WorkAPI `model_not_found`. `models.get` still lists retired models, so **`verify()` can pass for a model that cannot generate**; the first real request is the reliable check |
| `gemini-3.8-flash` (recommended in Google's error) and `gemini-flash-latest` (alias to it) | **503 / 504 DEADLINE_EXCEEDED on every request**, including plain text without a schema, at 30 s, 45 s, 60 s and 120 s deadlines. A provider-side problem at the time of testing; WorkAPI classified (`timeout`/`unavailable`) and retried correctly |
| `gemini-3.5-flash`, plain / JSON mime / `responseSchema` / `responseJsonSchema` | All OK (7–10 s). Responses report `modelVersion` `gemini-3.6-flash` |
| WorkAPI structured-output smoke test (`gemini-3.5-flash`) | OK: schema-valid JSON incl. a nullable number, `STOP`, 10 in / 258 out tokens (237 thinking), 8.4 s, 1 attempt |
| Real extraction, production prompt + validator, dev-DB transcript (meeting 8: 12 segments, 1,292 chars, English) — **read-only, nothing saved** | OK: 2 action items, 0 rejected, all evidence quotes verified verbatim, relative deadlines ("in the next 30 minutes", "by 6 15 today") resolved to the meeting date and flagged *deadline_needs_confirmation*; owner left unassigned and flagged because the speaker label ("Gemini Vinay") matches no registered user — correct, no guessing. 1,157 in / 4,314 out tokens (3,846 thinking), 26 s |
| Real extraction on a one-line Hindi transcript (meeting 7, 39 chars) | OK: correctly no action items |

Conclusions:
- Use **`WORKAPI_MODEL=gemini-3.5-flash`** for now; re-test `gemini-3.8-flash` later. (Applied to the local `backend/.env` on 2026-11-15 together with `WORKAPI_TIMEOUT=180000`; backup `backups/backend.env.bak-20261115-072102`; live check passed.)
- Thinking dominates output tokens and time (26 s for a 1.3k-character transcript). **Raise `WORKAPI_TIMEOUT` to about `180000`** for real meetings, and consider `WORKAPI_PROVIDER_OPTIONS={"thinkingLevel":"LOW"}` after measuring quality.
- Still not done: quality on long (20–60 min) meetings and multilingual meetings with real action items; cost (no prices configured).
