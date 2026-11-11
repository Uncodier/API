jest.mock('@/lib/services/channels/automation-send-guard', () => ({
  ...jest.requireActual('@/lib/services/channels/automation-send-guard'), assertAutomationSendAllowed: jest.fn(async () => undefined),
}));
import { randomUUID } from 'node:crypto';
import { AgentMailSendService } from '../AgentMailSendService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendMessage } from '@/lib/integrations/agentmail/agentmail-service';
import { EmailTrackingService } from '@/lib/services/tracking/EmailTrackingService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';

jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn()}}));
jest.mock('@/lib/integrations/agentmail/agentmail-service',()=>({sendMessage:jest.fn()}));
jest.mock('@/lib/services/tracking/EmailTrackingService',()=>({EmailTrackingService:{injectTracking:jest.fn((html:string)=>html)}}));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService',()=>({SyncedObjectsService:{createObject:jest.fn()}}));
jest.mock('../EmailSendService',()=>({EmailSendService:{applyInlineMarkdown:(text:string)=>text,renderMessageWithLists:(text:string)=>text}}));

const params=()=>({email:'recipient@example.test',subject:'Offline test',message:'Hello',site_id:randomUUID(),
  username:'sender',domain:'example.test',senderEmail:'sender@example.test'});

beforeEach(()=>{
  jest.clearAllMocks();
  jest.mocked(sendMessage).mockResolvedValue({message_id:randomUUID(),thread_id:randomUUID()} as never);
});

it.each([undefined,'','   '])('does not insert an orphan tracking message for conversation %j',async conversation_id=>{
  const input={...params(),conversation_id};
  const result=await AgentMailSendService.sendViaAgentMail(input);
  expect(result.success).toBe(true);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(EmailTrackingService.injectTracking).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(SyncedObjectsService.createObject).toHaveBeenCalledWith(expect.objectContaining({site_id:input.site_id,object_type:'sent_email'}));
});

it('retains tracking when a conversation parent is supplied',async()=>{
  const conversation_id=randomUUID(),trackingId=randomUUID();
  const query:any={insert:jest.fn(),select:jest.fn(),single:jest.fn(),update:jest.fn(),eq:jest.fn()};
  for(const key of ['insert','select','update','eq'])query[key].mockReturnValue(query);
  query.single.mockResolvedValue({data:{id:trackingId,custom_data:{}},error:null});
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
  await AgentMailSendService.sendViaAgentMail({...params(),conversation_id});
  expect(query.insert).toHaveBeenCalledWith([expect.objectContaining({conversation_id})]);
  expect(EmailTrackingService.injectTracking).toHaveBeenCalledWith(expect.any(String),trackingId);
});

it('preserves centrally owned tracking without requiring another conversation insert',async()=>{
  const trackingId=randomUUID();
  await AgentMailSendService.sendViaAgentMail({...params(),trackingId,preserveMessageMetadata:true});
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(EmailTrackingService.injectTracking).toHaveBeenCalledWith(expect.any(String),trackingId);
});

it('does not claim delivery or save a sent receipt when the provider rejects',async()=>{
  const error=new Error('Synthetic provider rejection');
  jest.mocked(sendMessage).mockRejectedValueOnce(error);
  await expect(AgentMailSendService.sendViaAgentMail(params())).rejects.toBe(error);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(SyncedObjectsService.createObject).not.toHaveBeenCalled();
});