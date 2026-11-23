import {randomUUID} from 'node:crypto';
import {createProviderDirectRuntime} from '../provider-direct-runtime';
import {accountFixture,connectorFixture,providerFixture,toolFixture,toolkitFixture,secret,jsonResponse} from './composio-fixtures';
import {loadConnectorCredential} from '../account-access';
import {readTokenProviderBinding} from '../provider-project-binding';
const mockRpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args)}}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:jest.fn()}));
afterEach(()=>{jest.restoreAllMocks();jest.resetAllMocks();});

// Replace I/O only: run the shared catalog, authority parser, schema, transport and claim/storage client.
it.each(['valid','OAuth grant changed','key instead of OAuth','shared account','custom endpoint'])(
  'uses the completed OAuth connection instead of a resource attestation: %s', async variant=>{
  const site=randomUUID(),id=randomUUID(),attempt=randomUUID(),claim=randomUUID(),receipt=randomUUID(),key=secret();
  const scope='https://www.googleapis.com/auth/gmail.readonly',kit='gmail';
  const slug=`GMAIL_LIST_LABELS_${randomUUID().replaceAll('-','').toUpperCase()}`;
  const p={...providerFixture(),id:randomUUID(),site_id:site,provider_user_id:site,credential_revision:secret()};
  const c={...connectorFixture(),id,site_id:site,provider_id:p.id,toolkit_slug:kit,created_by:randomUUID(),supabase_project_ref:null,
    revocation_dispatched:false,access_mode:'workspace' as const,granted_scopes:[scope]};
  const row={authority_kind:'connected_account',authorization_id:attempt,connector:c,provider:p,direct_revision:1,
    policy:{allowed_hosts:['assistant'],allowed_tools:[slug],tool_access_mode:'selected',require_approval:true,revision:1}};
  const ctx={siteId:site,agentId:randomUUID(),instanceId:randomUUID(),userId:randomUUID(),requestId:randomUUID(),connectorIdHint:id,catalogUserSession:true as const,host:'assistant' as const};
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:key,revision:p.credential_revision,source:'byok'});
  jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId:p.project_id});
  const reply=(data:unknown)=>({abortSignal:async()=>({data,error:null})});
  const journal:string[]=[];
  mockRpc.mockImplementation((name:string,args:Record<string,unknown>)=>{
    if(name==='connector_direct_accounts_v2')return reply([row]);
    expect(args).toMatchObject({p_connector_id:id,p_authorization_id:attempt,p_request_id:ctx.requestId,p_tool:slug});expect(args).not.toHaveProperty('p_attestation_id');
    if(name==='claim_connector_account_dispatch'){journal.push('claim');return reply(claim);}
    if(name==='store_connector_account_result'){expect(args.p_claim_id).toBe(claim);journal.push('store');return reply(receipt);}
    throw Error('Unexpected SQL operation');
  });
  const tool={...toolFixture(),name:'List labels',slug,toolkit:{slug:kit},tags:['readOnlyHint'],scopes:[scope],input_parameters:{type:'object',properties:{limit:{type:'integer'}}}};
  const live={...accountFixture(),user_id:site,toolkit:{slug:kit},state:{authScheme:'OAUTH2',val:{scope}},data:{base_url:'https://gmail.googleapis.com'}};
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const path=new URL(String(url)).pathname.replace('/api/v3.1','');expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
    if(path==='/tools')return jsonResponse({items:[tool],next_cursor:null,total_items:1});
    if(path===`/tools/${slug}`)return jsonResponse(tool);
    if(path===`/toolkits/${kit}`)return jsonResponse({...toolkitFixture(),slug:kit});
    if(path===`/connected_accounts/${c.provider_account_id}`)return jsonResponse(live);
    if(path===`/tools/execute/${slug}` && init?.method==='POST'){
      expect(JSON.parse(String(init.body))).toEqual({connected_account_id:c.provider_account_id,user_id:site,version:tool.version,arguments:{limit:3}});
      journal.push('POST');return jsonResponse({successful:true,error:null,data:{count:3}});
    }throw Error('Unexpected provider operation');
  });
  const run=createProviderDirectRuntime(async()=>ctx);const {tools}=await run.search({catalog_query:slug});
  expect(tools).toMatchObject([{name:`connector:${id}:${slug}`,availability:'describe_required'}]);
  const d=await run.describe(tools[0].name);expect(JSON.stringify(d)).not.toContain(attempt);
  if(variant==='OAuth grant changed')live.state.val.scope+=' https://mail.google.com/';
  if(variant==='key instead of OAuth')live.state.authScheme='API_KEY';
  if(variant==='shared account')live.experimental.account_type='SHARED';
  if(variant==='custom endpoint')live.data.base_url='https://other.example.test';
  const call=run.call(d.name,{version:d.version,schema_hash:d.schema_hash,arguments:{limit:3}});
  if(variant==='valid'){await expect(call).resolves.toMatchObject({success:true,receipt:{url:`/connectors/results/${receipt}`}});expect(journal).toEqual(['claim','POST','store']);}
  else {await expect(call).rejects.toMatchObject({executed:false});expect(journal).toEqual([]);}
});
