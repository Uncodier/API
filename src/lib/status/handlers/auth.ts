import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

const FRESHNESS_WINDOW_MINUTES = 15;

export const apiAuthHandler: SystemHealthHandler = {
  systemKey: 'api_auth',
  label: 'API Authentication',
  async runCheck() {
    const start = Date.now();
    const serviceKeySet = !!process.env.SERVICE_API_KEY?.trim();
    
    // Configuration alone is not evidence of successful authentication.
    const telemetry = await getLatestTelemetry('api_auth', FRESHNESS_WINDOW_MINUTES / 60);
    const ageMs = telemetry ? Date.now() - Date.parse(telemetry.created_at) : NaN;
    const telemetryFresh = Number.isFinite(ageMs)
      && ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MINUTES * 60 * 1000;
    const observed = telemetryFresh && telemetry !== null
      && ['up', 'degraded', 'down'].includes(telemetry.status);
    
    return buildHealthResponse({
      systemKey: 'api_auth',
      label: 'API Authentication',
      status: observed ? telemetry!.status : 'skipped',
      latencyMs: observed ? telemetry!.latency_ms : Date.now() - start,
      summary: observed
        ? telemetry!.message || 'Recent authentication event observed'
        : 'Authentication unverified: no recent passive execution evidence',
      checks: {
        serviceKeySet,
        telemetryFound: !!telemetry,
        telemetryFresh,
        lastEventAt: telemetry?.created_at,
        freshnessWindowMinutes: FRESHNESS_WINDOW_MINUTES,
        verification: observed ? 'observed' : 'unverified',
        scope: 'Recent authentication events only; no active authentication probe',
      },
    });
  },
};
