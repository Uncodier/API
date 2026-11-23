import { randomBytes, randomUUID } from 'node:crypto';
import { GET, PATCH } from '@/app/api/connectors/connections/[id]/provider-direct/route';
import { ConnectorError } from '../types';
const getUser=jest.fn(), access=jest.fn(), rpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{auth:{getUser:(...v:unknown[])=>getUser(...v)},rpc:(...v:unknown[])=>rpc(...v)}}));
jest.mock('../account-access',()=>({...jest.requireActual('../account-access'),requireConnectorSiteAccess:(...v:unknown[])=>access(...v)}));
const site=randomUUID(), id=randomUUID(), actor=randomUUID(), context={params:Promise.resolve({id})}, key=randomBytes(48).toString('base64url');
const base=`https://api.example.test/api/connectors/connections/${id}/provider-direct`, query=`?site_id=${site}`;
const patch={site_id:site,enabled:true,expected_revision:8,expected_direct_revision:11};const display={connector_id:id,revision:8,direct_revision:12,attested:true,enabled:true};
const req=(q:string,b?:unknown)=>new Request(base+q,{method:b===undefined?'GET':'PATCH',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},...(b!==undefined&&{body:JSON.stringify(b)})});
const reply=(data:unknown,error:unknown=null)=>({abortSignal:async()=>({data,error})});
beforeEach(()=>{jest.resetAllMocks();getUser.mockResolvedValue({data:{user:{id:actor}},error:null});access.mockResolvedValue({can_view:true,can_manage:true});rpc.mockReturnValue(reply(display));});
it('authenticates both routes independently and requires manager access before calling policy storage',async()=>{
  for (const write of [false,true]) {
    const request=req(write?'':query,write?patch:undefined);request.headers.delete('authorization');expect((await (write?PATCH:GET)(request,context)).status).toBe(401);
    access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Denied',403));
    expect((await (write?PATCH:GET)(req(write?'':query,write?patch:undefined),context)).status).toBe(403);
    expect(access).toHaveBeenCalledWith(site,actor,true);expect(rpc).not.toHaveBeenCalled();
  }
});
it('forwards only server actor, bound IDs, revision and manager consent; responds with private non-cacheable DTO',async()=>{
  const read=await GET(req(query),context);expect(await read.json()).toEqual(display);expect(read.headers.get('cache-control')).toBe('private, no-store');
  expect(rpc).toHaveBeenCalledWith('connector_direct_policy',{p_site_id:site,p_actor_id:actor,p_connector_id:id});
  const save=await PATCH(req('',patch),context);expect(await save.json()).toEqual(display);
  expect(rpc).toHaveBeenCalledWith('connector_set_direct_policy',{p_site_id:site,p_actor_id:actor,p_connector_id:id,p_expected_revision:8,p_expected_direct_revision:11,p_enabled:true});
  rpc.mockReturnValue(reply({...display,private_evidence:'forbidden'}));expect((await GET(req(query),context)).status).toBe(503);
});
it('rejects attempts to self-attest, spoof users or change other policy, query pollution and unbounded requests',async()=>{
  for (const b of [{...patch,attested:true},{...patch,user_id:actor},{...patch,allowed_tools:[]},{...patch,expected_revision:0},{...patch,expected_direct_revision:0},{...patch,expected_direct_revision:undefined},{...patch,enabled:'true'}]) expect((await PATCH(req('',b),context)).status).toBe(400);
  expect((await PATCH(req(query,patch),context)).status).toBe(400);expect((await GET(req(query+'&site_id='+site),context)).status).toBe(400);
  expect((await PATCH(req('',{note:'a'.repeat(2090)}),context)).status).toBe(413);expect(rpc).not.toHaveBeenCalled();
});
it('returns clean conflicts without reflecting private DB errors; invalid receipts cannot confirm changes',async()=>{
  for (const [code,expected] of [['P0D01','DIRECT_ATTESTATION_REQUIRED'],['40001','REVISION_CONFLICT']]) {
    rpc.mockReturnValueOnce(reply(null,{code,message:key}));const res=await PATCH(req('',patch),context);expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe(expected);
  }
  for (const stale of [{revision:9},{direct_revision:11},{direct_revision:undefined}]) {
    rpc.mockReturnValueOnce(reply({...display,...stale}));expect((await PATCH(req('',patch),context)).status).toBe(503);
  }
});
