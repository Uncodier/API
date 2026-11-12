import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { emptyCapabilities } from '../catalog';
import { encryptCredential } from '../crypto';
import { getCustomerSelection, resolveCustomerCredential, publishConnection } from '../store';
import { type ConnectionRow } from '../types';
jest.mock('@/lib/database/supabase-server', () => ({supabaseAdmin:{from:jest.fn(),rpc:jest.fn()}}));
const siteId=randomUUID(), connectionId=randomUUID(), apiKey=randomBytes(32).toString('hex');
const ref={siteId,connectionId,policyVersion:1,credentialVersion:1};
let current: ConnectionRow;
let readError: unknown = null;
let policy: unknown;
let approval: unknown;
beforeEach(() => {
  jest.clearAllMocks(); process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  current={id:connectionId,site_id:siteId,status:'connected',selected:true,revision:2,policy_version:2,credential_version:1,encrypted_credential:encryptCredential(apiKey,siteId,connectionId,1),capabilities:emptyCapabilities(),catalog:[],catalog_updated_at:null,verified_at:null,consent_at:'now',updated_at:'now'};
  policy={capabilities:emptyCapabilities(),credential_version:1}; readError=null;
  approval={approved_until:new Date(Date.now()+3600000).toISOString()};
  jest.mocked(supabaseAdmin.from).mockImplementation((table:string) => {
    const query={select:jest.fn(),eq:jest.fn(),maybeSingle:jest.fn()}; query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    query.maybeSingle.mockImplementation(async()=>({data:table==='openrouter_customer_connections'?current:table==='openrouter_rollout_approvals'?approval:policy,error:readError})); return query as never;
  });
});
afterEach(()=>{delete process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY;});
test('selection is credential-free and uses latest policy identifiers',async()=>{
  const selection=await getCustomerSelection(siteId); expect(selection).toMatchObject({...ref,policyVersion:2,revision:2}); expect(JSON.stringify(selection)).not.toContain(apiKey); expect(JSON.stringify(selection)).not.toContain('encrypted');
});
test('only absence and explicit deselection return null, storage outage fails closed',async()=>{
  current=null as never; await expect(getCustomerSelection(siteId)).resolves.toBeNull();
  readError={code:'missing_table'}; await expect(getCustomerSelection(siteId)).rejects.toMatchObject({code:'connection_unavailable'});
});
test('malformed state is not legacy global routing',async()=>{
  current.capabilities={} as never; await expect(getCustomerSelection(siteId)).rejects.toMatchObject({code:'invalid_connection'});
});
test('dispatch resolves exact old immutable policy while current policy advances',async()=>{
  await expect(resolveCustomerCredential(ref)).resolves.toEqual({apiKey,capabilities:emptyCapabilities(),catalog:[]});
});
test.each(['deselected','rotated','foreign','disconnected','missing'] as const)('dispatch refuses %s without a global fallback',async condition=>{
  if(condition==='deselected')current.selected=false;
  if(condition==='rotated')current.credential_version=2;
  if(condition==='foreign')current.id=randomUUID();
  if(condition==='disconnected'){current.status='disconnected';current.selected=false;current.encrypted_credential=null;}
  if(condition==='missing')current=null as never;
  await expect(resolveCustomerCredential(ref)).rejects.toThrow();
});
test('missing or wrong credential policy never dispatches',async()=>{
  policy=null; await expect(resolveCustomerCredential(ref)).rejects.toMatchObject({code:'policy_unavailable'});
  policy={capabilities:emptyCapabilities(),credential_version:2}; await expect(resolveCustomerCredential(ref)).rejects.toMatchObject({code:'policy_unavailable'});
});
test('CAS conflict remains 409 and never retries stale candidates',async()=>{
  jest.mocked(supabaseAdmin.rpc).mockResolvedValue({data:null,error:{code:'40001'}} as never);
  await expect(publishConnection(siteId,randomUUID(),1,current)).rejects.toMatchObject({status:409,code:'revision_conflict'});
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});
test('missing or expired rollout approval blocks both new and pinned customer dispatch',async()=>{
  for(const value of [null,{approved_until:new Date(Date.now()-1000).toISOString()},{approved_until:'invalid'}]){
    approval=value;
    await expect(getCustomerSelection(siteId)).rejects.toMatchObject({code:'rollout_not_approved'});
    await expect(resolveCustomerCredential(ref)).rejects.toMatchObject({code:'rollout_not_approved'});
  }
});
