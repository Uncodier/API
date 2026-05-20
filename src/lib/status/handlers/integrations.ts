import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';

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
        configured: envSet('TWILIO_ACCOUNT_SID') || envSet('GEAR_TWILIO_ACCOUNT_SID'),
      },
      vercel: { webhookSecretSet: envSet('VERCEL_WEBHOOK_SECRET') },
    };
    const configuredCount = Object.values(checks).filter(
      (c) => Object.values(c).some(Boolean),
    ).length;
    return buildHealthResponse({
      systemKey: 'integrations',
      label: 'Integrations',
      status: configuredCount > 0 ? 'up' : 'degraded',
      latencyMs: Date.now() - start,
      summary: `${configuredCount} integration group(s) configured`,
      checks,
    });
  },
};
