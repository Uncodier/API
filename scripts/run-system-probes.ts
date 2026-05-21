#!/usr/bin/env npx tsx
/**
 * Run all system health probes and persist to system_status.
 * Usage: npm run status:probe
 *
 * CI (STATUS_PROBE_CI_LENIENT=true): fails only on database_main + env_core.
 * Strict (default for cron/manual): all CRITICAL_SYSTEM_KEYS including AI.
 */
import { persistProbeRun } from '../src/lib/status/persist-status.ts';
import { runChecksOnly, validateCriticalSystems } from '../src/lib/status/run-probes.ts';

const trigger = (process.env.STATUS_PROBE_TRIGGER as 'github_push' | 'cron_hourly' | 'manual') || 'github_push';
const ciLenient = process.env.STATUS_PROBE_CI_LENIENT === 'true' || process.env.CI === 'true';

async function main() {
  console.log(`[status:probe] Starting probes (trigger=${trigger}, ciLenient=${ciLenient})`);

  const { systems, durationMs } = await runChecksOnly(trigger);

  console.log(`[status:probe] Probe round finished in ${durationMs}ms`);
  for (const s of systems) {
    const flag = s.status === 'up' ? '✓' : s.status === 'skipped' ? '○' : '✗';
    console.log(`  ${flag} ${s.systemKey}: ${s.status} — ${s.summary}`);
  }

  let runId: string | null = null;
  try {
    const persisted = await persistProbeRun(trigger, systems, durationMs);
    runId = persisted.runId;
    console.log(`[status:probe] Persisted run ${runId} (overall: ${persisted.overallStatus})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[status:probe] Failed to persist to system_status:', msg);
    console.error(
      '[status:probe] Ensure src/scripts/create_system_status_tables.sql was applied in Supabase.',
    );
    if (!ciLenient) {
      process.exit(1);
    }
  }

  const { ok, failures, warnings } = validateCriticalSystems(systems, { ciLenient });

  if (warnings.length > 0) {
    console.warn('[status:probe] Non-blocking warnings (strict-only checks):');
    for (const w of warnings) {
      console.warn(`  ⚠ ${w}`);
    }
    console.warn(
      '[status:probe] Set GitHub secrets (AI keys, STATUS_PROBE_BASE_URL) and STATUS_PROBE_CI_LENIENT=false for full strict CI.',
    );
  }

  if (!ok) {
    console.error('[status:probe] Blocking failures:');
    for (const f of failures) {
      console.error(`  ✗ ${f}`);
    }
    process.exit(1);
  }

  console.log('[status:probe] Passed' + (runId ? ` (run ${runId})` : ' (probes only, persist skipped)'));
}

main().catch((err) => {
  console.error('[status:probe] Fatal:', err);
  process.exit(1);
});
