import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface DailyStatusCounts {
  system_key: string;
  day: string;
  check_count: number;
  observed_check_count: number;
  up_check_count: number;
  degraded_check_count: number;
  down_check_count: number;
  skipped_check_count: number;
}

export interface ObservedSlaCounts {
  system_key: string;
  total_24h: number;
  up_24h: number;
  total_7d: number;
  up_7d: number;
  total_30d: number;
  up_30d: number;
}

const PAGE_SIZE = 500;

async function loadCounts<T>(
  rpc: string,
  since: string,
  until: string,
  orderColumns: string[],
  countColumns: string[],
): Promise<T[] | null> {
  const counts: T[] = [];
  let offset = 0;
  while (true) {
    let query = supabaseAdmin.rpc(rpc, { p_since: since, p_until: until });
    for (const column of orderColumns) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      // Deploy-safe fallback only when this optional migration is not installed.
      if (error.code === 'PGRST202' || error.code === '42883') return null;
      throw new Error(`Failed to load ${rpc}: ${error.message}`, { cause: error });
    }
    if (!Array.isArray(data)) throw new Error(`${rpc} returned no data`);
    if (data.length === 0) return counts;
    for (const raw of data) {
      const row = { ...raw };
      for (const column of countColumns) {
        const value = raw[column];
        const count = typeof value === 'number' ? value
          : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error(`${rpc} returned an invalid ${column}`);
        }
        row[column] = count;
      }
      if (rpc === 'get_system_status_daily') {
        const observed = row.up_check_count + row.degraded_check_count + row.down_check_count;
        if (row.observed_check_count !== observed || row.check_count !== observed + row.skipped_check_count) {
          throw new Error(`${rpc} returned inconsistent counts`);
        }
      } else if (['24h', '7d', '30d'].some((window) => row[`up_${window}`] > row[`total_${window}`])) {
        throw new Error(`${rpc} returned inconsistent counts`);
      }
      counts.push(row as T);
    }
    // PostgREST may enforce a cap below the requested size.
    offset += data.length;
  }
}

export function getDailyStatusCounts(since: string, until: string): Promise<DailyStatusCounts[] | null> {
  return loadCounts<DailyStatusCounts>('get_system_status_daily', since, until, ['day', 'system_key'], [
    'check_count', 'observed_check_count', 'up_check_count', 'degraded_check_count', 'down_check_count', 'skipped_check_count',
  ]);
}

export function getObservedSlaCounts(since: string, until: string): Promise<ObservedSlaCounts[] | null> {
  return loadCounts<ObservedSlaCounts>('get_system_status_observed_sla', since, until, ['system_key'], [
    'total_24h', 'up_24h', 'total_7d', 'up_7d', 'total_30d', 'up_30d',
  ]);
}