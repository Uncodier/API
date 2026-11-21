import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assistantInstanceAccess } from '../assistant-instance-access';
import { canReadProcurementWorkflowInstanceAsActor } from '@/lib/services/workflow-robot/procurement-access';

jest.mock('@supabase/supabase-js', () => ({createClient:jest.fn()}));
jest.mock('@/lib/services/workflow-robot/procurement-access', () => ({canReadProcurementWorkflowInstanceAsActor:jest.fn()}));
const row={id:randomUUID(),site_id:randomUUID(),user_id:randomUUID()};
const principal={internal:false,siteId:null,userId:randomUUID(),userSession:true as const};
const auth=`Bearer ${randomUUID()}`; const request=new Request('https://api.example.test',{headers:{authorization:auth,'x-api-key-data':'untrusted'}});
const old=[process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY];
const selection={select:jest.fn(),eq:jest.fn(),abortSignal:jest.fn(),maybeSingle:jest.fn()};
const from=jest.fn();
beforeEach(()=>{
  jest.resetAllMocks(); process.env.NEXT_PUBLIC_SUPABASE_URL='https://db.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=randomUUID();
  jest.mocked(createClient).mockReturnValue({from} as unknown as ReturnType<typeof createClient>);
  from.mockReturnValue(selection); selection.select.mockReturnValue(selection); selection.eq.mockReturnValue(selection); selection.abortSignal.mockReturnValue(selection);
});
afterAll(()=>{for(const [key,value] of [['NEXT_PUBLIC_SUPABASE_URL',old[0]],['NEXT_PUBLIC_SUPABASE_ANON_KEY',old[1]]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});

it('requires a user-visible instance row, even on an otherwise permitted site',async()=>{
  selection.maybeSingle.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:row,error:null}).mockResolvedValueOnce({data:null,error:{code:'offline'}});
  expect(await assistantInstanceAccess(request,principal,row)).toBe(404);
  expect(await assistantInstanceAccess(request,principal,row)).toBe(200);
  expect(await assistantInstanceAccess(request,principal,row)).toBe(503);
  expect(createClient).toHaveBeenCalledWith('https://db.example.test',process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,expect.objectContaining({global:expect.objectContaining({headers:{Authorization:auth}})}));
  expect(selection.eq.mock.calls).toContainEqual(['id',row.id]); expect(selection.eq.mock.calls).toContainEqual(['site_id',row.site_id]);
  expect(canReadProcurementWorkflowInstanceAsActor).not.toHaveBeenCalled();
});
it('does not exchange a site API key for a different member’s access or fall back on a broken user session',async()=>{
  expect(await assistantInstanceAccess(request,{...principal,userSession:undefined},row)).toBe(404);
  expect(await assistantInstanceAccess(request,{...principal,siteId:randomUUID()},row)).toBe(403);
  expect(await assistantInstanceAccess(new Request(request,{headers:{'x-api-key':'test'}}),principal,row)).toBe(403);
  expect(createClient).not.toHaveBeenCalled(); expect(canReadProcurementWorkflowInstanceAsActor).not.toHaveBeenCalled();
  const key={...principal,userSession:undefined,userId:row.user_id};
  expect(await assistantInstanceAccess(new Request(request,{headers:{authorization:`Bearer ${[randomUUID(),randomUUID(),randomUUID()].join('.')}`}}),key,row)).toBe(403);
  jest.mocked(canReadProcurementWorkflowInstanceAsActor).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await assistantInstanceAccess(request,key,row)).toBe(404); expect(await assistantInstanceAccess(request,key,row)).toBe(200);
});
