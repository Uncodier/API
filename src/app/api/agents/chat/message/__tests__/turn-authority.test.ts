import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { authorizeChatTurn } from '../authorize-turn';
import { POST as workflow } from '@/app/api/workflow/agentMessage/route';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockWorkflow = jest.fn();
jest.mock('@/lib/services/workflow-service', () => ({WorkflowService:{getInstance: () => ({agentMessage:mockWorkflow})}}));
jest.mock('@/lib/services/ai/command-http-routing', () => ({withAuthorizedCommandRequest:(r:Request, fn:()=>Promise<Response>)=>fn()}));
const site = randomUUID(), conversation = randomUUID(), agent = randomUUID(), user = randomUUID();
const token = randomBytes(32).toString('hex');
const input = {site_id:site,conversationId:conversation,message:'Hello'};
const row = {id:conversation,site_id:site,agent_id:agent,lead_id:null,visitor_id:null,channel:'web',custom_data:null};
const turn = {...input,agentId:agent,team_member_id:user};
const request = (extra:object={}) => new Request('https://api.example.test/message',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({...input,...extra})});
const result = jest.fn(), permission = jest.fn(), getUser = jest.fn();
const filters = jest.fn();
const original = [process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY];
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://db.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=randomBytes(32).toString('hex');
  permission.mockResolvedValue({data:true});getUser.mockResolvedValue({data:{user:{id:user,role:'authenticated',is_anonymous:false}}});
  result.mockImplementation(async table=>({data:table==='conversations'?row:{id:agent}}));
  jest.mocked(createClient).mockReturnValue({auth:{getUser},rpc:permission,from:(table:string)=>{
    const q={select:()=>q,eq:(col:string,value:string)=>{filters(table,col,value);return q;},maybeSingle:()=>result(table)};return q;
  }} as any);
  mockWorkflow.mockResolvedValue({success:true,data:{success:true,data:{conversation_id:conversation,messages:{assistant:{message_id:randomUUID(),content:'Hi'}}}}});
});
afterAll(()=>{['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY'].forEach((k,i)=>{
  if(original[i]===undefined) delete process.env[k]; else process.env[k]=original[i];
});});
it('submits only DB-bound scope and the actual member to the workflow',async()=>{
  expect((await workflow(request({origin:'sms',tools:['untrusted'],target:'https://other.test'}))).status).toBe(200);
  expect(mockWorkflow.mock.calls[0][0]).toEqual({...turn,userId:user,origin:'chat'});
  expect(permission).toHaveBeenCalledWith('user_can',{p_site_id:site,p_command:'insert'});
  expect(filters).toHaveBeenCalledWith('agents','id',agent);expect(filters).toHaveBeenCalledWith('agents','site_id',site);
  expect(filters).toHaveBeenCalledWith('agents','status','active');
});
it.each([{agentId:randomUUID()},{team_member_id:randomUUID()},{userId:randomUUID()},{lead_id:randomUUID()}])('rejects mismatching identity before submit',async hints=>{
  expect((await workflow(request(hints))).status).toBeGreaterThanOrEqual(400);expect(mockWorkflow).not.toHaveBeenCalled();
});
it.each([{channel:'email'},{agent_id:null},{site_id:randomUUID()},{lead_id:randomUUID()},
  {custom_data:{source:'comment'}},{custom_data:{channel_delivery:true}}])('does not treat external or unbound rows as internal',async patch=>{
  result.mockResolvedValueOnce({data:{...row,...patch}});
  expect((await authorizeChatTurn(request(),input) as Response).status).toBe(409);
});
it('denies read-only or unverified callers without consulting any assigned agent',async()=>{
  permission.mockResolvedValueOnce({data:false});expect((await workflow(request())).status).toBe(403);
  const unverified=request();unverified.headers.delete('authorization');unverified.headers.set('x-auth-validated','true');
  expect((await workflow(unverified)).status).toBe(401);expect(result).not.toHaveBeenCalled();expect(mockWorkflow).not.toHaveBeenCalled();
});


it('never forwards private workflow diagnostics or results without a saved reply in this conversation',async()=>{
  mockWorkflow.mockResolvedValue({success:true,data:{success:true,data:{conversation_id:randomUUID(),messages:{assistant:{message_id:randomUUID(),content:'private'}}}}});
  const response=await workflow(request());expect(response.status).toBe(500);expect(await response.text()).not.toContain('private');
});
