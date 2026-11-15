// WorkAPI provider manager: the one place that knows which adapters exist, which one is selected,
// and how its client is built. Everything else in WorkAgent talks to services/workapi/index.js.
//
// Adapter interface (services/workapi/adapters/<id>.js; see docs/WORKAPI.md):
//   id, displayName
//   optionsSchema                      zod schema for WORKAPI_PROVIDER_OPTIONS (provider-specific)
//   createClient(settings)             -> SDK client; settings = { apiKey, model, baseUrl, timeoutMs, options, fetch? }
//   generateJson(client, settings, { system, user, schema, maxOutputTokens })
//                                      -> { text, finishReason, model, usage: { inputTokens, outputTokens, thinkingTokens? } }
//   verify(client, settings)           -> { model }  (cheap check that key and model work; no generation)
//   classifyError(err, settings)       -> WorkApiError
//   embed?(client, settings, { texts, taskType, dimensions })
//                                      -> { vectors, model, dimensions }  (optional: providers with
//                                         an embeddings API; Anthropic has none)
// Adapters must disable their SDK's own retries (WorkAPI retries centrally), throw only
// WorkApiError, and never put the API key in messages.
import { config, WORKAPI_PROVIDERS } from '../../config/index.js';
import anthropic from './adapters/anthropic.js';
import gemini from './adapters/gemini.js';

export const ADAPTERS = { anthropic, gemini };

// Config and adapters must agree: adding a provider means adding both.
for (const id of WORKAPI_PROVIDERS) if (!ADAPTERS[id]) throw new Error(`WorkAPI provider "${id}" has no adapter`);

const fromConfig = () => ({
  provider: config.workapi.provider,
  apiKey: config.workapi.apiKey,
  model: config.workapi.model,
  baseUrl: config.workapi.baseUrl,
  timeoutMs: config.workapi.timeoutMs,
  maxRetries: config.workapi.maxRetries,
  maxOutputTokens: config.workapi.maxOutputTokens,
  providerOptions: config.workapi.providerOptions,
  embedding: { ...config.workapi.embedding },
  fetch: undefined,
});

let settings = fromConfig();
let cached = null; // { key, client }

/** Validated provider options for the selected adapter. Throws with a clear message. */
function optionsFor(adapter, raw) {
  const result = adapter.optionsSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(options)'}: ${i.message}`).join('; ');
    throw new Error(`WORKAPI_PROVIDER_OPTIONS is invalid for provider "${adapter.id}": ${issues}`);
  }
  return result.data;
}

/** Checks the selected provider's options now (at startup) instead of on the first request. */
export function validateSettings(s = settings) {
  if (!s.provider) return;
  const adapter = ADAPTERS[s.provider];
  if (!adapter) throw new Error(`Unknown WORKAPI_PROVIDER "${s.provider}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  optionsFor(adapter, s.providerOptions);
}
validateSettings();

/** Tests only: point WorkAPI at a provider/fake transport. Clears the cached client. */
export function configureWorkApi(overrides) {
  settings = { ...settings, ...overrides };
  validateSettings();
  cached = null;
  cachedEmbedding = null;
}
export function resetWorkApi() {
  settings = fromConfig();
  cached = null;
  cachedEmbedding = null;
}

export const isConfigured = () => Boolean(settings.provider && settings.apiKey && settings.model);

// Embeddings may use another provider than generation (Anthropic has no embeddings API). The key
// defaults to WORKAPI_API_KEY when the embedding provider is the generation provider.
function embeddingSettings() {
  const e = settings.embedding ?? {};
  const provider = e.provider ?? settings.provider;
  const apiKey = e.apiKey ?? (provider === settings.provider ? settings.apiKey : undefined);
  return { provider, apiKey, model: e.model ?? null, dimensions: e.dimensions ?? null, baseUrl: e.baseUrl ?? (provider === settings.provider ? settings.baseUrl : undefined) };
}

/** Why embeddings are unavailable, or null. */
export function embeddingProblem() {
  const e = embeddingSettings();
  if (!e.model) return 'WORKAPI_EMBEDDING_MODEL is not set';
  if (!e.provider) return 'No embedding provider (WORKAPI_EMBEDDING_PROVIDER or WORKAPI_PROVIDER)';
  if (!ADAPTERS[e.provider]?.embed) return `Provider "${e.provider}" has no embeddings API; set WORKAPI_EMBEDDING_PROVIDER=gemini`;
  if (!e.apiKey) return 'No API key for the embedding provider (WORKAPI_EMBEDDING_API_KEY)';
  return null;
}
export const embeddingsConfigured = () => embeddingProblem() === null;
export const currentEmbeddingSettings = () => {
  const { apiKey, ...rest } = embeddingSettings();
  return rest;
};

let cachedEmbedding = null;
/** { adapter, client, settings } for embeddings. */
export function activeEmbedding() {
  const e = embeddingSettings();
  const adapter = ADAPTERS[e.provider];
  const s = { apiKey: e.apiKey, model: e.model, baseUrl: e.baseUrl, timeoutMs: settings.timeoutMs, fetch: settings.fetch, options: {} };
  const key = `${e.provider}|${e.model}|${e.baseUrl ?? ''}|${settings.timeoutMs}`;
  if (!cachedEmbedding || cachedEmbedding.key !== key) cachedEmbedding = { key, client: adapter.createClient(s) };
  return { adapter, client: cachedEmbedding.client, settings: s, provider: e.provider, dimensions: e.dimensions };
}
export const currentSettings = () => settings;

/** { adapter, client, settings } for the selected provider, building the client once. */
export function active() {
  const adapter = ADAPTERS[settings.provider];
  const s = { apiKey: settings.apiKey, model: settings.model, baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, fetch: settings.fetch, options: optionsFor(adapter, settings.providerOptions) };
  const key = `${settings.provider}|${settings.model}|${settings.baseUrl ?? ''}|${settings.timeoutMs}`;
  if (!cached || cached.key !== key) cached = { key, client: adapter.createClient(s) };
  return { adapter, client: cached.client, settings: s };
}
