import { supabaseAdmin } from '@/lib/database/supabase-client';

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
  const { data: rows, error } = await supabaseAdmin.rpc(
    'get_system_status_sla',
    { p_since: since },
  );

  if (error) {
    throw new Error(`Failed to compute system status SLA: ${error.message}`);
  }
  if (!rows?.length) {
    return {};
  }

  const result: Record<string, SlaWindow> = {};
  for (const row of rows) {
    result[row.system_key] = {
      uptime24h: computeUptime(Number(row.up_24h), Number(row.total_24h)),
      uptime7d: computeUptime(Number(row.up_7d), Number(row.total_7d)),
      uptime30d: computeUptime(Number(row.up_30d), Number(row.total_30d)),
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
