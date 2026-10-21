import { buildHealthResponse, type SystemHealthHandler, type SystemHealthStatus } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';
import { getTransactionalEmailProvider, getTransactionalEmailConfigurationDiagnostic } from '@/lib/services/email/transactional-email-config';

const FRESHNESS_WINDOW_MINUTES = 15;

export const notificationsHandler: SystemHealthHandler = {
  systemKey: 'notifications',
  label: 'Notifications',
  async runCheck() {
    const start = Date.now();
    let transactionalProvider: string = 'invalid';
    try { transactionalProvider = getTransactionalEmailProvider(); } catch { /* Bounded label only. */ }
    const transactionalConfigured = getTransactionalEmailConfigurationDiagnostic() === null;
    const smtpConfigured = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].every(name => !!process.env[name]?.trim());
    // Explicit but broken configuration must not disappear behind in-app success.
    const emailConfigurationPresent = ['TRANSACTIONAL_EMAIL_PROVIDER', 'SENDGRID_API_KEY', 'ZAVUDEV_API_KEY',
      'EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'].some(name => !!process.env[name]?.trim());
    const emailConfigured = transactionalConfigured || smtpConfigured;
    // Never use a generic notification receipt to attest either independent
    // capability. These reads do not probe persistence or trigger email sends.
    const channels = await Promise.all(['in_app', 'email'].map(async channel => {
      const telemetryKey = `notifications_${channel}`;
      const telemetry = await getLatestTelemetry(telemetryKey, FRESHNESS_WINDOW_MINUTES / 60).catch(() => null);
      const ageMs = telemetry ? Date.now() - Date.parse(telemetry.created_at) : NaN;
      const telemetryFresh = Number.isFinite(ageMs)
        && ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MINUTES * 60 * 1000;
      const observed = telemetryFresh && telemetry !== null
        && ['up', 'degraded', 'down'].includes(telemetry.status);
      return {
        channel,
        expected: channel === 'in_app' || emailConfigurationPresent || emailConfigured || observed,
        configured: channel === 'in_app' || emailConfigured,
        telemetryKey,
        telemetryFound: !!telemetry,
        telemetryFresh,
        lastEventAt: telemetry?.created_at,
        verification: observed ? 'observed' : 'unverified',
        status: observed ? telemetry!.status : 'skipped',
        latencyMs: observed ? telemetry!.latency_ms : null,
        scope: channel === 'in_app' ? 'Actual notification insert results; not UI display or reads'
          : 'Provider recipient acceptance; not confirmed mailbox delivery',
      };
    }));
    const expected = channels.filter(channel => channel.expected);
    const observedCount = expected.filter(channel => channel.verification === 'observed').length;
    const missingCount = expected.length - observedCount;
    const observedFailure = expected.some(channel => channel.status === 'down' || channel.status === 'degraded');
    const status: SystemHealthStatus = expected.some(channel => channel.status === 'down') ? 'down'
      : observedCount === 0 ? 'skipped'
        : missingCount > 0 || observedFailure ? 'degraded' : 'up';
    const observedLatencies = expected.flatMap(channel => channel.latencyMs === null ? [] : [channel.latencyMs]);
    return buildHealthResponse({
      systemKey: 'notifications',
      label: 'Notifications',
      status,
      latencyMs: observedLatencies.length ? Math.max(...observedLatencies) : Date.now() - start,
      summary: status === 'down' ? 'Observed notification persistence or email acceptance failed'
        : observedCount === 0 ? 'Notifications unverified: no recent independent execution receipts'
          : missingCount > 0 ? `Partial notification evidence: ${observedCount}/${expected.length} expected capabilities observed`
            : status === 'degraded' ? 'Observed partial notification persistence or email acceptance'
              : 'Recent persistence/provider acceptance observed for every expected notification capability',
      checks: {
        ...Object.fromEntries(channels.map(({ channel, ...checks }) => [channel, checks])),
        expectedCount: expected.length,
        observedCount,
        observedFailure,
        verification: observedCount === 0 ? 'unverified' : missingCount > 0 ? 'partial' : 'observed',
        telemetryFound: channels.some(channel => channel.telemetryFound),
        telemetryFresh: observedCount > 0,
        transactionalProvider,
        transactionalConfigured,
        smtpConfigured,
        freshnessWindowMinutes: FRESHNESS_WINDOW_MINUTES,
        sideEffectSafe: true,
        scope: 'Independent in-app persistence and provider email acceptance receipts; no mailbox delivery or all-send coverage',
        note: 'No notification routes, database writes, SMTP verification or provider health/network probes are invoked',
      },
    });
  },
};
