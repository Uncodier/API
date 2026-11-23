import { z } from 'zod';
import type { AssistantRecoveryScope } from '@/lib/services/robot-instance/assistant-recovery';

/** Bind the prompt actually selected by the server. A retried workflow step may
 * confirm the same binding, but cannot choose a new agent or revive a turn. */
export async function bindDirectPromptAgentStep(scope: AssistantRecoveryScope, agent: string | undefined): Promise<boolean> {
  'use step';
  const uuid = z.string().uuid();
  if (!agent || (scope.generation ?? 0) !== 0 || ![scope.userMessageLogId,scope.userId,scope.instanceId,scope.siteId,agent].every(v=>uuid.safeParse(v).success)) return false;
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const {data,error} = await supabaseAdmin.from('instance_logs').update({agent_id:agent})
      .eq('id',scope.userMessageLogId).eq('instance_id',scope.instanceId).eq('site_id',scope.siteId).eq('user_id',scope.userId)
      .eq('log_type','user_action').eq('trusted_user_action',true).eq('details->>prompt_source','assistant_route')
      .eq('details->>status','running').not('details->>ask_request_sha256','is',null)
      .contains('details',{assistant_recovery:{version:1,respawnCount:0,inFlight:false,execution:{catalogUserSession:true,callerSource:'interactive',executionMode:'direct'}}})
      .or(`agent_id.is.null,agent_id.eq.${agent}`).select('id,agent_id').abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    return !error && data?.id === scope.userMessageLogId && data.agent_id === agent;
  } catch { return false; }
}