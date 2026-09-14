import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

function envSet(name: string): boolean {
  return !!process.env[name]?.trim();
}

export const integrationsHandler: SystemHealthHandler = {
  systemKey: 'integrations',
  label: 'Integrations',
  async runCheck() {
    const start = Date.now();
    const checks = {
      stripe: { webhookSecretSet: envSet('STRIPE_WEBHOOK_SECRET') || envSet('STRIPE_SECRET_KEY') },
      agentmail: { configured: envSet('AGENTMAIL_API_KEY') || envSet('AGENTMAIL_WEBHOOK_SECRET') },
      whatsapp: {
        configured: envSet('TWILIO_ACCOUNT_SID') || envSet('GEAR_TWILIO_ACCOUNT_SID') || envSet('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
      },
      vercel: { webhookSecretSet: envSet('VERCEL_WEBHOOK_SECRET') },
    };
    const configuredCount = Object.values(checks).filter(
      (c) => Object.values(c).some(Boolean),
    ).length;
    
    // Read from passive telemetry
    const telemetry = await getLatestTelemetry('integrations');
    
    const latencyMs = Date.now() - start;
    const isConfigured = configuredCount > 0;
    
    const status = telemetry ? telemetry.status : (isConfigured ? 'up' : 'degraded');
    
    return buildHealthResponse({
      systemKey: 'integrations',
      label: 'Integrations',
      status,
      latencyMs: telemetry?.latency_ms || latencyMs,
      summary: telemetry ? telemetry.message : (isConfigured ? `Assuming healthy (${configuredCount} configured, no recent traffic)` : 'No integrations configured'),
      checks: {
        ...checks,
        telemetryFound: !!telemetry,
        lastEventAt: telemetry?.created_at,
      },
    });
  },
};
