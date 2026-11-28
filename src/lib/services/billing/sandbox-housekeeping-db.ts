import { supabaseAdmin } from '@/lib/database/supabase-client';

/** A status of any age or stage can still protect either resource. */
export async function requirementStatusReferences() {
  const activeSandboxIds = new Set<string>();
  const activeSnapshotIds = new Set<string>();
  const pageSize = 500;
  let cursor: string | undefined;
  for (let page = 0; page < 2000; page++) {
    let query = supabaseAdmin.from('requirement_status')
      .select('id,active_sandbox_id,snapshot_id')
      .or('active_sandbox_id.not.is.null,snapshot_id.not.is.null')
      .order('id', { ascending: true }).limit(pageSize);
    if (cursor !== undefined) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error || !Array.isArray(data) || data.length > pageSize) {
      throw new Error('Sandbox housekeeping reference lookup failed');
    }
    // Only an empty page proves exhaustion if PostgREST caps the page size.
    if (!data.length) return { activeSandboxIds, activeSnapshotIds };
    for (const { id, active_sandbox_id, snapshot_id } of data) {
      if (typeof id !== 'string' || !id || (cursor !== undefined && id <= cursor) ||
          (active_sandbox_id !== null && typeof active_sandbox_id !== 'string') ||
          (snapshot_id !== null && typeof snapshot_id !== 'string')) {
        throw new Error('Sandbox housekeeping invalid reference page');
      }
      cursor = id;
      if (active_sandbox_id) activeSandboxIds.add(active_sandbox_id);
      if (snapshot_id) activeSnapshotIds.add(snapshot_id);
    }
  }
  throw new Error('Sandbox housekeeping reference pagination limit exceeded');
}

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