// WorkAPI error taxonomy. Every adapter turns its provider's failures into a WorkApiError, so the
// rest of WorkAgent (job queue, extraction, Ops) never sees a provider-specific error class.
// Messages are sanitized: no API keys, no request or response bodies beyond a short excerpt.

export const WORKAPI_ERROR_KINDS = {
  not_configured: { retryable: false, publicMessage: 'AI is not configured on the server (WorkAPI)' },
  auth: { retryable: false, publicMessage: 'The AI provider rejected the WorkAPI API key' },
  model_not_found: { retryable: false, publicMessage: 'The configured WorkAPI model is not available for this key' },
  rate_limited: { retryable: true, publicMessage: 'The AI provider is rate limiting requests' },
  timeout: { retryable: true, publicMessage: 'The AI provider did not answer in time' },
  unavailable: { retryable: true, publicMessage: 'The AI provider is temporarily unavailable' },
  invalid_request: { retryable: false, publicMessage: 'The AI provider rejected the request' },
  refused: { retryable: false, publicMessage: 'The AI model declined to process this input' },
  truncated: { retryable: false, publicMessage: 'The AI response was too long; raise WORKAPI_MAX_OUTPUT_TOKENS' },
  invalid_response: { retryable: true, publicMessage: 'The AI returned an invalid response' },
  unexpected: { retryable: true, publicMessage: 'AI processing failed unexpectedly' },
};

export class WorkApiError extends Error {
  /**
   * @param {keyof WORKAPI_ERROR_KINDS} kind
   * @param {string} message internal, sanitized
   * @param {{ provider?: string, status?: number, retryAfterMs?: number, publicMessage?: string, retryable?: boolean, cause?: unknown }} [details]
   */
  constructor(kind, message, { provider, status, retryAfterMs, publicMessage, retryable, cause } = {}) {
    if (!WORKAPI_ERROR_KINDS[kind]) throw new Error(`Unknown WorkAPI error kind: ${kind}`);
    super(message, { cause });
    this.name = 'WorkApiError';
    this.kind = kind;
    this.provider = provider ?? null;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    // Read by the job queue: false stops retries.
    this.retryable = retryable ?? WORKAPI_ERROR_KINDS[kind].retryable;
    this.publicMessage = publicMessage ?? WORKAPI_ERROR_KINDS[kind].publicMessage;
  }
}

// Key-like strings of the providers WorkAPI knows (Google AIza…, Anthropic/OpenAI sk-…).
const KEY_PATTERNS = [/AIza[0-9A-Za-z_-]{20,}/g, /sk-[A-Za-z0-9_-]{16,}/g];

/** Removes the configured key and anything key-like, and shortens the text. */
export function sanitize(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  for (const re of KEY_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}
