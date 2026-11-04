import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Host-only transition after a confirmed provider GET 404. Generic session saves
 * intentionally cannot clear a workspace reference. This RPC owns the narrow CAS. */
export async function retireMissingWorkspace(input: {
  sessionId: string; siteId: string; owner: string; version: number; resource: string;
}): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('retire_missing_harness_workspace', {
    p_id: input.sessionId, p_site_id: input.siteId, p_owner: input.owner,
    p_expected_version: input.version, p_resource: input.resource,
  });
  if (error || !data) throw new Error('Missing workspace reference could not be retired safely.');
}