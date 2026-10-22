jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:jest.fn()}}));
import { randomUUID } from 'node:crypto';
import { imageOperationIdentity,holdImageCredits,settleImageCredits,ImageReservationError } from '../image-credit-reservations';
import { supabaseAdmin } from '@/lib/database/supabase-client';
const rpc=supabaseAdmin.rpc as unknown as jest.Mock;
beforeEach(()=>rpc.mockReset());
it('scopes stable internal identities to site, fingerprints payload, and never shares execution token',()=>{
  const site=randomUUID(),key=`workflow-image:${randomUUID()}`;
  const a=imageOperationIdentity(site,key,true,{prompt:'cat'}),b=imageOperationIdentity(site,key,true,{prompt:'cat'});
  expect(a.operationId).toBe(b.operationId);expect(a.requestHash).toBe(b.requestHash);expect(a.token).not.toBe(b.token);
  expect(imageOperationIdentity(randomUUID(),key,true,{prompt:'cat'}).operationId).not.toBe(a.operationId);
  expect(imageOperationIdentity(site,key,true,{prompt:'dog'}).requestHash).not.toBe(a.requestHash);
  expect(a.operationId).toMatch(/^[a-f0-9]{64}$/);expect(a.operationId).not.toContain(key);
});
it('generates server operation IDs for legacy calls and never trusts a public caller operation key',()=>{
  const site=randomUUID();expect(imageOperationIdentity(site,null,false,{}).operationId).not.toBe(imageOperationIdentity(site,null,false,{}).operationId);
  for(const key of ['','x'.repeat(129),'unsafe key',`workflow-image:${randomUUID()}`]){
    expect(()=>imageOperationIdentity(site,key,false,{})).toThrow(ImageReservationError);
  }
});
it.each([null,{}, {success:true}, {success:true,created:false,state:'reserved'}])('missing/duplicate admission cannot authorize generation: %j',async data=>{
  rpc.mockResolvedValue({data,error:null});
  await expect(holdImageCredits(imageOperationIdentity(randomUUID(),null,true,{}),1)).rejects.toBeInstanceOf(ImageReservationError);
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('never reports successful settlement from a malformed or pending receipt',async()=>{
  rpc.mockResolvedValue({data:{success:true,state:'pending'},error:null});
  await expect(settleImageCredits(imageOperationIdentity(randomUUID(),null,true,{}),1)).rejects.toMatchObject({code:'SETTLEMENT_UNCONFIRMED'});
});