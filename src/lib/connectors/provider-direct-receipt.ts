import 'server-only';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import {ConnectorError, type ConnectorContext} from './types';
import type {DirectAuthorizedConnector} from './provider-direct-policy';
import type {DirectReport} from './provider-direct-output';

const uuid=z.string().uuid();
const denied=()=>new ConnectorError('ACCESS_CHANGED','The original connector admission is no longer current.',403);
const unconfirmed=()=>new ConnectorError('DIRECT_RESULT_UNCONFIRMED','Private storage did not confirm delivery.',503);
function binding(ctx:ConnectorContext,a:DirectAuthorizedConnector,tool:string,version:string,hash:string) {
  const proof=a.directProof;
  if (!proof) throw denied();
  const authority=proof.kind==='connected_account'?{p_authorization_id:proof.authorizationId}:{p_attestation_id:proof.attestationId};
  if (ctx.host!=='assistant' || ctx.catalogUserSession!==true || !a.directProof || a.requestOnly ||
      !z.number().int().positive().max(2_147_483_647).safeParse(a.directProof.directRevision).success ||
      ctx.siteId!==a.connector.site_id || (ctx.connectorIdHint!==undefined && ctx.connectorIdHint!==a.connector.id) ||
      ![ctx.siteId,ctx.userId,ctx.instanceId,ctx.agentId,ctx.requestId,a.connector.id,...Object.values(authority)].every(id=>uuid.safeParse(id).success)) throw denied();
  return {p_site_id:ctx.siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId!,p_agent_id:ctx.agentId!,p_request_id:ctx.requestId!,
    p_connector_id:a.connector.id,p_tool:tool,p_version:version,p_schema_hash:hash,...authority,
    p_connector_revision:a.connector.revision,p_policy_revision:a.policy.revision,p_direct_revision:a.directProof.directRevision,p_credential_revision:a.provider.credential_revision};
}

export async function claimDirectDispatch(ctx:ConnectorContext,a:DirectAuthorizedConnector,tool:string,version:string,hash:string,digest:string):Promise<string> {
  const args=binding(ctx,a,tool,version,hash);
  let response;
  try { response=await supabaseAdmin.rpc(a.directProof.kind==='connected_account'?'claim_connector_account_dispatch':'claim_connector_direct_dispatch',{...args,p_arguments_digest:digest}).abortSignal(AbortSignal.timeout(5000)); }
  catch { throw new ConnectorError('DIRECT_DISPATCH_UNCONFIRMED','The dispatch reservation could not be confirmed.',503); }
  if (response.error?.code==='P0D03') throw new ConnectorError('DIRECT_DISPATCH_ALREADY_CLAIMED','This action has already been reserved for the request.',409);
  if (response.error?.code==='42501') throw denied();
  if (response.error || !uuid.safeParse(response.data).success) throw new ConnectorError('DIRECT_DISPATCH_UNCONFIRMED','The dispatch reservation could not be confirmed.',503);
  return response.data;
}

export async function storeDirectResult(ctx:ConnectorContext,a:DirectAuthorizedConnector,tool:string,version:string,hash:string,report:DirectReport,claimId:string):Promise<string> {
  const args=binding(ctx,a,tool,version,hash);
  if (!uuid.safeParse(claimId).success) throw unconfirmed();
  // Only storage has an idempotent acknowledgment. Never retry the claim or
  // the provider. Preserve the same validated DTO, claim ID and admission.
  const payload={...args,p_claim_id:claimId,p_report:structuredClone(report)};
  for (let attempt=0;attempt<2;attempt++) {
    let response;
    try { response=await supabaseAdmin.rpc(a.directProof.kind==='connected_account'?'store_connector_account_result':'store_connector_direct_result',payload).abortSignal(AbortSignal.timeout(5000)); }
    catch { continue; }
    if (!response.error && uuid.safeParse(response.data).success) return response.data;
    // postgrest-js normally returns transport failures as status 0 instead
    // of rejecting. Don't retry a database denial, invalid report or conflict.
    if (response.status!==0 && ![502,503,504].includes(response.status)) break;
  }
  throw unconfirmed();
}
