import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Supabase's default row cap must not silently skip active refs or billable VMs. */
export async function housekeepingRows(table: string, columns: string, orderColumn = 'id', since?: string, nonRetired = false): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (let offset = 0; offset < 1000000; offset += 500) {
    let query = supabaseAdmin.from(table).select(columns).order(orderColumn, { ascending:true }).range(offset,offset+499);
    if (since) query = query.gte('created_at',since);
    if (nonRetired) query = query.is('retired_at',null);
    const { data,error } = await query;
    if (error) throw new Error('Sandbox housekeeping database lookup failed');
    out.push(...(data || []));
    if (!data || data.length < 500) return out;
  }
  throw new Error('Sandbox housekeeping database pagination limit exceeded');
}