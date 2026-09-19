import {
  getLatestTelemetry,
  REDIS_TELEMETRY_KEYS,
  type TelemetryRecord,
} from '@/lib/status/telemetry';
import {
  buildHealthResponse,
  type SystemHealthHandler,
  type SystemHealthStatus,
} from '@/lib/status/types';

const TELEMETRY_HISTORY_HOURS = 30 * 24;
const TELEMETRY_STALE_AFTER_MS = 15 * 60 * 1000;

interface QueueTelemetryCheck {
  found: boolean;
  status: SystemHealthStatus | null;
  message: string | null;
  latencyMs: number | null;
  lastEventAt: string | null;
  ageMs: number | null;
  stale: boolean;
}

function queueCheck(
  telemetry: TelemetryRecord | null,
  now: number,
): QueueTelemetryCheck {
  if (!telemetry) {
    return {
      found: false,
      status: null,
      message: null,
      latencyMs: null,
      lastEventAt: null,
      ageMs: null,
      stale: false,
    };
  }

  const createdAt = Date.parse(telemetry.created_at);
  const ageMs = Number.isFinite(createdAt)
    ? Math.max(0, now - createdAt)
    : null;

  return {
    found: true,
    status: telemetry.status,
    message: telemetry.message,
    latencyMs: telemetry.latency_ms,
    lastEventAt: telemetry.created_at,
    ageMs,
    stale: ageMs === null || ageMs > TELEMETRY_STALE_AFTER_MS,
  };
}

function aggregateStatus(
  configured: boolean,
  tracking: QueueTelemetryCheck,
  recordings: QueueTelemetryCheck,
): SystemHealthStatus {
  if (!configured) return 'down';

  const checks = [tracking, recordings];
  const observed = checks.filter((check) => check.found);
  if (observed.length === 0) return 'skipped';
  if (observed.some((check) => check.status === 'down')) return 'down';
  if (
    observed.some((check) => check.status === 'degraded')
    || checks.some((check) => !check.found || check.stale)
  ) {
    return 'degraded';
  }
  return 'up';
}

function statusSummary(status: SystemHealthStatus, configured: boolean): string {
  if (!configured) return 'REDIS_URL is missing';
  switch (status) {
    case 'up':
      return 'Tracking and recording queues are healthy';
    case 'down':
      return 'A Redis-backed queue reported a failure';
    case 'degraded':
      return 'Redis queue telemetry is degraded, incomplete, or stale';
    default:
      return 'Redis configured; awaiting passive queue telemetry';
  }
}

export const redisHandler: SystemHealthHandler = {
  systemKey: 'redis',
  label: 'Redis Queues',
  async runCheck() {
    const start = Date.now();
    const [trackingTelemetry, recordingTelemetry] = await Promise.all([
      getLatestTelemetry(
        REDIS_TELEMETRY_KEYS.tracking,
        TELEMETRY_HISTORY_HOURS,
      ),
      getLatestTelemetry(
        REDIS_TELEMETRY_KEYS.recordings,
        TELEMETRY_HISTORY_HOURS,
      ),
    ]);
    const now = Date.now();
    const tracking = queueCheck(trackingTelemetry, now);
    const recordings = queueCheck(recordingTelemetry, now);
    const configured = !!process.env.REDIS_URL?.trim();
    const status = aggregateStatus(configured, tracking, recordings);
    const observedLatency = Math.max(
      tracking.latencyMs ?? 0,
      recordings.latencyMs ?? 0,
    );

    return buildHealthResponse({
      systemKey: 'redis',
      label: 'Redis Queues',
      status,
      latencyMs: observedLatency || now - start,
      summary: statusSummary(status, configured),
      checks: {
        configured,
        staleAfterMinutes: TELEMETRY_STALE_AFTER_MS / 60_000,
        tracking,
        recordings,
      },
    });
  },
};
