/** Product credits are USD-denominated. Tools and sandbox have separate tariffs. */
export const OPENROUTER_COST_MULTIPLIER = 1.25;

/** Never reconstruct actual cost from token counts: routing, caching and tiers vary. */
export function calculateOpenRouterCreditCharge(usage: unknown): number {
  const cost = usage && typeof usage === 'object' && 'cost' in usage ? usage.cost : undefined;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new Error('OpenRouter actual cost unavailable; billing requires reconciliation');
  }
  const amount = cost * OPENROUTER_COST_MULTIPLIER;
  if (!Number.isFinite(amount)) throw new Error('OpenRouter actual cost is outside the supported range');
  return amount;
}