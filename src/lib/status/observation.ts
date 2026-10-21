import type { SystemHealthStatus } from './types';

export const STATUS_STALE_AFTER_MS = 90 * 60 * 1000;

/** Interpret persisted evidence, including legacy configuration-only checks. */
export function normalizeHealthStatus(
  status: string,
  checks: Record<string, unknown> = {},
): SystemHealthStatus {
  if (status === 'down') return 'down';
  if (!['up', 'degraded', 'skipped'].includes(status)) return 'skipped';
  if (status === 'skipped') return 'skipped';
  const httpChecks = [checks.httpStatus, checks.continuationHttpStatus,
    ...(Array.isArray(checks.routes) ? checks.routes.map(r => r?.status) : []),
    ...(Array.isArray(checks.sampleRoutes) ? checks.sampleRoutes.map(r => r?.status) : [])];
  if (httpChecks.some(s => typeof s === 'number' && (s === 0 || s >= 500 || [401, 403, 404, 429].includes(s)))) return 'down';
  if (checks.verification === 'unverified' || checks.verification === 'configuration'
    || checks.telemetryFound === false) return 'skipped';
  if (checks.verification === 'partial' && checks.observedFailure === false) return 'skipped';
  // The old notification handler asserted registration without checking anything.
  if (checks.routesRegistered === true && checks.sideEffectSafe === true) return 'skipped';
  const providers = checks.providers ?? checks.inheritedProviders;
  if (providers && typeof providers === 'object') {
    const configured = Object.values(providers).filter((p): p is Record<string, unknown> =>
      !!p && typeof p === 'object' && p.configured === true);
    if (configured.length > 0 && configured.every(p =>
      p.verification === 'configuration' && p.liveProbe === false)) return 'skipped';
  }
  return status as SystemHealthStatus;
}

export function isStatusStale(checkedAt: string | null, now = Date.now()): boolean {
  const at = checkedAt ? Date.parse(checkedAt) : NaN;
  return !Number.isFinite(at) || at > now + 60_000 || now - at > STATUS_STALE_AFTER_MS;
}

export function summarizeObservations(systems: Array<{ status: string; checks: Record<string, unknown> }>) {
  const total = systems.length;
  const observed = systems.filter(s => normalizeHealthStatus(s.status, s.checks) !== 'skipped').length;
  return {
    total,
    observed,
    unverified: total - observed,
    coveragePercent: total ? Math.round(observed / total * 1000) / 10 : null,
  };
}

export function overallHealth(systems: Array<{ status: string; checks: Record<string, unknown> }>): 'healthy' | 'degraded' | 'down' {
  const statuses = systems.map(s => normalizeHealthStatus(s.status, s.checks));
  if (statuses.includes('down')) return 'down';
  if (!statuses.length || statuses.some(s => s !== 'up')) return 'degraded';
  return 'healthy';
}