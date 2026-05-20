import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface SlaWindow {
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
}

function computeUptime(
  rows: { status: string }[],
): number {
  const counted = rows.filter((r) => ['up', 'down', 'degraded'].includes(r.status));
  if (counted.length === 0) return 100;
  const up = counted.filter((r) => r.status === 'up').length;
  return Math.round((up / counted.length) * 1000) / 10;
}

export async function computeSlaBySystem(): Promise<Record<string, SlaWindow>> {
  const now = Date.now();
  const windows = {
    h24: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    d7: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    d30: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const { data: rows, error } = await supabaseAdmin
    .from('system_status')
    .select('system_key, status, created_at')
    .gte('created_at', windows.d30)
    .order('created_at', { ascending: false });

  if (error || !rows?.length) {
    return {};
  }

  const bySystem = new Map<string, { status: string; created_at: string }[]>();
  for (const row of rows) {
    const list = bySystem.get(row.system_key) ?? [];
    list.push(row);
    bySystem.set(row.system_key, list);
  }

  const result: Record<string, SlaWindow> = {};
  for (const [systemKey, list] of bySystem) {
    result[systemKey] = {
      uptime24h: computeUptime(list.filter((r) => r.created_at >= windows.h24)),
      uptime7d: computeUptime(list.filter((r) => r.created_at >= windows.d7)),
      uptime30d: computeUptime(list),
    };
  }
  return result;
}

export function computeOverallSla(sla: Record<string, SlaWindow>): number {
  const values = Object.values(sla);
  if (values.length === 0) return 100;
  const sum = values.reduce((acc, v) => acc + v.uptime24h, 0);
  return Math.round((sum / values.length) * 10) / 10;
}
