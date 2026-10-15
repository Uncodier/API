import { supabaseAdmin } from '@/lib/database/supabase-client';
import { housekeepingRows } from '../sandbox-housekeeping-db';
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));
it('paginates beyond Supabase default cap with stable order, retaining every row',async()=>{
  const query:any={};for(const method of ['select','order','gte'])query[method]=jest.fn(()=>query);
  query.range=jest.fn().mockResolvedValueOnce({data:Array.from({length:500},(_,id)=>({id})),error:null})
    .mockResolvedValueOnce({data:[{id:500}],error:null});
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
  const rows=await housekeepingRows('sandbox_billing_resources','sandbox_name','sandbox_name');
  expect(rows).toHaveLength(501);expect(query.order).toHaveBeenCalledWith('sandbox_name',{ascending:true});
  expect(query.range).toHaveBeenNthCalledWith(1,0,499);expect(query.range).toHaveBeenNthCalledWith(2,500,999);
});
it('does not treat failed/incomplete DB inventory as empty cleanup authority',async()=>{
  const query:any={};for(const method of ['select','order'])query[method]=()=>query;
  query.range=jest.fn().mockResolvedValue({data:null,error:{message:'synthetic outage'}});
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
  await expect(housekeepingRows('harness_sessions','snapshot')).rejects.toThrow('lookup failed');
});