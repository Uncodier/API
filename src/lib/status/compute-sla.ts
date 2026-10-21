import { loadStatusHistory } from './get-system-timelines';
import { normalizeHealthStatus } from './observation';
import { getObservedSlaCounts } from './history-aggregates';

export interface SlaWindow {
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
}

function computeUptime(up: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((up / total) * 1000) / 10;
}

export async function computeSlaBySystem(): Promise<Record<string, SlaWindow>> {
  const now = Date.now();
  const since = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(now).toISOString();
  const aggregate = await getObservedSlaCounts(since, until);
  if (aggregate !== null) {
    return Object.fromEntries(aggregate.map(row => [row.system_key, {
      uptime24h: computeUptime(row.up_24h, row.total_24h),
      uptime7d: computeUptime(row.up_7d, row.total_7d),
      uptime30d: computeUptime(row.up_30d, row.total_30d),
    }]));
  }
  const rows = await loadStatusHistory(since, until);
  const counts = new Map<string, { up: number[]; total: number[] }>();
  for (const row of rows) {
    const payload = row.health_payload as { checks?: Record<string, unknown> } | null;
    const status = normalizeHealthStatus(row.status, payload?.checks ?? {});
    const count = counts.get(row.system_key) ?? { up: [0, 0, 0], total: [0, 0, 0] };
    counts.set(row.system_key, count);
    if (status === 'skipped') continue;
    const at = Date.parse(row.created_at);
    [1, 7, 30].forEach((days, index) => {
      if (at >= now - days * 86_400_000) {
        count.total[index]++;
        if (status === 'up') count.up[index]++;
      }
    });
  }
  const result: Record<string, SlaWindow> = {};
  for (const [key, count] of counts) {
    result[key] = {
      uptime24h: computeUptime(count.up[0], count.total[0]),
      uptime7d: computeUptime(count.up[1], count.total[1]),
      uptime30d: computeUptime(count.up[2], count.total[2]),
    };
  }
  return result;
}

export function computeOverallSla(
  sla: Record<string, SlaWindow>,
): number | null {
  const values = Object.values(sla)
    .map((window) => window.uptime24h)
    .filter((uptime): uptime is number => uptime !== null);
  if (values.length === 0) return null;
  const sum = values.reduce((acc, uptime) => acc + uptime, 0);
  return Math.round((sum / values.length) * 10) / 10;
}
