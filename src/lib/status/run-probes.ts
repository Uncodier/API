import { getAllHealthHandlers } from '@/lib/status/handler-registry';
import { persistProbeRun } from '@/lib/status/persist-status';
import {
  isCriticalFailure,
  type ProbeRunResult,
  type ProbeTrigger,
  type SystemHealthResponse,
} from '@/lib/status/types';

const CONCURRENCY = 5;

async function runPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function runProbes(trigger: ProbeTrigger): Promise<ProbeRunResult> {
  const start = Date.now();
  const handlers = getAllHealthHandlers();

  const systems = await runPool(handlers, async (handler) => {
    try {
      return await handler.runCheck({ useCache: false });
    } catch (err) {
      return {
        systemKey: handler.systemKey,
        label: handler.label,
        status: 'down' as const,
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        summary: err instanceof Error ? err.message : 'Handler threw',
        checks: {},
        error: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      } satisfies SystemHealthResponse;
    }
  }, CONCURRENCY);

  const durationMs = Date.now() - start;
  return persistProbeRun(trigger, systems, durationMs);
}

export function validateCriticalSystems(result: ProbeRunResult): {
  ok: boolean;
  failures: string[];
} {
  const failures = result.systems
    .filter(isCriticalFailure)
    .map((s) => `${s.systemKey}:${s.status}`);
  return { ok: failures.length === 0, failures };
}
