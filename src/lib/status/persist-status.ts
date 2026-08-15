import { supabaseAdmin } from '@/lib/database/supabase-client';
import { computeOverallSla, computeSlaBySystem } from '@/lib/status/compute-sla';
import type { PublicStatusSummary } from '@/lib/status/get-public-summary';
import { publishSystemStatus } from '@/lib/status/publish-status';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';
import {
  sanitizePublicPayload,
  type ProbeRunResult,
  type ProbeTrigger,
  type SystemHealthResponse,
} from '@/lib/status/types';

function toPublicSummary(
  trigger: ProbeTrigger,
  overallStatus: 'healthy' | 'degraded' | 'down',
  systems: SystemHealthResponse[],
  slaSnapshot: Record<string, { uptime24h: number; uptime7d: number; uptime30d: number }>,
): PublicStatusSummary {
  const overallMap = {
    healthy: 'operational',
    degraded: 'degraded',
    down: 'down',
  } as const;
  return {
    overall: overallMap[overallStatus],
    overallSla24h: computeOverallSla(slaSnapshot),
    lastRunAt: new Date().toISOString(),
    lastTrigger: trigger,
    systems: systems.map((s) => ({
      systemKey: s.systemKey,
      label: s.label || SYSTEM_LABELS[s.systemKey] || s.systemKey,
      status: s.status,
      summary: s.summary,
      latencyMs: s.latencyMs,
      checkedAt: s.checkedAt,
      checks: sanitizePublicPayload(s.checks ?? {}),
      sla: slaSnapshot[s.systemKey],
    })),
    slaBySystem: slaSnapshot,
  };
}

function overallFromSystems(
  systems: SystemHealthResponse[],
): 'healthy' | 'degraded' | 'down' {
  if (systems.some((s) => s.status === 'down')) return 'down';
  if (systems.some((s) => s.status === 'degraded')) return 'degraded';
  return 'healthy';
}

export async function persistProbeRun(
  trigger: ProbeTrigger,
  systems: SystemHealthResponse[],
  durationMs: number,
): Promise<ProbeRunResult> {
  const slaSnapshot = await computeSlaBySystem().catch(() => ({}));
  const overallStatus = overallFromSystems(systems);
  const checksPassed = systems.filter((s) => s.status === 'up').length;
  const checksFailed = systems.filter((s) => s.status === 'down').length;
  const checksDegraded = systems.filter((s) => s.status === 'degraded').length;

  const { data: run, error: runError } = await supabaseAdmin
    .from('system_status_runs')
    .insert({
      trigger,
      environment: process.env.NODE_ENV || 'development',
      overall_status: overallStatus,
      sla_snapshot: slaSnapshot,
      checks_passed: checksPassed,
      checks_failed: checksFailed,
      checks_degraded: checksDegraded,
      duration_ms: durationMs,
    })
    .select('id')
    .single();

  if (runError || !run) {
    throw new Error(`Failed to persist system_status_run: ${runError?.message}`);
  }

  const rows = systems.map((s) => ({
    run_id: run.id,
    trigger,
    system_key: s.systemKey,
    status: s.status,
    summary: s.summary,
    probe_path: s.probePath ?? null,
    latency_ms: s.latencyMs,
    error_message: s.error?.message ?? null,
    health_payload: sanitizePublicPayload({
      summary: s.summary,
      checks: s.checks,
      degradedReasons: s.degradedReasons,
      checkedAt: s.checkedAt,
      error: s.error,
    }),
  }));

  const { error: checksError } = await supabaseAdmin.from('system_status').insert(rows);
  if (checksError) {
    throw new Error(`Failed to persist system_status: ${checksError.message}`);
  }

  const result: ProbeRunResult = {
    runId: run.id,
    trigger,
    overallStatus,
    durationMs,
    systems,
    slaSnapshot,
  };

  try {
    await publishSystemStatus(toPublicSummary(trigger, overallStatus, systems, slaSnapshot));
  } catch (error) {
    console.warn('[system-status] broadcast after persist failed:', error);
  }

  return result;
}
