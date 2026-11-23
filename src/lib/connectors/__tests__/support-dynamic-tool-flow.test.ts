import {randomUUID} from 'node:crypto';
import {executeSupportConnectorTool} from '../support-runtime';
import {getVisibleConnector,getMemberGrant,loadConnectorCredential} from '../account-access';
import {candidateWindow} from '../support-runtime-access';
import {readTokenProviderBinding} from '../provider-project-binding';
import {loadToolScreenAccess} from '@/app/api/agents/tools/router/screen-access';
import {accountFixture,connectorFixture,providerFixture,toolkitFixture,toolFixture,secret,jsonResponse} from './composio-fixtures';
const mockRpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args)}}));
jest.mock('../account-access',()=>({getVisibleConnector:jest.fn(),getMemberGrant:jest.fn(),loadConnectorCredential:jest.fn()}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:jest.fn()}));
jest.mock('../support-runtime-access',()=>({...jest.requireActual('../support-runtime-access'),candidateWindow:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access',()=>({...jest.requireActual('@/app/api/agents/tools/router/screen-access'),loadToolScreenAccess:jest.fn()}));
afterEach(()=>{jest.restoreAllMocks();jest.resetAllMocks();});

it.each(['all','selected','reviewed'] as const)('uses the generic executor end to end on the assigned agent account (%s)',async scenario=>{
  const id=randomUUID(),siteId=randomUUID(),agentId=randomUUID(),userId=randomUUID();
  const scope={audience:'member' as const,siteId,agentId,userId,conversationId:randomUUID(),idempotencyKey:randomUUID()};
  const mode=scenario==='all'?'all':'selected';
  const kit=scenario==='reviewed'?'gmail':'orderdesk',slug=scenario==='reviewed'?'GMAIL_FETCH_EMAILS':`ORDERDESK_LIST_ITEMS_${randomUUID().replaceAll('-','').toUpperCase()}`, key=secret();
  const provider={...providerFixture(),id:randomUUID(),site_id:siteId,provider_user_id:siteId,credential_revision:secret()};
  const c={...connectorFixture(),id,site_id:siteId,provider_id:provider.id,provider_account_id:`ca_${randomUUID()}`,toolkit_slug:kit,created_by:userId,supabase_project_ref:null,revocation_dispatched:false,access_mode:'explicit' as const};
  const row={connector:c,provider,required_screens:[],attestation_id:randomUUID(),expires_at:new Date(Date.now()+60000).toISOString(),resource_boundary:'site-business',local_installation_ref:null,direct_revision:2,policy:{tool_access_mode:mode,allowed_tools:mode==='all'?[]:[slug],allowed_hosts:['assistant'],require_approval:true,revision:1}};
  const tool={...toolFixture(),slug,name:'List items',toolkit:{slug:kit},tags:['readOnlyHint'],input_parameters:{type:'object',properties:{quantity:{type:'integer'}}}};
  jest.mocked(getVisibleConnector).mockResolvedValue(c);jest.mocked(getMemberGrant).mockResolvedValue({user_id:userId,can_view:true,can_use:true,expires_at:null});
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:key,revision:provider.credential_revision,source:'byok'});
  jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId:provider.project_id});jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:true,blockedScreens:[]});
  jest.mocked(candidateWindow).mockResolvedValue([{id}]);
  const posts:unknown[]=[];let reserved=false;
  mockRpc.mockImplementation((rpc:string,args:Record<string,string>)=>{expect(args.p_site_id).toBe(siteId);expect(args.p_agent_id).toBe(agentId);expect(args.p_connector_id).toBe(id);
    if(rpc==='connector_support_agent_account_v2')return {abortSignal:async()=>({data:[row],error:null})};
    if(rpc==='connector_claim_support_dispatch'){const ok=!reserved;reserved=true;return {abortSignal:async()=>({data:ok,error:null})};}
    throw Error('Unexpected DB operation');});
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const path=new URL(String(url)).pathname.replace('/api/v3.1','');expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
    if(path==='/tools')return jsonResponse({items:[tool],total_items:1,next_cursor:null});
    if(path===`/tools/${slug}`)return jsonResponse(tool);
    if(path===`/toolkits/${kit}`)return jsonResponse({...toolkitFixture(),slug:kit});
    if(path===`/connected_accounts/${c.provider_account_id}`)return jsonResponse({...accountFixture(),id:c.provider_account_id,user_id:siteId,toolkit:{slug:kit},state:{authScheme:'API_KEY',val:{}}});
    if(path===`/tools/execute/${slug}`&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return jsonResponse({successful:true,error:null,data:{count:3}});}
    throw Error('Unexpected Composio request');});
  const run=(args:unknown):Promise<any>=>executeSupportConnectorTool({siteId,agentId,resolve:async()=>scope},'support_connectors',args);
  const page=await run({action:'list',connector_id:id});expect(page).toMatchObject({success:true,tools:[{name:`connector:${id}:${slug}`} ]});
  const d=await run({action:'describe',name:page.tools[0].name});expect(d.success).toBe(true);expect(posts).toHaveLength(0);
  const call={action:'call',name:d.name,version:d.version,schema_hash:d.schema_hash,arguments:{quantity:3}};
  expect(await run(call)).toMatchObject({success:true,status:'completed'});expect((await run(call)).success).toBe(false);
  expect(posts).toEqual([{connected_account_id:c.provider_account_id,user_id:siteId,version:tool.version,arguments:{quantity:3}}]);
});
