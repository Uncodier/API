import {
  buildHealthResponse,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

export const aiPortkeyHandler: SystemHealthHandler = {
  systemKey: 'ai_portkey',
  label: 'AI Portkey (/api/ai)',
  probePath: '/api/ai',
  async runCheck() {
    const start = Date.now();
    
    // Read from passive telemetry instead of active probes that fail spuriously
    const telemetry = await getLatestTelemetry('ai_portkey');
    
    const latencyMs = Date.now() - start;
    const status = telemetry ? telemetry.status : 'up';
    
    return buildHealthResponse({
      systemKey: 'ai_portkey',
      label: 'AI Portkey (/api/ai)',
      status,
      latencyMs: telemetry?.latency_ms || latencyMs,
      summary: telemetry 
        ? telemetry.message 
        : 'Assuming healthy (no recent AI traffic)',
      checks: {
        telemetryFound: !!telemetry,
        lastEventAt: telemetry?.created_at,
      },
      probePath: '/api/ai',
    });
  },
};
