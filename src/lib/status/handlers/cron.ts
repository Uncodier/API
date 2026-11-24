import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';
import { CRON_JOBS, cronTelemetryKey } from '@/lib/status/cron-observation';
import { CATALOG_INDEX_QUEUE_FRESHNESS_MS, CATALOG_INDEX_QUEUE_TELEMETRY, catalogIndexQueueEvidence } from '@/lib/status/catalog-index-evidence';

export const cronHandler: SystemHealthHandler = {
  systemKey: 'cron',
  label: 'Cron Jobs',
  async runCheck() {
    const start = Date.now();
    const secret = process.env.CRON_SECRET?.trim();
    const catalogEnabled = process.env.CATALOG_INDEXING_ENABLED === 'true';
    const catalogReceipt = catalogEnabled
      ? getLatestTelemetry(CATALOG_INDEX_QUEUE_TELEMETRY, CATALOG_INDEX_QUEUE_FRESHNESS_MS * 2 / 3_600_000).catch(() => null)
      : null;
    // Never invoke a cron to test it. Keep evidence independent by scheduled job.
    const jobs = Object.fromEntries(await Promise.all(CRON_JOBS.map(async job => {
      const disabled = 'enabledEnv' in job && process.env[job.enabledEnv] !== 'true';
      const telemetryKey = cronTelemetryKey(job.key);
      // Two freshness windows allow a recently stale receipt to be identified;
      // the daily retention job needs more than the default 24-hour lookback.
      const telemetry = disabled ? null : await getLatestTelemetry(telemetryKey, job.freshnessMs * 2 / 3_600_000);
      const at = telemetry ? Date.parse(telemetry.created_at) : NaN;
      const now = Date.now();
      const fresh = Number.isFinite(at) && at <= now && now - at <= job.freshnessMs;
      const observed = fresh && !!telemetry && ['up', 'degraded', 'down'].includes(telemetry.status);
      return [job.key, {
        status: observed ? telemetry!.status : 'skipped',
        lastEventAt: telemetry?.created_at ?? null,
        cadenceMs: job.cadenceMs,
        freshnessMs: job.freshnessMs,
        schedule: job.schedule,
        telemetryKey,
        disabled,
        expected: !disabled,
        verification: observed ? 'passive' : 'unverified',
        reason: observed ? null : disabled ? 'disabled' : !telemetry ? 'missing_receipt' : !fresh ? 'stale_receipt' : 'unverified_receipt',
      }] as const;
    })));
    const catalogIndexQueue = catalogIndexQueueEvidence(catalogEnabled, await catalogReceipt, Date.now());
    const expected = Object.values(jobs).filter(job => job.expected);
    const observed = expected.filter(job => job.verification === 'passive');
    const unknown = expected.length - observed.length;
    const observedFailure = catalogIndexQueue.status === 'degraded' || observed.some(job => job.status !== 'up');
    const hasEvidence = observed.length > 0 || catalogIndexQueue.status !== 'skipped';
    const incomplete = unknown > 0 || (catalogEnabled && catalogIndexQueue.status === 'skipped');
    const status = observed.some(job => job.status === 'down') ? 'down'
      : !hasEvidence ? 'skipped'
      : incomplete || observedFailure || !secret ? 'degraded' : 'up';
    const degradedReasons = [
      ...expected.filter(job => job.verification !== 'passive').map(job => `${job.telemetryKey}_${job.reason}`),
      ...observed.filter(job => job.status !== 'up').map(job => `${job.telemetryKey}_${job.status}`),
      ...(catalogEnabled && catalogIndexQueue.reason ? [`catalog_index_queue_${catalogIndexQueue.reason}`] : []),
      ...(!secret ? ['cron_secret_missing'] : []),
    ];
    return buildHealthResponse({
      systemKey: 'cron',
      label: 'Cron Jobs',
      status,
      latencyMs: Date.now() - start,
      summary: catalogIndexQueue.reason === 'exhausted' ? 'Catalog embedding jobs are exhausted; operator review required'
        : catalogIndexQueue.reason === 'unavailable' ? 'Unable to verify exhausted catalog embedding jobs'
        : observed.length === 0 ? 'No fresh cron execution receipts; execution unverified'
        : `${observed.length}/${expected.length} scheduled jobs have fresh execution/dispatch receipts; downstream completion unverified`,
      checks: {
        telemetryFound: hasEvidence,
        cronSecretSet: !!secret,
        verification: !hasEvidence ? 'unverified' : incomplete ? 'partial' : 'passive',
        evidenceScope: 'execution_or_dispatch_not_downstream_completion',
        monitorExcluded: true,
        expectedJobs: expected.length,
        observedJobs: observed.length,
        unknownJobs: unknown,
        observedFailure,
        catalogIndexQueue,
        jobs,
      },
      degradedReasons,
    });
  },
};
