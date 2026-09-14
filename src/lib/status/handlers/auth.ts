import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

export const apiAuthHandler: SystemHealthHandler = {
  systemKey: 'api_auth',
  label: 'API Authentication',
  async runCheck() {
    const start = Date.now();
    const serviceKeySet = !!process.env.SERVICE_API_KEY?.trim();
    
    // Read from passive telemetry instead of doing active HTTP probes
    const telemetry = await getLatestTelemetry('api_auth');
    
    const latencyMs = Date.now() - start;
    
    // If we have a recent telemetry record, use its status.
    // If not, assume 'up' if the service key is set.
    const status = telemetry ? telemetry.status : (serviceKeySet ? 'up' : 'degraded');
    
    return buildHealthResponse({
      systemKey: 'api_auth',
      label: 'API Authentication',
      status,
      latencyMs: telemetry?.latency_ms || latencyMs,
      summary: telemetry ? telemetry.message : (serviceKeySet ? 'Assuming healthy (no recent traffic)' : 'Service key missing'),
      checks: {
        serviceKeySet,
        telemetryFound: !!telemetry,
        lastEventAt: telemetry?.created_at,
      },
      probePath: '/api/status',
    });
  },
};
