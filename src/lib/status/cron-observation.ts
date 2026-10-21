import { createHash, timingSafeEqual } from 'node:crypto';
import { recordTelemetry } from '@/lib/status/telemetry';
import type { SystemHealthStatus } from '@/lib/status/types';

const MINUTE = 60_000;

/** Scheduled execution/dispatch receipts, not evidence of downstream completion.
 * The status monitor is deliberately excluded: it cannot attest to itself.
 */
export const CRON_JOBS = [
  { key: 'catalog-index', path: '/api/cron/catalog-index', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE, enabledEnv: 'CATALOG_INDEXING_ENABLED' },
  { key: 'marketplace', path: '/api/cron/marketplace', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'credit-auto-top-up', path: '/api/cron/credit-auto-top-up', schedule: '*/5 * * * *', cadenceMs: 5 * MINUTE, freshnessMs: 15 * MINUTE },
  { key: 'requirements-apps', path: '/api/cron/requirements-apps', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'sandbox-housekeeping', path: '/api/cron/maintenance/sandbox-housekeeping', schedule: '*/15 * * * *', cadenceMs: 15 * MINUTE, freshnessMs: 45 * MINUTE },
  { key: 'session-events', path: '/api/cron/maintenance/session-events', schedule: '17 3 * * *', cadenceMs: 24 * 60 * MINUTE, freshnessMs: 26 * 60 * MINUTE },
  { key: 'session-recordings', path: '/api/cron/maintenance/session-recordings', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'tracking-events', path: '/api/cron/maintenance/tracking-events', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'workflows', path: '/api/cron/workflows', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'assistant-respawn', path: '/api/cron/assistant-respawn', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'pending-work', path: '/api/cron/pending-work', schedule: '* * * * *', cadenceMs: MINUTE, freshnessMs: 3 * MINUTE },
  { key: 'record-embeddings', path: '/api/cron/record-embeddings', schedule: '*/5 * * * *', cadenceMs: 5 * MINUTE, freshnessMs: 15 * MINUTE },
] as const;

export type CronJobKey = (typeof CRON_JOBS)[number]['key'];

export function cronTelemetryKey(jobKey: CronJobKey): string {
  return `cron_${jobKey}`;
}

const MAX_RECEIPT_BYTES = 65_536;
const INSPECTION_TIMEOUT_MS = 250;

/** Bound both bytes and waiting time. Never consume the response returned to Next. */
async function inspectJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.includes('application/json')) return null;
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_RECEIPT_BYTES) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let size = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RECEIPT_BYTES) return null;
          chunks.push(value);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown> : null;
      })(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), INSPECTION_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Awaiting cancellation of a cloned/teed stream can wait for the original consumer.
    void reader.cancel().catch(() => {});
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hasFailures(summary: Record<string, unknown>): boolean {
  if (summary.success === false) return true;
  return Object.entries(summary).some(([key, value]) => {
    if (!/^(?:error|errors|failed|failures|deadLetters)$|Errors$/.test(key)) return false;
    return typeof value === 'number' ? value > 0
      : Array.isArray(value) ? value.length > 0 : !!value;
  });
}

function resultFailed(jobKey: CronJobKey, result: Record<string, unknown>): boolean {
  if (hasFailures(result) || result.started === false) return true;
  const status = result.status;
  if (typeof status === 'string' && /failed|error|^reverted:/.test(status)) return true;
  // These are the workflow scheduler's only intentional skip values. Other
  // `skipped` strings contain caught dispatch errors and must not assert success.
  if (jobKey === 'workflows' && typeof result.skipped === 'string'
    && !['missing_cron', 'not_due', 'duplicate'].includes(result.skipped)) return true;
  return jobKey === 'credit-auto-top-up' && result.outcome === 'needs_reconciliation';
}

async function receiptStatus(jobKey: CronJobKey, response: Response): Promise<SystemHealthStatus> {
  if (response.status >= 500) return 'down';
  if (!response.ok) return 'degraded';
  if (response.status === 204 || response.status === 205) return 'up';
  const body = await inspectJson(response);
  if (!body || body.disabled === true) return 'skipped';
  if (hasFailures(body)) return 'degraded';
  const result = object(body.result) ?? object(body.results);
  if (result && hasFailures(result)) return 'degraded';
  if (Array.isArray(body.results) && body.results.some(item => {
    const entry = object(item);
    return entry ? resultFailed(jobKey, entry) : false;
  })) return 'degraded';
  if (jobKey === 'marketplace' && typeof body.unavailable === 'number' && body.unavailable > 0) return 'degraded';
  return 'up';
}

/** Authenticate before executing business code; await best-effort telemetry.
 * A 2xx receipt attests only to the cron invocation/accepted dispatch, never a
 * background workflow's end-to-end success. Body data and exceptions are not logged.
 */
export function withCronObservation<RequestType extends Request, Context extends unknown[]>(
  jobKey: CronJobKey,
  handler: (request: RequestType, ...context: Context) => Promise<Response>,
): (request: RequestType, ...context: Context) => Promise<Response> {
  return async (request, ...context) => {
    const secret = process.env.CRON_SECRET;
    if (!secret?.trim()) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const digest = (value: string) => createHash('sha256').update(value).digest();
    const authorization = digest(request.headers.get('authorization') || '');
    // Preserve legacy handlers that compare the raw secret, as well as those
    // that trim it. Neither form accepts an absent or whitespace-only secret.
    if (!timingSafeEqual(authorization, digest(`Bearer ${secret.trim()}`))
      && !timingSafeEqual(authorization, digest(`Bearer ${secret}`))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const start = Date.now();
    const emit = async (status: SystemHealthStatus, message: string) => {
      try { await recordTelemetry(cronTelemetryKey(jobKey), status, message, Date.now() - start); }
      catch { /* Observation must not alter the business response or exception. */ }
    };
    let response: Response;
    try {
      response = await handler(request, ...context);
    } catch (error) {
      await emit('down', 'Cron execution threw before returning');
      throw error;
    }
    // A handler-level authorization rejection is not execution evidence either.
    if (response.status === 401 || response.status === 403) return response;
    let status: SystemHealthStatus = 'skipped';
    try { status = await receiptStatus(jobKey, response); } catch { /* Uninspectable is unverified. */ }
    if (status !== 'skipped') {
      await emit(status, status === 'up'
        ? 'Cron execution completed or dispatch accepted; downstream completion unverified'
        : status === 'down' ? 'Cron execution returned a server failure' : 'Cron execution reported errors or was not accepted');
    }
    return response;
  };
}