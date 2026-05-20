#!/usr/bin/env npx tsx
/**
 * Run all system health probes and persist to system_status.
 * Usage: npm run status:probe
 * Exit 1 if any critical system is down or degraded.
 */
import { runProbes, validateCriticalSystems } from '../src/lib/status/run-probes.ts';

const trigger = (process.env.STATUS_PROBE_TRIGGER as 'github_push' | 'cron_hourly' | 'manual') || 'github_push';

async function main() {
  console.log(`[status:probe] Starting probes (trigger=${trigger})`);
  const result = await runProbes(trigger);
  const { ok, failures } = validateCriticalSystems(result);

  console.log(`[status:probe] Overall: ${result.overallStatus} (${result.durationMs}ms)`);
  console.log(`[status:probe] Run ID: ${result.runId}`);
  for (const s of result.systems) {
    console.log(`  ${s.systemKey}: ${s.status} — ${s.summary}`);
  }

  if (!ok) {
    console.error('[status:probe] Critical failures:', failures.join(', '));
    process.exit(1);
  }
  console.log('[status:probe] All critical systems OK');
}

main().catch((err) => {
  console.error('[status:probe] Fatal:', err);
  process.exit(1);
});
