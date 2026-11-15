// WorkAPI adapter for Google Gemini (Gemini API, official Google Gen AI SDK @google/genai).
//
// Structured output: responseMimeType 'application/json' + responseJsonSchema, which accepts the
// same JSON Schema WorkAgent already sends to other providers (type, enum, anyOf for nullables,
// required, additionalProperties). The system prompt goes in systemInstruction, the transcript in
// the user turn, exactly as with other providers.
// Provider-specific knobs come from WORKAPI_PROVIDER_OPTIONS (see optionsSchema).
import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { WorkApiError, sanitize } from '../errors.js';

export const optionsSchema = z
  .object({
    // Lower = more deterministic. Unset: the model's default.
    temperature: z.number().min(0).max(2).optional(),
    // Thinking controls for models that support them; unset: the model's default.
    thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).optional(),
    thinkingBudget: z.number().int().min(-1).optional(),
  })
  .strict();

export function createClient(settings) {
  return new GoogleGenAI({
    apiKey: settings.apiKey,
    httpOptions: {
      timeout: settings.timeoutMs,
      // WorkAPI retries centrally (services/workapi/retry.js); the SDK retries 5 times by default.
      retryOptions: { attempts: 1 },
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    },
  });
}

// Finish reasons that mean the model (or its safety filters) declined the content.
const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

/** "retryDelay": "30s" in a RESOURCE_EXHAUSTED body, in milliseconds. */
function retryDelayOf(message) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(message ?? ''));
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Maps SDK/network errors to WorkAPI kinds. Messages never include the API key. */
export function classifyError(err, settings = {}) {
  if (err instanceof WorkApiError) return err;
  const base = { provider: 'gemini', cause: err };
  const msg = String(err?.message ?? err);
  const detail = sanitize(`${err?.name ?? 'Error'}${err?.status ? ` ${err.status}` : ''}: ${msg}`, settings.apiKey);
  if (err instanceof ApiError || (typeof err?.status === 'number' && err?.name === 'ApiError')) {
    const status = err.status;
    const s = { ...base, status };
    // The Gemini API answers an invalid or expired key with 400 INVALID_ARGUMENT / API_KEY_INVALID.
    if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid|API key expired|API_KEY_EXPIRED/i.test(msg))) return new WorkApiError('auth', detail, s);
    if (status === 404) return new WorkApiError('model_not_found', detail, { ...s, publicMessage: `WorkAPI model "${settings.model}" was not found for this key` });
    if (status === 429) return new WorkApiError('rate_limited', detail, { ...s, retryAfterMs: retryDelayOf(msg) });
    if (status === 408 || status === 504) return new WorkApiError('timeout', detail, s);
    if (status >= 500) return new WorkApiError('unavailable', detail, s);
    return new WorkApiError('invalid_request', detail, s);
  }
  // httpOptions.timeout aborts the request.
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new WorkApiError('timeout', detail, base);
  if (err instanceof TypeError || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(msg)) return new WorkApiError('unavailable', detail, base);
  return new WorkApiError('unexpected', detail, base);
}

/**
 * One structured-output request.
 * @returns {{ text, finishReason, model, usage: { inputTokens, outputTokens, thinkingTokens } }}
 */
export async function generateJson(client, settings, { system, user, schema, maxOutputTokens }) {
  const opts = settings.options;
  let res;
  try {
    res = await client.models.generateContent({
      model: settings.model,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        maxOutputTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.thinkingLevel || opts.thinkingBudget !== undefined
          ? { thinkingConfig: { ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}), ...(opts.thinkingBudget !== undefined ? { thinkingBudget: opts.thinkingBudget } : {}) } }
          : {}),
      },
    });
  } catch (err) {
    throw classifyError(err, settings);
  }

  const blocked = res?.promptFeedback?.blockReason;
  if (blocked) {
    throw new WorkApiError('refused', `Prompt blocked (${blocked})`, { provider: 'gemini', publicMessage: 'The AI model declined to process this transcript' });
  }
  const finishReason = res?.candidates?.[0]?.finishReason ?? null;
  if (finishReason && REFUSALS.has(finishReason)) {
    throw new WorkApiError('refused', `Response stopped (${finishReason})`, { provider: 'gemini', publicMessage: 'The AI model declined to process this transcript' });
  }
  if (finishReason === 'MAX_TOKENS') throw new WorkApiError('truncated', 'Response truncated at maxOutputTokens', { provider: 'gemini' });
  const text = res?.text ?? '';
  if (!text) throw new WorkApiError('invalid_response', `Empty response (finish reason ${finishReason ?? 'none'})`, { provider: 'gemini' });

  const u = res.usageMetadata ?? {};
  const thinking = u.thoughtsTokenCount ?? 0;
  return {
    text,
    finishReason,
    model: res.modelVersion ?? settings.model,
    // Thinking tokens are billed as output.
    usage: { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount === undefined && !thinking ? null : (u.candidatesTokenCount ?? 0) + thinking, thinkingTokens: thinking || null },
  };
}

/** Confirms the configured model exists for this key (models.get; no tokens used). */
export async function verify(client, settings) {
  try {
    const m = await client.models.get({ model: settings.model });
    return { model: String(m?.name ?? settings.model).replace(/^models\//, '') };
  } catch (err) {
    throw classifyError(err, settings);
  }
}

/**
 * Text embeddings (batchEmbedContents). Used by duplicate work detection.
 * @returns {{ vectors: number[][], model, dimensions }}
 */
export async function embed(client, settings, { texts, taskType = 'SEMANTIC_SIMILARITY', dimensions }) {
  let res;
  try {
    res = await client.models.embedContent({
      model: settings.model,
      contents: texts.map((text) => ({ role: 'user', parts: [{ text }] })),
      config: { taskType, ...(dimensions ? { outputDimensionality: dimensions } : {}) },
    });
  } catch (err) {
    throw classifyError(err, settings);
  }
  const vectors = (res?.embeddings ?? []).map((e) => e?.values ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => !v.length)) throw new WorkApiError('invalid_response', `Expected ${texts.length} embeddings, got ${vectors.length}`, { provider: 'gemini' });
  return { vectors, model: settings.model, dimensions: vectors[0].length };
}

export const gemini = { id: 'gemini', displayName: 'Google Gemini', optionsSchema, createClient, generateJson, verify, classifyError, embed };
export default gemini;
