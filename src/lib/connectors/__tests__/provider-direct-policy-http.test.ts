import { randomBytes, randomUUID } from 'node:crypto';
import { GET, PATCH } from '@/app/api/connectors/connections/[id]/provider-direct/route';
import { ConnectorError } from '../types';
const compatibility=jest.fn(), requireCompatibility=jest.fn();
jest.mock('../ask-compatibility',()=>({hostedAskCompatibility:(...v:unknown[])=>compatibility(...v),requireHostedAskCompatibility:(...v:unknown[])=>requireCompatibility(...v)}));
const getUser=jest.fn(), access=jest.fn(), rpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{auth:{getUser:(...v:unknown[])=>getUser(...v)},rpc:(...v:unknown[])=>rpc(...v)}}));
jest.mock('../account-access',()=>({...jest.requireActual('../account-access'),requireConnectorSiteAccess:(...v:unknown[])=>access(...v)}));
const site=randomUUID(), id=randomUUID(), actor=randomUUID(), context={params:Promise.resolve({id})}, key=randomBytes(48).toString('base64url');
const base=`https://api.example.test/api/connectors/connections/${id}/provider-direct`, query=`?site_id=${site}`;
const patch={site_id:site,enabled:true,expected_revision:8,expected_direct_revision:11};const display={connector_id:id,revision:8,direct_revision:12,attested:true,enabled:true};
const status={...display,setup_pending:false}; const stored={...status,bound_supabase_ref:null};
const req=(q:string,b?:unknown)=>new Request(base+q,{method:b===undefined?'GET':'PATCH',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},...(b!==undefined&&{body:JSON.stringify(b)})});
const reply=(data:unknown,error:unknown=null)=>({abortSignal:async()=>({data,error})});
beforeEach(()=>{jest.resetAllMocks();getUser.mockResolvedValue({data:{user:{id:actor}},error:null});access.mockResolvedValue({can_view:true,can_manage:true});rpc.mockReturnValue(reply(stored));});
it('authenticates both routes independently and requires manager access before calling policy storage',async()=>{
  for (const write of [false,true]) {
    const request=req(write?'':query,write?patch:undefined);request.headers.delete('authorization');expect((await (write?PATCH:GET)(request,context)).status).toBe(401);
    access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Denied',403));
    expect((await (write?PATCH:GET)(req(write?'':query,write?patch:undefined),context)).status).toBe(403);
    expect(access).toHaveBeenCalledWith(site,actor,true);expect(rpc).not.toHaveBeenCalled();
  }
});

it('reports host permission independently of execution and validates the single-policy revocation receipt', async()=>{
  const current={...stored,authorization_mode:'host_policy',assistant_allowed:true,enabled:false,attested:false};
  const {bound_supabase_ref,...visible}=current;
  rpc.mockReturnValueOnce(reply(current));
  const read=await GET(req(query),context); expect(read.status).toBe(200); expect(await read.json()).toEqual(visible);
  const stopped={...current,revision:patch.expected_revision+1,assistant_allowed:false};
  const {bound_supabase_ref: _private,...stoppedVisible}=stopped;
  const stop=()=>PATCH(req('',{...patch,enabled:false}),context);
  rpc.mockReturnValueOnce(reply(stopped));
  const res=await stop(); expect(res.status).toBe(200); expect(await res.json()).toEqual(stoppedVisible);
  for(const bad of [{...stopped,assistant_allowed:true},{...stopped,revision:patch.expected_revision},
    {...stopped,setup_pending:true},{...stopped,direct_revision:patch.expected_direct_revision}]) {
    rpc.mockReturnValueOnce(reply(bad)); expect((await stop()).status).toBe(503);
  }
  rpc.mockReturnValueOnce(reply({...current,enabled:true,attested:true,assistant_allowed:false}));
  expect((await GET(req(query),context)).status).toBe(503);
});
it('forwards only server actor, bound IDs, revision and manager consent; responds with private non-cacheable DTO',async()=>{
  rpc.mockReturnValueOnce(reply({...stored,authorization_mode:'member_policy',explicitly_disabled:false}));
  const read=await GET(req(query),context);expect(await read.json()).toEqual({...status,authorization_mode:'member_policy',explicitly_disabled:false});expect(read.headers.get('cache-control')).toBe('private, no-store');
  expect(rpc).toHaveBeenCalledWith('connector_instance_policy_status',{p_site_id:site,p_actor_id:actor,p_connector_id:id});
  const save=await PATCH(req('',patch),context);expect(await save.json()).toEqual(status);
  expect(rpc).toHaveBeenCalledWith('connector_set_ask_policy',{p_site_id:site,p_actor_id:actor,p_connector_id:id,p_expected_revision:8,p_expected_direct_revision:11,p_enabled:true});
  rpc.mockReturnValue(reply({...stored,private_evidence:'forbidden'}));expect((await GET(req(query),context)).status).toBe(503);
});
it('reports pending setup as unavailable, never returns a project reference, and confirms cancel only after both states clear',async()=>{
  const pending={...stored,attested:false,enabled:false,setup_pending:true,bound_supabase_ref:'a'.repeat(20)};
  rpc.mockReturnValue(reply(pending));
  rpc.mockReturnValueOnce(reply(null,{code:'PGRST202'}));
  const view=await GET(req(query),context); expect(await view.json()).toEqual({...status,attested:false,enabled:false,setup_pending:true});
  expect((await PATCH(req('',{...patch,enabled:false}),context)).status).toBe(503);
  rpc.mockReturnValue(reply({...pending,setup_pending:false})); expect((await PATCH(req('',{...patch,enabled:false}),context)).status).toBe(200);
  rpc.mockReturnValue(reply({...pending,attested:true,enabled:true})); expect((await GET(req(query),context)).status).toBe(503);
});
it('uses the same authoritative manager RPC even for a bound project and never returns its private reference',async()=>{
  rpc.mockReturnValueOnce(reply({...stored,bound_supabase_ref:'b'.repeat(20)}));
  expect(await (await PATCH(req('',patch),context)).json()).toEqual(status);
  expect(rpc.mock.calls.map(c=>c[0])).toEqual(['connector_set_ask_policy']);
});
it('rejects attempts to self-attest, spoof users or change other policy, query pollution and unbounded requests',async()=>{
  for (const b of [{...patch,attested:true},{...patch,user_id:actor},{...patch,allowed_tools:[]},{...patch,expected_revision:0},{...patch,expected_direct_revision:0},{...patch,expected_direct_revision:undefined},{...patch,enabled:'true'}]) expect((await PATCH(req('',b),context)).status).toBe(400);
  expect((await PATCH(req(query,patch),context)).status).toBe(400);expect((await GET(req(query+'&site_id='+site),context)).status).toBe(400);
  expect((await PATCH(req('',{note:'a'.repeat(2090)}),context)).status).toBe(413);expect(rpc).not.toHaveBeenCalled();
});
it('returns clean conflicts without reflecting private DB errors; invalid receipts cannot confirm changes',async()=>{
  for (const [code,expected] of [['P0D01','DIRECT_ATTESTATION_REQUIRED'],['40001','REVISION_CONFLICT']]) {
    rpc.mockReturnValueOnce(reply(null,{code,message:key}));
    const res=await PATCH(req('',patch),context);expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe(expected);
  }
  for (const stale of [{revision:9},{direct_revision:11},{direct_revision:undefined}]) {
    rpc.mockReturnValueOnce(reply({...stored,...stale}));
    expect((await PATCH(req('',patch),context)).status).toBe(503);
  }
});

it('reports connected-account authority without claiming resource attestation',async()=>{
  const dto={...stored,authority_kind:'connected_account',authorization_mode:'member_policy',explicitly_disabled:false,attested:false,enabled:true};
  rpc.mockReturnValue(reply(dto));expect(await (await GET(req(query),context)).json()).toEqual({...status,attested:false,authority_kind:'connected_account',authorization_mode:'member_policy',explicitly_disabled:false});
  rpc.mockReturnValue(reply({...dto,attested:true}));expect((await GET(req(query),context)).status).toBe(503);
});

it.each(['a'.repeat(20), 'a1'.repeat(10), {ref:'legacy'}, null, undefined])('projects the same delegated Ask status with or without a private project field (%j)',async ref=>{
  const visible={...status,attested:false,authority_kind:'connected_account'};
  const blocked={...visible,enabled:false,authorization_mode:'member_policy',explicitly_disabled:true};
  rpc.mockReturnValueOnce(reply({...blocked,bound_supabase_ref:ref}));
  const read=await GET(req(query),context); expect(read.status).toBe(200); expect(await read.json()).toEqual(blocked);
  rpc.mockReturnValueOnce(reply({...visible,bound_supabase_ref:ref}));
  const restored=await PATCH(req('',patch),context); expect(restored.status).toBe(200); expect(await restored.json()).toEqual(visible);
});

it('distinguishes downstream compatibility from saved status and allows recovery without an upstream check',async()=>{
  const state={...stored,authorization_mode:'host_policy',assistant_allowed:true};
  rpc.mockReturnValueOnce(reply(state));compatibility.mockResolvedValue({ask_compatible:false,ask_incompatibility:'auth_scheme'});
  const view=await GET(req(query),context);
  expect(await view.json()).toMatchObject({enabled:true,assistant_allowed:true,ask_compatible:false,ask_incompatibility:'auth_scheme'});
  expect(compatibility).toHaveBeenCalledWith(site,actor,id);
  requireCompatibility.mockRejectedValue(new ConnectorError('ASK_INCOMPATIBLE','Unavailable',409));
  const res=await PATCH(req('',patch),context);expect(res.status).toBe(409);expect(rpc).toHaveBeenCalledTimes(1);
  rpc.mockReturnValueOnce(reply({...state,enabled:false,assistant_allowed:false,revision:9}));
  expect((await PATCH(req('',{...patch,enabled:false}),context)).status).toBe(200);
  expect(requireCompatibility).toHaveBeenCalledTimes(1);expect(compatibility).toHaveBeenCalledTimes(1);
});
