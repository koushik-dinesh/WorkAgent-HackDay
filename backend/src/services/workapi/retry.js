// Retries for transient WorkAPI failures (rate limits, timeouts, provider outages), in one place
// for every provider. SDK-level retries are switched off in the adapters so attempts are counted
// once. A provider asking to wait longer than MAX_INLINE_WAIT_MS is not waited for here: the error
// goes back to the job queue, which retries later with its own backoff.

export const MAX_INLINE_WAIT_MS = 30_000;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before retry number `n` (1-based): exponential with jitter, or what the provider asked for. */
export function retryDelay(err, n, random = Math.random) {
  if (err?.retryAfterMs !== undefined && err?.retryAfterMs !== null) return err.retryAfterMs;
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (n - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Runs fn(attempt) and retries retryable WorkApiErrors up to maxRetries times.
 * @returns {Promise<{ value, attempts }>}
 */
export async function withRetry(fn, { maxRetries, sleep = defaultSleep, onRetry = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      const delay = retryDelay(err, attempt);
      if (!err?.retryable || attempt > maxRetries || delay > MAX_INLINE_WAIT_MS) {
        if (err && typeof err === 'object') err.attempts = attempt;
        throw err;
      }
      onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
}
