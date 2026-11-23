import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import {withDirectActorEvidence} from '@/lib/database/hosted-project-identity';
import {getVisibleConnector,getConnectorProvider} from './account-access';
import {ConnectorError,type ConnectorContext,type Connector,type ConnectorProvider} from './types';
import type {ConnectorContextResolver} from './host-context';
import type {ConnectorCandidate,ConnectorFilters} from './connector-discovery-types';
import {connectorToolRef} from './connector-ref';
import {SUPABASE_CATALOG_SLUG} from './provider-report-action';

export type ScopedReadBinding = {context:ConnectorContext;connector:Connector;provider:ConnectorProvider;policyRevision:number;localProjectRef:string;directRevision:number};
const uuid=z.string().uuid(), ref=z.string().length(20).regex(/^[a-z]{20}$/), revision=z.number().int().positive().max(2147483647);
const status=z.object({connector_id:uuid,project_ref:ref,connector_revision:revision,policy_revision:revision,direct_revision:revision,
  credential_revision:z.string().regex(/^(platform:)?[a-f0-9]{64}$/)}).strict();
const unavailable=()=>new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Could not verify the read policy for this connection.',503);
const denied=()=>new ConnectorError('SCOPED_READ_NOT_ALLOWED','The saved permissions do not allow this scoped read.',403);
const changed=()=>new ConnectorError('ACCESS_CHANGED','The original Ask turn or account changed.',403);

const actorArgs=(ctx:ConnectorContext)=>({p_site_id:ctx.siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId!,p_agent_id:ctx.agentId!});
/** The caller has verified account visibility and captured this installation's
 * identity from a successful actor RPC. The status RPC owns the data grant. */
export async function readScopedBinding(ctx:ConnectorContext,c:Connector,local:string):Promise<ScopedReadBinding> {
  if(ctx.host!=='assistant'||ctx.catalogUserSession!==true||![ctx.requestId,ctx.siteId,ctx.userId,ctx.agentId,ctx.instanceId,c.id].every(v=>uuid.safeParse(v).success)||
    (ctx.connectorIdHint!==undefined && ctx.connectorIdHint!==c.id)||c.site_id!==ctx.siteId||c.toolkit_slug!=='supabase'||
    !ref.safeParse(local).success||c.supabase_project_ref!==local||!c.verified_at||!c.enabled||c.provider_status!=='ACTIVE'||
    c.revocation_pending||c.revocation_dispatched!==false||c.provider_account_id==='instant_account') throw denied();
  const r=await supabaseAdmin.rpc('connector_instance_scoped_read',{...actorArgs(ctx),p_connector_id:c.id}).abortSignal(AbortSignal.timeout(5000));
  if(r.error)throw unavailable(); if(r.data===null)throw denied();
  const receipt=status.safeParse(r.data); if(!receipt.success)throw unavailable();
  const s=receipt.data; if(s.connector_id!==c.id||s.project_ref!==local||s.connector_revision!==c.revision)throw changed();
  const p=await getConnectorProvider(ctx.siteId,c.provider_id);
  if(!p||p.id!==c.provider_id||p.site_id!==ctx.siteId||p.provider_user_id!==ctx.siteId||p.project_id!==c.provider_project_id||p.provider!=='composio'||
    p.status!=='active'||p.credential_revision!==s.credential_revision) throw changed();
  return {context:ctx,connector:c,provider:p,policyRevision:s.policy_revision,directRevision:s.direct_revision,localProjectRef:local};
}

/** A different capability, not a substitute credential or an override of a denial.
 * Resolve from scratch at each boundary, tied to the originally selected account and human turn. */
export function scopedReadResolver(resolve:ConnectorContextResolver, initial:ConnectorContext, id:string) {
  return async ():Promise<ScopedReadBinding>=>{
    const ctx=await resolve();
    if(ctx.host!=='assistant'||ctx.catalogUserSession!==true||![id,ctx.siteId,ctx.userId,ctx.agentId,ctx.instanceId,ctx.requestId].every(v=>uuid.safeParse(v).success)||
      (ctx.connectorIdHint!==undefined && ctx.connectorIdHint!==id)||
      (['siteId','userId','agentId','instanceId','requestId','sourceDigest','connectorIdHint','catalogUserSession','host'] as const).some(k=>ctx[k]!==initial[k])) throw changed();
    const c=await getVisibleConnector(ctx.siteId,ctx.userId,id);
    if(c.id!==id||c.site_id!==ctx.siteId||c.toolkit_slug!=='supabase'||!ref.safeParse(c.supabase_project_ref).success) throw denied();
    const evidence=await withDirectActorEvidence(async()=>{
      const r=await supabaseAdmin.rpc('connector_direct_actor',actorArgs(ctx)).abortSignal(AbortSignal.timeout(5000));
      if(r.error||typeof r.data!=='boolean')throw unavailable(); return r.data;
    });
    if(!evidence.allowed||!evidence.localProjectRef||evidence.localProjectRef!==c.supabase_project_ref) throw denied();
    return readScopedBinding(ctx,c,evidence.localProjectRef);
  };
}

/** Local discovery of the exact supported action. Never query the provider for
 * business data, enumerate accounts, or advertise a raw SQL console. */
export function scopedReadPage(binding:ScopedReadBinding,filters:ConnectorFilters) {
  if(filters.cursor!==undefined) throw new ConnectorError('STALE_CURSOR','Restart the search on the selected account.',409);
  if((filters.query!==undefined&&(typeof filters.query!=='string'||filters.query.length>2048))||
    (filters.catalog_query!==undefined&&(typeof filters.catalog_query!=='string'||!filters.catalog_query.trim()||filters.catalog_query.length>150))) throw new ConnectorError('INVALID_FILTER','Use bounded catalogue search terms.',400);
  const term=(filters.catalog_query??filters.query??'').trim(), domains=['storage','analytics','developer'];
  // On this explicitly selected account there is exactly one compatible action.
  // Free-text intent is not a grant or a language-dependent allowlist. A literal
  // tool ID, however, must never produce a substitute tool.
  const matches=!/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(term)||term===SUPABASE_CATALOG_SLUG;
  const tools:ConnectorCandidate[]=matches&&(!filters.domain||domains.includes(filters.domain))&&(!filters.category||['research','infra'].includes(filters.category))?[{
    name:connectorToolRef(binding.connector.id,SUPABASE_CATALOG_SLUG),connector_id:binding.connector.id,toolkit:'supabase',domains,category:filters.category??'research',
    availability:'describe_required',description:'Read authorized metrics using this Supabase account. Describe the available sources and scopes. Not a general SQL console.',
  }]:[];
  return {tools,truncated:false,next_cursor:null};
}