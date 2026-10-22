/** Provider-reported accounting evidence, not a new customer tariff.
 * BYOK upstream spend is billed outside the gateway and must be reconciled
 * separately. Never substitute it for usage.cost or add the two blindly.
 */
export function openRouterCostEvidence(usage: unknown): Record<string, number | boolean> {
  if (!usage || typeof usage !== 'object') return {};
  const value = usage as Record<string, unknown>;
  const evidence: Record<string, number | boolean> = {};
  if (typeof value.is_byok === 'boolean') evidence.is_byok = value.is_byok;
  if (typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0) {
    evidence.gateway_account_cost = value.cost;
  }
  const details = value.cost_details;
  const upstream = details && typeof details === 'object'
    ? (details as Record<string, unknown>).upstream_inference_cost : undefined;
  if (typeof upstream === 'number' && Number.isFinite(upstream) && upstream >= 0) {
    evidence.upstream_inference_cost = upstream;
  }
  if (value.is_byok === true) evidence.external_cost_reconciliation_required = true;
  return evidence;
}