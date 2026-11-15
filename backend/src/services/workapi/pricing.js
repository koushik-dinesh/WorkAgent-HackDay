// WorkAPI cost tracking. Prices are never assumed: they come from WORKAPI_PRICE_INPUT_USD_PER_MTOK
// and WORKAPI_PRICE_OUTPUT_USD_PER_MTOK (your contract prices for the configured model). Without
// both, costs are null and only token counts are shown.
import { config } from '../../config/index.js';

export const prices = () => config.workapi.prices ?? null;

/** USD cost of a usage, rounded to cents, or null when no prices are configured. */
export function costUsd(inputTokens, outputTokens, p = prices()) {
  if (!p) return null;
  return Math.round((((inputTokens ?? 0) * p.input + (outputTokens ?? 0) * p.output) / 1_000_000) * 100) / 100;
}

/** Same, unrounded, for single requests (a few hundredths of a cent would round to 0). */
export function exactCostUsd(inputTokens, outputTokens, p = prices()) {
  if (!p) return null;
  return ((inputTokens ?? 0) * p.input + (outputTokens ?? 0) * p.output) / 1_000_000;
}
