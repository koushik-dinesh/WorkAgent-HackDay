// WorkAPI: WorkAgent's provider-independent AI service. The only module the rest of the
// application uses for AI. Which provider runs (Gemini, Claude, …) is configuration:
// WORKAPI_PROVIDER, WORKAPI_API_KEY, WORKAPI_MODEL (see docs/WORKAPI.md).
//
// `workapi` is a plain object so tests can replace its methods with fakes; the normal test suite
// never calls a real provider (the key is forced off under NODE_ENV=test).
//
// What every call gets, whatever the provider:
//   - one request shape: { system, user, schema } -> JSON text matching `schema`
//   - one response shape: { text, data, finishReason, provider, model, usage, costUsd, attempts, durationMs }
//   - one error type: WorkApiError with a `kind` (errors.js), `retryable` for the job queue
//   - timeouts (WORKAPI_TIMEOUT), retries of transient failures (WORKAPI_MAX_RETRIES, retry.js)
//   - token usage and, when prices are configured, cost (pricing.js)
//   - logs with provider, model, tokens and timings, never the key or the content
import { PermanentJobError } from '../../jobs/queue.js';
import { logger } from '../../utils/logger.js';
import { WorkApiError } from './errors.js';
import { exactCostUsd } from './pricing.js';
import { active, activeEmbedding, currentEmbeddingSettings, currentSettings, embeddingProblem, embeddingsConfigured, isConfigured } from './providerManager.js';
import { withRetry } from './retry.js';

export { WorkApiError } from './errors.js';

function notConfigured() {
  return new PermanentJobError('WorkAPI is not configured (WORKAPI_PROVIDER, WORKAPI_API_KEY, WORKAPI_MODEL)', { publicMessage: 'AI extraction is not configured' });
}

/**
 * One structured-output request through the selected provider.
 * @param {{ system: string, user: string, schema: object, purpose?: string, maxOutputTokens?: number }} request
 *   schema: JSON Schema of the expected object (types, enum, anyOf nullables, required,
 *   additionalProperties:false). The provider is asked to answer with JSON matching it; the
 *   caller still validates (providers do not enforce every constraint).
 * @returns {Promise<{ text, data, finishReason, provider, model, usage: { inputTokens, outputTokens }, costUsd, attempts, durationMs }>}
 * @throws WorkApiError (or PermanentJobError when not configured)
 */
async function generateJson({ system, user, schema, purpose = 'generate', maxOutputTokens }) {
  if (!isConfigured()) throw notConfigured();
  const s = currentSettings();
  const started = Date.now();
  const { value: out, attempts } = await withRetry(
    async () => {
      const { adapter, client, settings } = active();
      try {
        return await adapter.generateJson(client, settings, { system, user, schema, maxOutputTokens: maxOutputTokens ?? s.maxOutputTokens });
      } catch (err) {
        throw adapter.classifyError(err, settings);
      }
    },
    {
      maxRetries: s.maxRetries,
      onRetry: (err, attempt, delayMs) => logger.warn('workapi retry', { provider: s.provider, model: s.model, purpose, attempt, kind: err.kind, status: err.status ?? null, delayMs }),
    },
  ).catch((err) => {
    logger.warn('workapi request failed', { provider: s.provider, model: s.model, purpose, kind: err.kind ?? err.name, status: err.status ?? null, attempts: err.attempts ?? null, ms: Date.now() - started });
    throw err;
  });

  let data;
  try {
    data = JSON.parse(out.text);
  } catch {
    throw new WorkApiError('invalid_response', 'Response is not valid JSON', { provider: s.provider });
  }
  const costUsd = exactCostUsd(out.usage.inputTokens, out.usage.outputTokens);
  const result = { ...out, data, provider: s.provider, attempts, durationMs: Date.now() - started, costUsd };
  logger.info('workapi request', { provider: s.provider, model: out.model, purpose, finishReason: out.finishReason, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, costUsd, attempts, ms: result.durationMs });
  return result;
}

/** Cheap check that the key and model work (no generation). Returns { provider, model }. */
async function verify() {
  if (!isConfigured()) throw notConfigured();
  const { adapter, client, settings } = active();
  try {
    const r = await adapter.verify(client, settings);
    return { provider: currentSettings().provider, model: r.model };
  } catch (err) {
    throw adapter.classifyError(err, settings);
  }
}

const EMBED_BATCH = 50;

/**
 * Text embeddings through the configured embedding provider (WORKAPI_EMBEDDING_*).
 * `version` identifies the vector space ("provider:model:dimensions"); vectors of different
 * versions must never be compared (duplicate detection re-indexes instead).
 * @returns {Promise<{ vectors: number[][], provider, model, dimensions, version, attempts, durationMs }>}
 */
async function embed(texts, { purpose = 'embed', taskType } = {}) {
  const problem = embeddingProblem();
  if (problem) throw new PermanentJobError(`WorkAPI embeddings are not configured: ${problem}`, { publicMessage: 'AI embeddings are not configured' });
  const started = Date.now();
  const s = currentSettings();
  const e = currentEmbeddingSettings();
  const vectors = [];
  let attempts = 0;
  let model = e.model;
  let dimensions = null;
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const { value, attempts: n } = await withRetry(
      async () => {
        const { adapter, client, settings, dimensions: dims } = activeEmbedding();
        try {
          return await adapter.embed(client, settings, { texts: batch, taskType, dimensions: dims ?? undefined });
        } catch (err) {
          throw adapter.classifyError(err, settings);
        }
      },
      { maxRetries: s.maxRetries, onRetry: (err, attempt, delayMs) => logger.warn('workapi retry', { provider: e.provider, model: e.model, purpose, attempt, kind: err.kind, delayMs }) },
    ).catch((err) => {
      logger.warn('workapi request failed', { provider: e.provider, model: e.model, purpose, kind: err.kind ?? err.name, ms: Date.now() - started });
      throw err;
    });
    attempts += n;
    model = value.model ?? model;
    dimensions = value.dimensions;
    vectors.push(...value.vectors);
  }
  const durationMs = Date.now() - started;
  logger.info('workapi embeddings', { provider: e.provider, model, purpose, count: texts.length, dimensions, attempts, ms: durationMs });
  return { vectors, provider: e.provider, model, dimensions, version: `${e.provider}:${model}:${dimensions}`, attempts, durationMs };
}

export const workapi = {
  isConfigured,
  /** Selected provider id ('gemini', 'anthropic', …) or null. For diagnostics and run records. */
  provider: () => currentSettings().provider,
  /** Configured model id or null. */
  model: () => currentSettings().model,
  generateJson,
  verify,
  /** Embeddings (duplicate work detection). Optional: features fall back when unavailable. */
  embeddingsConfigured,
  embeddingProblem,
  /** { provider, model, dimensions } of the embedding configuration (no key). */
  embeddingInfo: currentEmbeddingSettings,
  embed,
};
