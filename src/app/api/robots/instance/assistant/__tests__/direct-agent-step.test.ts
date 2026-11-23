import { randomUUID } from 'node:crypto';
import { bindDirectPromptAgentStep } from '../direct-agent-step';

const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:(table:string)=>mockFrom(table)}}));
const scope = {userMessageLogId:randomUUID(),siteId:randomUUID(),instanceId:randomUUID(),userId:randomUUID()};
const agent = randomUUID();
beforeEach(()=>mockFrom.mockReset());

it('only binds an unassigned/identical agent on the exact, keyed, unresumed, server-owned action', async()=>{
  const q = {update:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),or:jest.fn().mockReturnThis(),not:jest.fn().mockReturnThis(),
    contains:jest.fn().mockReturnThis(),select:jest.fn().mockReturnThis(),abortSignal:jest.fn().mockReturnThis(),maybeSingle:jest.fn()};
  mockFrom.mockReturnValue(q);
  for(const [response,expected] of [
    [{data:{id:scope.userMessageLogId,agent_id:agent},error:null},true],
    [{data:{id:scope.userMessageLogId,agent_id:randomUUID()},error:null},false],
    [{data:null,error:null},false], [{data:null,error:{code:'42501'}},false],
  ] as const) {
    q.maybeSingle.mockResolvedValueOnce(response);
    expect(await bindDirectPromptAgentStep(scope,agent)).toBe(expected);
  }
  expect(q.update).toHaveBeenCalledWith({agent_id:agent});
  expect(q.or).toHaveBeenCalledWith(`agent_id.is.null,agent_id.eq.${agent}`);
  for(const [key,value] of Object.entries({id:scope.userMessageLogId,site_id:scope.siteId,user_id:scope.userId,instance_id:scope.instanceId,
    log_type:'user_action',trusted_user_action:true,'details->>status':'running','details->>prompt_source':'assistant_route'})) expect(q.eq).toHaveBeenCalledWith(key,value);
  expect(q.not).toHaveBeenCalledWith('details->>ask_request_sha256','is',null);
  expect(q.contains).toHaveBeenCalledWith('details',{assistant_recovery:{version:1,respawnCount:0,inFlight:false,
    execution:{catalogUserSession:true,callerSource:'interactive',executionMode:'direct'}}});
});

it('fails closed on an unknown agent, a resumed turn, or an unconfirmed database response',async()=>{
  expect(await bindDirectPromptAgentStep(scope,undefined)).toBe(false);
  expect(await bindDirectPromptAgentStep({...scope,generation:1},agent)).toBe(false);
  expect(mockFrom).not.toHaveBeenCalled();
  mockFrom.mockImplementation(()=>{throw new Error('Database unavailable');});
  expect(await bindDirectPromptAgentStep(scope,agent)).toBe(false);
});