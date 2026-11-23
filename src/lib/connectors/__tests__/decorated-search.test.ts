import {randomUUID} from 'node:crypto';
import {routeTools,type RoutedTool} from '@/app/api/agents/tools/router/assistantProtocol';
import {composioActionTool} from '@/app/api/agents/tools/composio/assistantProtocol';
import {assertToolScreenAccess,loadToolScreenAccess} from '@/app/api/agents/tools/router/screen-access';
import {EmbeddingsService} from '@/lib/services/embeddings-service';
import {instanceCatalog} from './instance-catalog-fixture';
import {instanceSearchTargets} from '../provider-direct-policy';
import {loadConnectorCredential} from '../account-access';
import {listToolkitToolMetadata} from '../composio-tool-metadata';
import {executeDirectTool,describeDirectTool} from '../provider-direct-transport';
import {connectorFixture,providerFixture,secret} from './composio-fixtures';
import {ConnectorError} from '../types';

jest.mock('../provider-direct-policy',()=>({instanceSearchTargets:jest.fn()}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));
jest.mock('../provider-direct-transport',()=>({describeDirectTool:jest.fn(),executeDirectTool:jest.fn()}));
jest.mock('../composio-tool-metadata',()=>({TOOL_CATALOG_LIMIT:20,listToolkitToolMetadata:jest.fn()}));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool',()=>({bindCatalogBatchActor:(t:unknown)=>t}));
jest.mock('@/app/api/agents/tools/router/screen-access',()=>({...jest.requireActual('@/app/api/agents/tools/router/screen-access'),loadToolScreenAccess:jest.fn(),assertToolScreenAccess:jest.fn()}));
jest.mock('@/lib/services/embeddings-service',()=>({EmbeddingsService:{generateEmbeddings:jest.fn()}}));
const ctx={host:'assistant' as const,siteId:randomUUID(),userId:randomUUID(),instanceId:randomUUID(),agentId:randomUUID(),requestId:randomUUID(),catalogUserSession:true as const};
const kit='novelcrm',privateLabel=`Private ${randomUUID()}`,id=randomUUID(),resource=`resource-${randomUUID()}`;
const provider={...providerFixture(),site_id:ctx.siteId,provider_user_id:ctx.siteId};
const account={connector:{...connectorFixture(),site_id:ctx.siteId,id,toolkit_slug:kit,display_name:privateLabel},provider,
  directProof:{attestationId:randomUUID(),directRevision:3,expiresAt:new Date(Date.now()+60000).toISOString(),siteId:ctx.siteId,connectorId:id,providerId:provider.id,
    projectId:provider.project_id,accountId:'ca_one',authConfigId:'ac_one',credentialRevision:provider.credential_revision,resourceBoundary:resource,toolkitSlug:kit},
  policy:{tool_access_mode:'all' as const,revision:1,allowed_tools:[],allowed_hosts:['assistant'],require_approval:true}};
const list=jest.mocked(listToolkitToolMetadata), embeds=jest.mocked(EmbeddingsService.generateEmbeddings);
const items=Array.from({length:7},(_,i)=>({slug:`NOVELCRM_LIST_CONTACTS_${i}`,name:'List contacts',description:'Lista de contactos',action_types:['read'] as ['read']}));
beforeEach(()=>{jest.resetAllMocks();jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:[]});
  embeds.mockRejectedValue(new Error('Offline'));
  jest.mocked(instanceSearchTargets).mockResolvedValue([account]);jest.mocked(loadConnectorCredential).mockResolvedValue({source:'byok',revision:provider.credential_revision,apiKey:secret()});
  list.mockResolvedValue({items,next_cursor:null,total:items.length});
});
afterEach(()=>{expect(describeDirectTool).not.toHaveBeenCalled();expect(executeDirectTool).not.toHaveBeenCalled();});
async function build() {
  const decorated=jest.fn();
  const factory=instanceCatalog({
    '@/lib/connectors/host-context':{assistantConnectorContext:()=>async()=>ctx},
    '@/app/api/agents/tools/composio/assistantProtocol':{composioActionTool},
    '@/app/api/agents/tools/router/assistantProtocol':{routeTools},
    '@/lib/services/tool-execution-context':{readToolExecutionContext:()=>undefined},
  });
  const native={name:'leads',description:'Native CRM contacts',parameters:{type:'object',properties:{}},execute:jest.fn()};
  const tools=await factory.getInstanceAssistantTools(ctx.siteId,ctx.userId,ctx.instanceId,[native],undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    defs=>defs.map(t=>t.name!=='use_composio_tools'?t:{...t,execute:(args:unknown)=>{decorated(args);return t.execute(args);}}),'assistant',ctx.agentId);
  return {router:tools.find((t:RoutedTool)=>t.name==='tools')!,decorated};
}
it('routes private discovery through the decorated gateway; local and multilingual catalog matches survive offline embeddings and continue without duplicates',async()=>{
  const {router,decorated}=await build(); const query='CRM contactos contacts';
  const run=(extra={})=>router.execute({action:'search',query,...extra});
  const first=await run(), second=await run({connector_cursor:first.connector_next_cursor});
  expect(decorated).toHaveBeenCalledWith(expect.objectContaining({action:'search',search_intent:query}));
  expect(first).toMatchObject({connector_status:'available',connector_next_cursor:expect.any(String),truncated:true});
  expect(first.tools[0]).toMatchObject({name:'leads'});
  const refs=[...first.tools,...second.tools].filter(t=>t.connector_id);
  expect(refs.map(t=>t.name)).toEqual(items.map(t=>`connector:${id}:${t.slug}`));
  expect(refs.every(t=>t.availability==='describe_required'&&!t.parameters)).toBe(true);expect(second.connector_next_cursor).toBeNull();
  const documents=embeds.mock.calls.map(([input])=>input).filter(Array.isArray).flat().join('\n');
  for (const sensitive of [privateLabel,resource,id,provider.project_id,items[0].slug]) expect(documents).not.toContain(sensitive);
  expect(list.mock.calls.every(call=>call.length===3)).toBe(true);
});
it('does not fall back to native actions or another account for an explicit selection',async()=>{
  const {router}=await build(); const filters={action:'search',query:'contactos',connector_id:id};
  const res=await router.execute(filters);expect(res.tools.every((t:RoutedTool)=>t.name.startsWith(`connector:${id}:`))).toBe(true);
  expect(embeds).not.toHaveBeenCalled();
  jest.mocked(instanceSearchTargets).mockRejectedValueOnce(new ConnectorError('DIRECT_POLICY_REQUIRED','Not admitted',403));
  expect(await router.execute(filters)).toMatchObject({success:false,tools:[],connector_error:'DIRECT_POLICY_REQUIRED'});
});
it('losing access invalidates old continuations; screen denial does not read account metadata',async()=>{
  const {router}=await build(); const res=await router.execute({action:'list'});
  jest.mocked(instanceSearchTargets).mockResolvedValue([]);
  expect(await router.execute({action:'list',connector_cursor:res.connector_next_cursor})).toMatchObject({connector_error:'STALE_CURSOR'});
  jest.clearAllMocks();jest.mocked(assertToolScreenAccess).mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Denied',403));
  expect(await router.execute({action:'list',connector_id:id})).toMatchObject({success:false,tools:[],connector_error:'ACCESS_DENIED'});
  expect(instanceSearchTargets).not.toHaveBeenCalled();expect(loadConnectorCredential).not.toHaveBeenCalled();
});