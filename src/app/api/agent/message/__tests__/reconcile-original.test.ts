import { randomUUID } from 'node:crypto';
import { reconcileChannelMessage, type VerifiedChannelMessage } from '@/lib/services/channels/admit-message';
import { pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { inboundDatabase, SITE, OTHER_SITE } from '@/lib/services/zavu/__tests__/inbound-lead-test-database';
const mockFrom = jest.fn(), mockRead = jest.fn(), mockStart = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({supabaseAdmin:{schema:()=>({from:mockFrom})}}));
jest.mock('@/lib/services/workflow-service', () => ({WorkflowService:{getInstance:()=>({getFinishedWorkflowResult:mockRead,customerSupportMessage:mockStart})}}));
const input: VerifiedChannelMessage = { siteId:SITE,channel:'telegram',connectionId:'b',originMessageId:'shared',message:'',attachments:[],
  source:{provider:'zavu',senderId:'sender-b',from:'telegram:customer'} };
function fixture(media = false) {
  const id = randomUUID(); const content = media ? 'Photo' : 'Reply';
  const shape = media ? {media_url:'https://assets.example.test/p.jpg',message_type:'image',mime_type:'image/jpeg'} : {};
  const shared = {conversation_id:'thread','conversations.site_id':SITE,conversations:{site_id:SITE,channel:'telegram'}};
  const data = {connection_id:'b',origin_message_id:'shared'};
  const receipt = {id,state:'accepted',provider:'zavu',site_id:SITE,conversation_id:'thread',message_id:'reply',inbound_message_id:'user',
    origin_message_id:'shared',connection_id:'b',sender_id:'sender-b',recipient:'customer',zavu_from:'telegram:customer',channel:'telegram',
    provider_message_id:'placed',payload_hash:pinnedReplyPayloadHash(content,shape)};
  const db = inboundDatabase(mockFrom,{messages:[{...shared,id:'user',role:'user',content:'Hello',custom_data:{...data,
    channel:'telegram',source:'zavu_inbound_message',zavu_sender_id:'sender-b',zavu_from:'telegram:customer'}},
    {...shared,id:'reply',role:'assistant',content,custom_data:{...data,...shape,reply_to_message_id:'user',status:'queued',
      provider_message_id:'placed',[media?'native_media_delivery':'pinned_text_delivery']:receipt}}]});
  return {db,r:db.tables.messages[1],u:db.tables.messages[0],receipt};
}
beforeEach(()=>{ jest.clearAllMocks(); mockRead.mockRejectedValue(new Error('History has expired')); });
afterEach(()=>expect(mockStart).not.toHaveBeenCalled());

test.each([true,false])('after Temporal retention the original persisted provider acknowledgement resolves the claim (media=%s)',async media=>{
  const {db} = fixture(media);
  expect(await reconcileChannelMessage(input)).toMatchObject({state:'accepted',stage:'delivery',messageId:'reply',sendWorkflowId:'send-channel-reply-reply'});
  expect(db.operations.every(op=>op.kind === 'read')).toBe(true);
});
test.each(['changed_file','changed_text','other_inbound','other_site','other_sender','copied_attempt','provider_conflict','ambiguous','two_receipts','no_id'])('cannot reconcile %s by guessing',async reason=>{
  const {r,u,db} = fixture(true); const a = r.custom_data.native_media_delivery;
  switch(reason){
    case 'changed_file': r.custom_data.media_url += '?changed';break;
    case 'changed_text': r.content += '!';break;
    case 'other_inbound': r.custom_data.reply_to_message_id = 'other';break;
    case 'other_site': r['conversations.site_id'] = OTHER_SITE;break;
    case 'other_sender': u.custom_data.zavu_sender_id = 'a';break;
    case 'copied_attempt': a.message_id = 'another';break;
    case 'provider_conflict': r.custom_data.provider_message_id = 'other';break;
    case 'ambiguous': db.tables.messages.push({...r,id:'second'});break;
    case 'two_receipts': r.custom_data.audio_delivery = {state:'sent'};break;
    case 'no_id': delete r.custom_data.provider_message_id;break;
  }
  await expect(reconcileChannelMessage(input)).rejects.toMatchObject({report:{state:'unknown'}});
  expect(db.operations.every(op=>op.kind === 'read')).toBe(true);
});
test('provider rejection remains failed even if the inbound history later records a pause',async()=>{
  const {r,u} = fixture();u.custom_data.automation_suppressed = true;r.custom_data.status='failed';r.custom_data.pinned_text_delivery.state='failed';
  await expect(reconcileChannelMessage(input)).rejects.toMatchObject({report:{state:'failed',messageId:'reply'}});
});
test('an in-flight or timed out attempt is not mistaken for a skipped message or an approved draft',async()=>{
  const {r,u} = fixture(); u.custom_data.automation_suppressed=true;r.custom_data.status='pending';r.custom_data.pinned_text_delivery.state='attempting';
  delete r.custom_data.provider_message_id;
  await expect(reconcileChannelMessage(input)).rejects.toMatchObject({report:{state:'unknown'}});
});
test('only the saved history or pending approval, not the generic workflow flag, proves a terminal non-send',async()=>{
  const {r,u,db} = fixture();r.custom_data.status='pending';delete r.custom_data.pinned_text_delivery;delete r.custom_data.provider_message_id;
  expect(await reconcileChannelMessage(input)).toMatchObject({state:'draft'});
  db.tables.messages.pop();u.custom_data.automation_suppressed=true;
  u.custom_data.suppression_reason='license_check_unavailable';
  await expect(reconcileChannelMessage(input)).rejects.toMatchObject({report:{state:'unknown'}});
  u.custom_data.suppression_reason='channel_unavailable';
  expect(await reconcileChannelMessage(input)).toMatchObject({state:'suppressed'});
  delete u.custom_data.automation_suppressed;
  await expect(reconcileChannelMessage(input)).rejects.toMatchObject({report:{state:'unknown'}});
});
