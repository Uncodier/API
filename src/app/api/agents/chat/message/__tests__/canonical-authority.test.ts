import { randomUUID } from 'node:crypto';
import { POST } from '../route';
import { authorizeChatTurn } from '../authorize-turn';
import { waitForCommandCompletion, saveMessages } from '../command-helpers-1';
import { isAssignedChannelCommand } from '@/lib/connectors/channel-command-row';
const mockId=randomUUID(), site_id=randomUUID(), agentId=randomUUID(), userId=randomUUID(), conversationId=randomUUID();
const turn = {message:'Question',site_id,agentId,team_member_id:userId,conversationId,lead_id:undefined,visitor_id:undefined};
const mockSubmit=jest.fn(), mockCommand=jest.fn();
jest.mock('@/lib/services/ai/command-http-routing',()=>({withAuthorizedCommandRequest:(r:Request,h:(r:Request)=>Promise<Response>)=>h(r)}));
jest.mock('../authorize-turn',()=>({authorizeChatTurn:jest.fn()}));
jest.mock('@/lib/agentbase',()=>({ProcessorInitializer:{getInstance:()=>({initialize:()=>{},getCommandService:()=>({submitCommand:mockSubmit})})},
  CommandFactory:{createCommand:(value:unknown)=>mockCommand(value)}}));
jest.mock('@/lib/connectors/channel-member-host',()=>({enableMemberConversationGateway:jest.fn()}));
jest.mock('@/lib/connectors/channel-command-row',()=>({isAssignedChannelCommand:jest.fn()}));
jest.mock('../tools',()=>({buildChatMessageTools:()=>[]}));
jest.mock('../command-helpers-1',()=>({isValidUUID:()=>true,getCommandDbUuid:()=>mockId,waitForCommandCompletion:jest.fn(),saveMessages:jest.fn()}));
jest.mock('../command-helpers-2',()=>({getAgentInfo:()=>({user_id:'not-the-caller'}),getTeamMemberInfo:()=>null,getConversationHistory:()=>[]}));
const request=()=>new Request('https://api.example.test/chat',{method:'POST',body:JSON.stringify({agentId:randomUUID(),site_id:randomUUID()})});
const completed = {id:mockId,site_id,agent_id:agentId,user_id:userId,status:'completed',results:[{message:{content:'Answer'}}]};
beforeEach(()=>{
  jest.clearAllMocks(); jest.mocked(authorizeChatTurn).mockResolvedValue(turn);
  mockCommand.mockImplementation(x=>x); mockSubmit.mockResolvedValue(mockId);
  jest.mocked(waitForCommandCompletion).mockResolvedValue({command:completed,dbUuid:mockId,completed:true});
  jest.mocked(isAssignedChannelCommand).mockResolvedValue(true);
  jest.mocked(saveMessages).mockResolvedValue({conversationId,userMessageId:randomUUID(),assistantMessageId:randomUUID(),userRole:'team_member',conversationTitle:undefined});
});
it('uses only the verified scope for submission and checks the raw stored command before saving the reply',async()=>{
  expect((await POST(request())).status).toBe(200);expect(mockCommand).toHaveBeenCalledWith(expect.objectContaining({site_id,agentId,userId}));
  expect(isAssignedChannelCommand).toHaveBeenCalledWith(mockId,site_id,agentId,userId);
  expect(saveMessages).toHaveBeenCalledWith(userId,turn.message,'Answer',conversationId,undefined,undefined,undefined,agentId,userId,mockId,'web');
});
it.each(['row mismatch','agent mismatch','tool output','reassigned'])('withholds unconfirmed reply: %s',async scenario=>{
  if(scenario==='row mismatch') jest.mocked(isAssignedChannelCommand).mockResolvedValue(false);
  if(scenario==='agent mismatch') jest.mocked(waitForCommandCompletion).mockResolvedValue({command:{...completed,agent_id:randomUUID()},dbUuid:mockId,completed:true});
  if(scenario==='tool output') jest.mocked(waitForCommandCompletion).mockResolvedValue({command:{...completed,results:[{type:'tool',content:'hidden'}]},dbUuid:mockId,completed:true});
  if(scenario==='reassigned') jest.mocked(authorizeChatTurn).mockResolvedValueOnce(turn).mockResolvedValueOnce(new Response(null,{status:409}));
  const response=await POST(request());expect(response.status).toBeGreaterThanOrEqual(400);expect(await response.text()).not.toContain('hidden');expect(saveMessages).not.toHaveBeenCalled();
});
