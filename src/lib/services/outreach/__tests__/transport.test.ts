jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({ placeTrackedVoiceCall: jest.fn() }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async (s: string) => new URL(s)) }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { isValidEmail: (s: string) => s.includes('@'), sendEmail: jest.fn() } }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({ EmailSignatureService: { generateAgentSignature: jest.fn(async () => ({ formatted: '' })) } }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {
  checkResponseWindow: jest.fn(), findExistingTemplate: jest.fn(), checkTemplateApprovalStatus: jest.fn(),
} }));
jest.mock('@/lib/services/whatsapp/twilio-whatsapp-transport', () => ({ sendTwilioWhatsAppMessage: jest.fn() }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: (s: string) => s }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({
  personalizeMergeSubjectAndMessage: (subject: string, message: string) => ({ subject, message }),
  fetchSiteNameForMerge: async () => 'Site', buildContentVariablesForLead: () => ({ variables: { '1': 'Ada' } }),
}));
import { prepareOutreachDelivery, type DeliveryContext } from '../transport';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { placeTrackedVoiceCall } from '@/lib/services/zavu/voice-call-service';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

const context = (): DeliveryContext => ({
  siteId: 'site', lead: { id: 'lead', email: 'lead@example.com', phone: '+15551234567' },
  conversation: { id: 'conversation' }, message: { id: 'message', content: 'Hello Ada', custom_data: { title: 'Hi!' } },
  account: { id: 'raw-hi-uuid', provider: 'zavu', channel: 'email', config: { zavu_sender_id: 'exact-hi-sender' } },
});
beforeEach(() => { jest.clearAllMocks(); });

test.each(['sms', 'telegram', 'messenger', 'instagram', 'custom_chat'])('exact selected %s sender and server recipient, no email fallback', async channel => {
  const ctx = context(); ctx.account.channel = channel;
  ctx.lead.social_networks = { [channel]: { chat_id: 'known-chat' } };
  (sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'message-id' } });
  const prepared = await prepareOutreachDelivery(ctx);
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await prepared.send();
  expect(sendChannelMessage).toHaveBeenCalledWith({ to: channel === 'sms' ? ctx.lead.phone : 'known-chat', text: 'Hello Ada', channel, senderId: 'exact-hi-sender' });
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled();
});
test('inaccessible telegram recipient defers instead of using phone or email', async () => {
  const ctx = context(); ctx.account.channel = 'telegram';
  expect(await prepareOutreachDelivery(ctx)).toEqual({ reason: 'invalid_recipient' });
  expect(sendChannelMessage).not.toHaveBeenCalled(); expect(EmailSendService.sendEmail).not.toHaveBeenCalled();
});
test('voice dispatch is tracked exact selected consented call, never generic text', async () => {
  const ctx = context(); ctx.account.channel = 'voice';
  ctx.lead.voice_call_consent_status = 'granted'; ctx.lead.voice_call_consent_at = '2026-01-01T12:00:00Z';
  (placeTrackedVoiceCall as jest.Mock).mockResolvedValue({ call: { id: 'call-id' }, deliveryId: 'delivery-id' });
  const prepared = await prepareOutreachDelivery(ctx);
  expect(placeTrackedVoiceCall).not.toHaveBeenCalled();
  if (!('send' in prepared)) throw new Error(prepared.reason);
  expect(await prepared.send()).toEqual({ success: true, messageId: 'call-id' });
  expect(placeTrackedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ selectedConnectionId: 'raw-hi-uuid', selectedSenderId: 'exact-hi-sender',
    siteId: 'site', leadId: 'lead', messageId: 'message', greeting: 'Hello Ada', to: ctx.lead.phone }));
  expect(sendChannelMessage).not.toHaveBeenCalled();
});
test('voice without consent blocked before dispatch', async () => {
  const ctx = context(); ctx.account.channel = 'voice';
  expect(await prepareOutreachDelivery(ctx)).toEqual({ reason: 'voice_consent_required' });
  expect(placeTrackedVoiceCall).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
});
test('saved audio format/media retained and URL validated without fetching', async () => {
  const ctx = context(); ctx.account.channel = 'telegram'; ctx.lead.social_networks = { telegram: 'chat-1' };
  Object.assign(ctx.message.custom_data, { message_type: 'audio', media_url: 'https://cdn.example.com/audio.mp3', mime_type: 'audio/mpeg' });
  (sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'audio-id' } });
  const prepared = await prepareOutreachDelivery(ctx);
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await prepared.send();
  expect(assertSafeRemoteUrl).toHaveBeenCalledWith('https://cdn.example.com/audio.mp3');
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'telegram', messageType: 'audio', content: { mediaUrl: 'https://cdn.example.com/audio.mp3', mimeType: 'audio/mpeg' } }));
  (assertSafeRemoteUrl as jest.Mock).mockRejectedValueOnce(new Error('private URL'));
  expect(await prepareOutreachDelivery(ctx)).toEqual({ reason: 'invalid_media_url' });
});

test('selected Zavu hi email invokes exact sender and recipient, never implicit account lookup', async () => {
  (sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'zavu-id' } });
  const prepared = await prepareOutreachDelivery(context());
  expect(sendChannelMessage).not.toHaveBeenCalled(); // preparation read-only
  if (!('send' in prepared)) throw new Error(prepared.reason);
  expect(await prepared.send()).toEqual({ success: true, messageId: 'zavu-id' });
  expect(sendChannelMessage).toHaveBeenCalledWith({ to: 'lead@example.com', text: 'Hello Ada', channel: 'email', senderId: 'exact-hi-sender', subject: 'Hi!' });
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled(); expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
});
test('Zavu failure does not retry or fall back to SMTP, AgentMail or Twilio', async () => {
  (sendChannelMessage as jest.Mock).mockRejectedValue(new Error('ambiguous network error'));
  const prepared = await prepareOutreachDelivery(context());
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await expect(prepared.send()).rejects.toThrow('ambiguous');
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled(); expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled(); expect(sendTwilioWhatsAppMessage).not.toHaveBeenCalled();
});
test('Zavu WhatsApp uses phone unchanged with exact sender', async () => {
  const ctx = context(); ctx.account.channel = 'whatsapp';
  (sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'wa-id' } });
  const prepared = await prepareOutreachDelivery(ctx);
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await prepared.send();
  expect(sendChannelMessage).toHaveBeenCalledWith({ to: '+15551234567', text: 'Hello Ada', channel: 'whatsapp', senderId: 'exact-hi-sender' });
});
test('explicit AgentMail fails without falling through to SMTP', async () => {
  process.env.AGENTMAIL_API_KEY = 'test';
  const ctx = context(); ctx.account = { id: 'agent_email', provider: 'agent_email', channel: 'email', config: { username: 'hi', domain: 'example.com' } };
  (AgentMailSendService.sendViaAgentMail as jest.Mock).mockRejectedValue(new Error('provider failed'));
  const prepared = await prepareOutreachDelivery(ctx);
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await expect(prepared.send()).rejects.toThrow();
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
  delete process.env.AGENTMAIL_API_KEY;
});
test('explicit SMTP pins fresh selected credentials, refuses another account token', async () => {
  const ctx = context(); ctx.account = { id: 'email', provider: 'email', channel: 'email', config: { email: 'hi@example.com' } };
  const query: any = { select: () => query, eq: () => query, then: (resolve: any) => Promise.resolve(resolve({ data: [{ identifier: 'other@example.com', encrypted_value: 'secret' }], error: null })) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  expect(await prepareOutreachDelivery(ctx)).toEqual({ reason: 'selected_account_unavailable' });
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled(); expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
});
test('approved exact template on selected Twilio account sends once under same closure', async () => {
  const ctx = context(); ctx.account = { id: 'whatsapp', provider: 'whatsapp', channel: 'whatsapp', config: { account_sid: 'AC-selected', access_token: 'selected-secret', from_number: '+15557654321' } };
  (WhatsAppTemplateService.checkResponseWindow as jest.Mock).mockResolvedValue({ withinWindow: false });
  (WhatsAppTemplateService.findExistingTemplate as jest.Mock).mockResolvedValue({ templateSid: 'HX-exact', templatedBody: 'Hello {{1}}', placeholderMap: ['lead.name'] });
  (WhatsAppTemplateService.checkTemplateApprovalStatus as jest.Mock).mockResolvedValue({ approved: true });
  (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue({ success: true, messageId: 'SM-id' });
  const prepared = await prepareOutreachDelivery(ctx);
  expect(sendTwilioWhatsAppMessage).not.toHaveBeenCalled();
  if (!('send' in prepared)) throw new Error(prepared.reason);
  await prepared.send();
  expect(WhatsAppTemplateService.findExistingTemplate).toHaveBeenCalledWith('Hello Ada', 'site', 'AC-selected', { approvedExactOnly: true, trackUsage: false });
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledWith(expect.objectContaining({ accountSid: 'AC-selected', authToken: 'selected-secret', fromNumber: '+15557654321', strictSingleMessage: true, contentSid: 'HX-exact', contentVariables: { '1': 'Ada' } }));
});
test('missing approved template defers without creating or sending', async () => {
  const ctx = context(); ctx.account = { id: 'whatsapp', provider: 'whatsapp', channel: 'whatsapp', config: { account_sid: 'AC-selected', access_token: 'selected-secret' } };
  (WhatsAppTemplateService.checkResponseWindow as jest.Mock).mockResolvedValue({ withinWindow: false });
  (WhatsAppTemplateService.findExistingTemplate as jest.Mock).mockResolvedValue({});
  expect(await prepareOutreachDelivery(ctx)).toEqual({ reason: 'approved_template_required' });
  expect(sendTwilioWhatsAppMessage).not.toHaveBeenCalled();
});