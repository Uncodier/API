import { supabaseAdmin } from '@/lib/database/supabase-client';
import { computeOverallSla, computeSlaBySystem } from '@/lib/status/compute-sla';
import { sanitizePublicPayload } from '@/lib/status/types';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';

export interface PublicSystemCard {
  systemKey: string;
  label: string;
  status: string;
  summary: string;
  latencyMs: number;
  checkedAt: string;
  checks: Record<string, unknown>;
  sla?: { uptime24h: number; uptime7d: number; uptime30d: number };
}

export interface PublicStatusSummary {
  overall: 'operational' | 'degraded' | 'down';
  overallSla24h: number;
  lastRunAt: string | null;
  lastTrigger: string | null;
  systems: PublicSystemCard[];
  slaBySystem: Record<string, { uptime24h: number; uptime7d: number; uptime30d: number }>;
}

export async function getPublicSummary(): Promise<PublicStatusSummary> {
  const slaBySystem = await computeSlaBySystem().catch(() => ({}));
  const overallSla24h = computeOverallSla(slaBySystem);

  const { data: latestRun } = await supabaseAdmin
    .from('system_status_runs')
    .select('id, overall_status, trigger, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRun) {
    return {
      overall: 'degraded',
      overallSla24h,
      lastRunAt: null,
      lastTrigger: null,
      systems: [],
      slaBySystem,
    };
  }

  const { data: checks } = await supabaseAdmin
    .from('system_status')
    .select('system_key, status, summary, latency_ms, health_payload, created_at')
    .eq('run_id', latestRun.id)
    .order('system_key');

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

  return {
    overall: overallMap[latestRun.overall_status as keyof typeof overallMap] ?? 'degraded',
    overallSla24h,
    lastRunAt: latestRun.created_at,
    lastTrigger: latestRun.trigger,
    systems,
    slaBySystem,
  };
}
