import { buildHealthResponse, type SystemHealthHandler, type SystemHealthStatus } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

const FRESHNESS_WINDOW_MINUTES = 15;

function envSet(name: string): boolean {
  return !!process.env[name]?.trim();
}

export const integrationsHandler: SystemHealthHandler = {
  systemKey: 'integrations',
  label: 'Integrations',
  async runCheck() {
    const start = Date.now();
    const configured = {
      stripe: envSet('STRIPE_WEBHOOK_SECRET') || envSet('STRIPE_SECRET_KEY'),
      agentmail: envSet('AGENTMAIL_API_KEY') || envSet('AGENTMAIL_WEBHOOK_SECRET')
        || envSet('AGENTMAIL_WEBHOOK_SECRET_MESSAGE_RECEIVED'),
      whatsapp: envSet('TWILIO_ACCOUNT_SID') || envSet('GEAR_TWILIO_ACCOUNT_SID')
        || envSet('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || envSet('WHATSAPP_APP_SECRET')
        || envSet('WHATSAPP_API_TOKEN'),
    };
    // A provider's success cannot verify a different provider. Legacy generic
    // integration telemetry is intentionally not used as execution evidence.
    const providers = await Promise.all(Object.entries(configured).map(async ([provider, isConfigured]) => {
      const telemetryKey = `integrations_${provider}`;
      const telemetry = isConfigured
        ? await getLatestTelemetry(telemetryKey, FRESHNESS_WINDOW_MINUTES / 60)
        : null;
      const ageMs = telemetry ? Date.now() - Date.parse(telemetry.created_at) : NaN;
      const telemetryFresh = Number.isFinite(ageMs)
        && ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MINUTES * 60 * 1000;
      const observed = telemetryFresh && telemetry !== null
        && ['up', 'degraded', 'down'].includes(telemetry.status);
      return {
        provider,
        configured: isConfigured,
        telemetryKey,
        telemetryFound: !!telemetry,
        telemetryFresh,
        lastEventAt: telemetry?.created_at,
        verification: observed ? 'observed' : 'unverified',
        status: observed ? telemetry!.status : 'skipped',
      };
    }));
    const monitored = providers.filter((provider) => provider.configured);
    const observedCount = monitored.filter((provider) => provider.verification === 'observed').length;
    const missingCount = monitored.length - observedCount;
    const observedFailure = monitored.some((provider) => provider.status === 'down' || provider.status === 'degraded');
    const status: SystemHealthStatus = monitored.some((provider) => provider.status === 'down')
      ? 'down'
      : observedCount === 0
        ? 'skipped'
        : missingCount > 0 || monitored.some((provider) => provider.status === 'degraded')
          ? 'degraded'
          : 'up';

    return buildHealthResponse({
      systemKey: 'integrations',
      label: 'Integrations',
      status,
      latencyMs: Date.now() - start,
      summary: status === 'down'
        ? 'An observed integration provider reported a failure'
        : observedCount === 0
          ? 'Integrations unverified: no recent provider-specific webhook receipts'
          : missingCount > 0
            ? `Partial integration evidence: ${observedCount}/${monitored.length} configured providers observed`
            : status === 'degraded'
              ? 'An observed integration provider reported degraded execution'
              : 'Recent webhook acceptance/processing observed for each configured integration provider',
      checks: {
        ...Object.fromEntries(providers.map(({ provider, ...checks }) => [provider, checks])),
        configuredCount: monitored.length,
        observedCount,
        observedFailure,
        verification: observedCount === 0 ? 'unverified' : missingCount > 0 ? 'partial' : 'observed',
        freshnessWindowMinutes: FRESHNESS_WINDOW_MINUTES,
        scope: 'Recent provider-specific webhook acceptance/processing receipts only; not downstream completion or all integration operations',
      },
    });
  },
};
