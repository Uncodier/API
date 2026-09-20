import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  computeOverallSla,
  computeSlaBySystem,
  type SlaWindow,
} from '@/lib/status/compute-sla';
import { sanitizePublicPayload } from '@/lib/status/types';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';
import {
  acquireLock,
  getCachedJson,
  releaseLock,
  setCachedJson,
} from '@/lib/security/upstash-rest';

const STATUS_SUMMARY_CACHE_KEY = 'cache:status:public-summary:v1';
const STATUS_SUMMARY_STALE_CACHE_KEY = 'cache:status:public-summary:stale:v1';
const STATUS_SUMMARY_CACHE_SECONDS = 30;
const STATUS_SUMMARY_STALE_CACHE_SECONDS = 60 * 60;
const STATUS_SUMMARY_LOCK_KEY = 'lock:status:public-summary';
const STATUS_SUMMARY_RETRY_ATTEMPTS = 6;
const STATUS_SUMMARY_RETRY_DELAY_MS = 250;

export interface PublicSystemCard {
  systemKey: string;
  label: string;
  status: string;
  summary: string;
  latencyMs: number;
  checkedAt: string;
  checks: Record<string, unknown>;
  sla?: SlaWindow;
}

export interface PublicStatusSummary {
  overall: 'operational' | 'degraded' | 'down';
  overallSla24h: number | null;
  lastRunAt: string | null;
  lastTrigger: string | null;
  systems: PublicSystemCard[];
  slaBySystem: Record<string, SlaWindow>;
}

async function waitForRefreshedSummary(): Promise<PublicStatusSummary | null> {
  for (let attempt = 0; attempt < STATUS_SUMMARY_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, STATUS_SUMMARY_RETRY_DELAY_MS);
      });
    }
    const refreshed = await getCachedJson<PublicStatusSummary>(
      STATUS_SUMMARY_CACHE_KEY,
    );
    if (refreshed) return refreshed;
    const stale = await getCachedJson<PublicStatusSummary>(
      STATUS_SUMMARY_STALE_CACHE_KEY,
    );
    if (stale) return stale;
  }
  return null;
}

export async function getPublicSummary(): Promise<PublicStatusSummary> {
  const cached = await getCachedJson<PublicStatusSummary>(
    STATUS_SUMMARY_CACHE_KEY,
  );
  if (cached) return cached;
  const stale = await getCachedJson<PublicStatusSummary>(
    STATUS_SUMMARY_STALE_CACHE_KEY,
  );
  const lock = await acquireLock(STATUS_SUMMARY_LOCK_KEY, 15);
  if (lock.state === 'contended') {
    if (stale) return stale;
    const refreshed = await waitForRefreshedSummary();
    if (refreshed) return refreshed;
    throw new Error('Status summary refresh is already in progress');
  }
  const lockToken = lock.state === 'acquired' ? lock.token : null;

  try {
    const slaBySystem: Record<string, SlaWindow> =
      await computeSlaBySystem();
    const overallSla24h = computeOverallSla(slaBySystem);

    const { data: latestRun, error: latestRunError } = await supabaseAdmin
      .from('system_status_runs')
      .select('id, overall_status, trigger, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestRunError) {
      throw new Error(`Failed to load latest system status run: ${latestRunError.message}`);
    }

    if (!latestRun) {
      const emptySummary: PublicStatusSummary = {
        overall: 'degraded',
        overallSla24h,
        lastRunAt: null,
        lastTrigger: null,
        systems: [],
        slaBySystem,
      };
      await setCachedJson(
        STATUS_SUMMARY_CACHE_KEY,
        emptySummary,
        STATUS_SUMMARY_CACHE_SECONDS,
      );
      await setCachedJson(
        STATUS_SUMMARY_STALE_CACHE_KEY,
        emptySummary,
        STATUS_SUMMARY_STALE_CACHE_SECONDS,
      );
      return emptySummary;
    }

    const { data: checks, error: checksError } = await supabaseAdmin
      .from('system_status')
      .select('system_key, status, summary, latency_ms, health_payload, created_at')
      .eq('run_id', latestRun.id)
      .order('system_key');
    if (checksError) {
      throw new Error(`Failed to load system status checks: ${checksError.message}`);
    }

    const systems: PublicSystemCard[] = (checks ?? []).map((row) => {
      const payload = (row.health_payload as Record<string, unknown>) ?? {};
      return {
        systemKey: row.system_key,
        label: SYSTEM_LABELS[row.system_key] ?? row.system_key,
        status: row.status,
        summary: row.summary ?? '',
        latencyMs: row.latency_ms ?? 0,
        checkedAt: row.created_at,
        checks: sanitizePublicPayload((payload.checks as Record<string, unknown>) ?? payload),
        sla: slaBySystem[row.system_key],
      };
    });

    const overallMap = {
      healthy: 'operational' as const,
      degraded: 'degraded' as const,
      down: 'down' as const,
    };

    const summary: PublicStatusSummary = {
      overall: overallMap[latestRun.overall_status as keyof typeof overallMap] ?? 'degraded',
      overallSla24h,
      lastRunAt: latestRun.created_at,
      lastTrigger: latestRun.trigger,
      systems,
      slaBySystem,
    };
    await setCachedJson(
      STATUS_SUMMARY_CACHE_KEY,
      summary,
      STATUS_SUMMARY_CACHE_SECONDS,
    );
    await setCachedJson(
      STATUS_SUMMARY_STALE_CACHE_KEY,
      summary,
      STATUS_SUMMARY_STALE_CACHE_SECONDS,
    );
    return summary;
  } catch (error) {
    const fallback = stale ?? await getCachedJson<PublicStatusSummary>(
      STATUS_SUMMARY_STALE_CACHE_KEY,
    );
    if (fallback) return fallback;
    throw error;
  } finally {
    if (lockToken) {
      await releaseLock(STATUS_SUMMARY_LOCK_KEY, lockToken);
    }
  }
}
