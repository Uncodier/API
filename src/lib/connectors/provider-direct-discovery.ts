import {createHash} from 'node:crypto';
import {z} from 'zod';
import {loadConnectorCredential} from './account-access';
import {catalogPageCursor} from './catalog-pagination';
import {connectorToolRef} from './connector-ref';
import {modelAccountIdentity} from './model-account-identity';
import {createComposioClient} from './composio-transport';
import {listToolkitToolMetadata, listSelectedCatalogMetadata, TOOL_CATALOG_LIMIT} from './composio-tool-metadata';
import {CONNECTOR_DOMAINS, getToolkitDomains} from './domains';
import {ConnectorError, type ConnectorContext} from './types';
import type {ConnectorFilters, ConnectorCandidate} from './connector-discovery-types';
import type {DirectAuthorizedConnector} from './provider-direct-policy';
import {selectedCatalogAccount,type CatalogOnlyAccount} from './selected-catalog-account';
import {directActionNameSafe} from './provider-direct-guards';

import {selectedQueryProbeEligible, SELECTED_QUERY_PROBE} from './selected-query-probe-policy';

// Cursors refer to metadata positions only, never authorization. Resume a bounded page using
// the provider's page/limit cursor format, not an arbitrary query/path supplied by a model.
const digest = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,32);
const stale = () => new ConnectorError('STALE_CURSOR','The connection policy or catalog page changed. Restart discovery.',409);
const filtersSchema = z.object({query:z.string().max(2048).optional(),catalog_query:z.string().trim().min(1).max(150).optional(),
  domain:z.string().max(100).optional(),category:z.string().max(100).optional(),connector_id:z.string().uuid().optional(),cursor:z.string().max(110).optional()}).strict();
const words = (s:string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,24);
type Item = Awaited<ReturnType<typeof listToolkitToolMetadata>>['items'][number];
const qualifiedName = /^(?:connector|report):/i;
const literalSlug = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
function matches(item:Item, kit:string, name:string, filters:ConnectorFilters) {
  // An exact name in either filter must never be broadened by the other filter or keyword scoring.
  const terms = [filters.query?.trim(), filters.catalog_query?.trim()];
  if (terms.some(v => v && ((qualifiedName.test(v) && v !== name) || (literalSlug.test(v) && v !== item.slug)))) return false;
  const term = terms[1] ?? terms[0];
  if (!term || term === name || term === item.slug) return true;
  const text = `${kit} ${item.slug.replaceAll('_',' ')} ${item.name} ${item.description}`.toLowerCase();
  const search = words(term);
  return filters.catalog_query ? search.every(word=>text.includes(word)) : search.some(word=>text.includes(word));
}

/** Receives only freshly authorized accounts from Policies. No module is imported based on the
 * toolkit, name or effect. Search text stays local; selected IDs are server-saved policy data. */
export async function searchDirectTools(ctx:ConnectorContext, input:ConnectorFilters, targets:(DirectAuthorizedConnector | CatalogOnlyAccount)[]) {
  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success) throw new ConnectorError('INVALID_FILTER','Use bounded catalog search filters.',400);
  const {cursor,...filters} = parsed.data;
  const accounts = targets.filter(({connector,policy,requestOnly})=>!requestOnly && connector.site_id===ctx.siteId &&
    (!ctx.connectorIdHint || connector.id===ctx.connectorIdHint) && (!filters.connector_id || connector.id===filters.connector_id) &&
    (policy.tool_access_mode==='all' || policy.allowed_tools.length>0)).map(target=>{
      const domains=getToolkitDomains(target.connector.toolkit_slug);
      const category=CONNECTOR_DOMAINS.find(d=>d.id===domains[0])?.categories[0] ?? 'other';
      return {target,domains,category};
    }).filter(({domains,category})=>(!filters.domain || domains.includes(filters.domain)) && (!filters.category || category===filters.category))
    .sort((a,b)=>a.target.connector.id.localeCompare(b.target.connector.id));
  const identity=digest([ctx.siteId,ctx.instanceId,ctx.userId,ctx.agentId,ctx.connectorIdHint,filters,
    accounts.map(({target:t})=>[t.connector.id,t.connector.revision,t.provider.credential_revision,t.policy.revision,...('directProof' in t?[t.directProof.attestationId,t.directProof.directRevision]:['catalog_only'])])]);
  let account=0, page=1, offset=0, observed='';
  if (cursor !== undefined) {
    const m=/^d1:([a-f0-9]{32}):(\d{1,5}):(\d{1,6}):(\d{1,2}):(-|[a-f0-9]{32})$/.exec(cursor);
    if (!m || m[0]!==cursor || m[1]!==identity) throw stale();
    [account,page,offset]=m.slice(2,5).map(Number); observed=m[5]==='-'?'':m[5];
    if (account>=accounts.length || page<1 || page>100_000 || offset>=TOOL_CATALOG_LIMIT || Boolean(offset)!==Boolean(observed)) throw stale();
  }
  const tools:ConnectorCandidate[]=[];
  let partial_error:string|undefined;
  if (account<accounts.length) {
    const {target,domains,category}=accounts[account];
    const kit=target.connector.toolkit_slug;
    try {
      const cred=await loadConnectorCredential(ctx.siteId);
      if (cred.revision!==target.provider.credential_revision) throw new ConnectorError('STALE_CREDENTIAL','Connection verification changed.',409);
      const client=createComposioClient(cred.apiKey);
      const all=target.policy.tool_access_mode==='all';
      const ids=[...new Set(target.policy.allowed_tools)].sort();
      const batch=all?[]:ids.slice((page-1)*12,page*12);
      if (!all && !batch.length) throw stale();
      const probe:Item={slug:SELECTED_QUERY_PROBE,name:'Test connection',description:'Test connectivity with SELECT 1; no table reads on this shared credential.',action_types:[]};
      let canProbe=false;
      if (ctx.connectorIdHint===target.connector.id && kit==='supabase' && ctx.agentId && target.connector.supabase_project_ref) {
        try {
          canProbe=selectedQueryProbeEligible('catalogOnly' in target ? target : await selectedCatalogAccount(ctx,target.connector.id,true));
        } catch (error) {
          if (!(error instanceof ConnectorError) || !['DIRECT_POLICY_REQUIRED','NOT_FOUND','ACCESS_DENIED'].includes(error.code)) throw error;
        }
      }
      const query=(filters.catalog_query ?? filters.query ?? '').trim();
      const probeLookup=canProbe && (query===probe.slug || query===connectorToolRef(target.connector.id,probe.slug) ||
        /^(?:test connection|connection test|test connectivity|select 1|probar conexi[oó]n)$/i.test(query));
      const result=probeLookup?await listSelectedCatalogMetadata(client,kit,[probe.slug]):all?await listToolkitToolMetadata(client,kit,catalogPageCursor(page,TOOL_CATALOG_LIMIT))
        :await listSelectedCatalogMetadata(client,kit,batch);
      if ('missing' in result && result.missing) partial_error='CATALOG_SELECTION_CHANGED';
      const items=result.items, fingerprint=digest(items.map(i=>[i.slug,i.name,i.description]));
      if (offset && (observed!==fingerprint || offset>=items.length)) throw stale();
      for (;offset<items.length && tools.length<5;offset++) {
        const i=items[offset];
        if (i.slug.startsWith('COMPOSIO_')) continue;
        const name=connectorToolRef(target.connector.id,i.slug);
        const isProbe=canProbe && i.slug===probe.slug;
        if (!matches(isProbe ? {...i,description:`${probe.name}. ${probe.description} Probar conexión. ${i.description}`} : i,kit,name,filters)) continue;
        tools.push({name,toolkit:kit,tool_origin:'provider',...modelAccountIdentity(target.connector.id),
          domains,category,availability:isProbe || ('directProof' in target && directActionNameSafe(kit,i.slug))?'describe_required':'manual_only',
          description:isProbe ? `${probe.description} Never substitute SELECT 1 for a data request.` : 'directProof' in target ? `${i.slug.replaceAll('_',' ')}. Catalog metadata is not authorization.` : 'Provider catalog only. This account has no direct execution admission; do not call or substitute another tool.'});
      }
      observed = offset<items.length?fingerprint:'';
      if (!observed) {
        const more=!probeLookup && ('next_cursor' in result ? !!result.next_cursor : ids.length>page*12);
        offset=0;
        if (more && page<100_000) page++; else {account++;page=1;}
      }
    } catch(error) {
      if (!(error instanceof ConnectorError) || error.code==='STALE_CURSOR') throw error;
      partial_error=error.code; account++; page=1; offset=0; observed='';
    }
  }
  const more=account<accounts.length;
  return {tools,truncated:more,next_cursor:more?`d1:${identity}:${account}:${page}:${offset}:${observed || '-'}`:null,
    ...(partial_error && {partial_error})};
}