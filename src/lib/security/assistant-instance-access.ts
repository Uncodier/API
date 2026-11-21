import { createClient } from '@supabase/supabase-js';
import { canReadProcurementWorkflowInstanceAsActor } from '@/lib/services/workflow-robot/procurement-access';
import type { ToolRequestPrincipal } from './tool-request-principal';

type Instance = { id: string; site_id: string; user_id: string | null };
/** Admission for a loaded service-side row; a site grant alone is not row visibility.
 * Verified browser sessions must also see the same instance through their own RLS.
 * A site key has no user JWT: do not let it enumerate other members' instances. */
export async function assistantInstanceAccess(request: Request, principal: ToolRequestPrincipal, instance: Instance): Promise<200|403|404|503> {
  if (principal.internal) return 200;
  if (!principal.userId || (principal.siteId && principal.siteId !== instance.site_id)) return 403;
  try {
    if (principal.userSession !== true) {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer /,'');
      // Anonymous or unverified JWTs cannot borrow the API-key path.
      if (!request.headers.has('x-api-key') && token.split('.').length === 3) return 403;
      if (principal.userId !== instance.user_id) return 404;
      return await canReadProcurementWorkflowInstanceAsActor(instance.site_id,instance.id,principal.userId) ? 200 : 404;
    }
    const auth = request.headers.get('authorization');
    if (!auth?.startsWith('Bearer ') || request.headers.has('x-api-key')) return 403;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return 503;
    const db = createClient(url, anon, { auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
      global:{headers:{Authorization:auth},fetch:(target,options)=>fetch(target,{...options,cache:'no-store'})} });
    const {data,error} = await db.from('remote_instances').select('id,site_id').eq('site_id',instance.site_id)
      .eq('id',instance.id).abortSignal(AbortSignal.timeout(5_000)).maybeSingle();
    return error ? 503 : data?.id === instance.id && data.site_id === instance.site_id ? 200 : 404;
  } catch { return 503; }
}
