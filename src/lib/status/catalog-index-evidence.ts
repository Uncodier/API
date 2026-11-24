import type { TelemetryRecord } from './telemetry';

export const CATALOG_INDEX_QUEUE_TELEMETRY = 'catalog_index_queue';
export const CATALOG_INDEX_QUEUE_FRESHNESS_MS = 3 * 60_000;
export const CATALOG_INDEX_QUEUE_MESSAGES = {
  clear: 'No exhausted catalog embedding jobs observed',
  exhausted: 'Catalog embedding jobs exhausted; operator retry required',
  unavailable: 'Unable to verify exhausted catalog embedding jobs',
} as const;

export function catalogIndexQueueEvidence(enabled: boolean, receipt: TelemetryRecord | null, now: number) {
  const at = receipt ? Date.parse(receipt.created_at) : NaN;
  const fresh = Number.isFinite(at) && at <= now && now - at <= CATALOG_INDEX_QUEUE_FRESHNESS_MS;
  const status = enabled && fresh && (receipt?.status === 'degraded' || receipt?.status === 'up')
    ? receipt.status : 'skipped';
  const reason = !enabled ? 'disabled' : !receipt ? 'missing_receipt' : !fresh ? 'stale_receipt'
    : status === 'degraded' ? receipt.message === CATALOG_INDEX_QUEUE_MESSAGES.exhausted ? 'exhausted' : 'unavailable'
    : status === 'skipped' ? 'unverified_receipt' : null;
  return {
    enabled,
    status,
    observedAt: receipt?.created_at ?? null,
    reason,
    evidenceScope: 'exhausted_jobs_only_not_index_coverage',
  } as const;
}