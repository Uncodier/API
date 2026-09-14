import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

export const cronHandler: SystemHealthHandler = {
  systemKey: 'cron',
  label: 'Cron Jobs',
  async runCheck() {
    const start = Date.now();
    const secret = process.env.CRON_SECRET?.trim();
    
    // Read from passive telemetry instead of doing active HTTP probes
    const telemetry = await getLatestTelemetry('cron');
    
    const latencyMs = Date.now() - start;
    const status = telemetry ? telemetry.status : (secret ? 'up' : 'degraded');
    
    return buildHealthResponse({
      systemKey: 'cron',
      label: 'Cron Jobs',
      status,
      latencyMs: telemetry?.latency_ms || latencyMs,
      summary: telemetry ? telemetry.message : (secret ? 'Assuming healthy (no recent traffic)' : 'Cron secret missing'),
      checks: {
        telemetryFound: !!telemetry,
        lastEventAt: telemetry?.created_at,
        cronSecretSet: !!secret,
      },
    });
  },
};
