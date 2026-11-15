// WorkAPI adapter for Anthropic Claude (Messages API, official @anthropic-ai/sdk).
//
// Moved from services/ai/claudeClient.js without changing the request: streamed messages,
// structured output (output_config.format), effort, prompt caching on the fixed system prompt and
// the server-side refusal fallback (beta). Provider-specific knobs come from
// WORKAPI_PROVIDER_OPTIONS (see optionsSchema) and never leak out of this file.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { WorkApiError, sanitize } from '../errors.js';

export const optionsSchema = z
  .object({
    // low | medium | high | xhigh | max. 'high' matches the previous ANTHROPIC_EFFORT default.
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    // Server-side refusal fallback (beta): retries a declined request on another model.
    refusalFallback: z.boolean().default(true),
    // Prompt caching of the fixed system prompt.
    cacheSystemPrompt: z.boolean().default(true),
  })
  .strict();

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createClient(settings) {
  return new Anthropic({
    apiKey: settings.apiKey,
    timeout: settings.timeoutMs,
    // WorkAPI retries centrally (services/workapi/retry.js); the SDK must not retry as well.
    maxRetries: 0,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  });
}

const retryAfterMs = (err) => {
  const h = err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'];
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
};

/** Maps SDK errors to WorkAPI kinds. Messages never include the API key. */
export function classifyError(err, settings = {}) {
  if (err instanceof WorkApiError) return err;
  const status = err?.status;
  const detail = sanitize(`${err?.constructor?.name ?? 'Error'}${status ? ` ${status}` : ''}: ${err?.message ?? err}`, settings.apiKey);
  const base = { provider: 'anthropic', status, cause: err };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new WorkApiError('auth', detail, base);
  if (err instanceof Anthropic.NotFoundError) return new WorkApiError('model_not_found', detail, { ...base, publicMessage: `WorkAPI model "${settings.model}" was not found for this key` });
  if (err instanceof Anthropic.RateLimitError) return new WorkApiError('rate_limited', detail, { ...base, retryAfterMs: retryAfterMs(err) });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new WorkApiError('timeout', detail, base);
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) return new WorkApiError('unavailable', detail, base);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) return new WorkApiError('invalid_request', detail, base);
  if (err instanceof Anthropic.APIError) {
    const retryable = status === 408 || status === 409 || (status ?? 0) >= 500;
    return new WorkApiError(retryable ? 'unavailable' : 'invalid_request', detail, base);
  }
  return new WorkApiError('unexpected', detail, base);
}

/**
 * One structured-output request. Streams (long transcripts / outputs) and returns the final text.
 * @returns {{ text, finishReason, model, usage: { inputTokens, outputTokens } }}
 */
export async function generateJson(client, settings, { system, user, schema, maxOutputTokens }) {
  const opts = settings.options;
  const params = {
    model: settings.model,
    max_tokens: maxOutputTokens,
    system: [{ type: 'text', text: system, ...(opts.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' } } : {}) }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort: opts.effort, format: { type: 'json_schema', schema } },
  };

  let message;
  try {
    message = opts.refusalFallback
      ? await client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }).finalMessage()
      : await client.messages.stream(params).finalMessage();
  } catch (err) {
    throw classifyError(err, settings);
  }

  if (message.stop_reason === 'refusal') {
    throw new WorkApiError('refused', `Model refused (category: ${message.stop_details?.category ?? 'unknown'})`, { provider: 'anthropic', publicMessage: 'The AI model declined to process this transcript' });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new WorkApiError('truncated', 'Response truncated at max_tokens', { provider: 'anthropic' });
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    finishReason: message.stop_reason,
    model: message.model ?? settings.model,
    usage: { inputTokens: message.usage?.input_tokens ?? null, outputTokens: message.usage?.output_tokens ?? null },
  };
}

/** Confirms the configured model exists for this key (Models API; no tokens used). */
export async function verify(client, settings) {
  try {
    const m = await client.models.retrieve(settings.model);
    return { model: m.id ?? settings.model };
  } catch (err) {
    throw classifyError(err, settings);
  }
}

export const anthropic = { id: 'anthropic', displayName: 'Anthropic Claude', optionsSchema, createClient, generateJson, verify, classifyError };
export default anthropic;
