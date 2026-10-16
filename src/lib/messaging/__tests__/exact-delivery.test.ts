import { randomBytes } from 'node:crypto';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({ assertVoiceCallAllowed: jest.fn(), placeTrackedVoiceCall: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {
  isValidEmail: (s: string) => /^[^@]+@[^@]+\.[^@]+$/.test(s), sendEmail: jest.fn(),
} }));
jest.mock('../exact-email-content', () => ({ exactEmailContent: (text: string) => ({ text, htmlBody: text }) }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({ EmailSignatureService: { generateAgentSignature: jest.fn(async () => ({ formatted: 'Signature' })) } }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {
  checkResponseWindow: jest.fn(), findExistingTemplate: jest.fn(), checkTemplateApprovalStatus: jest.fn(),
} }));
jest.mock('@/lib/services/whatsapp/twilio-whatsapp-transport', () => ({ sendTwilioWhatsAppMessage: jest.fn() }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: (s: string) => s }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({
  personalizeMergeSubjectAndMessage: (subject: string, message: string) => ({ subject, message }),
  fetchSiteNameForMerge: async () => 'Site', placeholderPolicyToMergePolicy: () => 'strip_unresolved',
  buildContentVariablesForLead: () => ({ variables: { '1': 'Ada' } }),
  resolveNumberedTemplate: (text: string) => text.replace(/\{\{1\}\}/g, 'Ada'),
}));
import { sendExactDelivery, getExactWhatsAppConfig } from '../exact-delivery';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { placeTrackedVoiceCall } from '@/lib/services/zavu/voice-call-service';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';

const siteId = '11111111-1111-4111-8111-111111111111';
let channels: any;
let tokens: any[];
let storedMessage: any;
let conversation: any;
let lead: any;
let templates: any[];
const connected = (id: string, channel: string) => ({ id, type: channel, status: 'connected', zavu_sender_id: `${id}-sender` });
const base = () => ({ site_id: siteId, channel: 'email' as const, connection_id: 'selected', to: 'ada@example.com', message: 'Hello' });

beforeEach(() => {
  jest.clearAllMocks();
  channels = { connections: [connected('first', 'email'), connected('selected', 'email')] };
  tokens = []; templates = []; storedMessage = null; conversation = null; lead = null;
  (sendChannelMessage as jest.Mock).mockResolvedValue({ success: true, message: { id: 'provider-id', status: 'queued' } });
  (EmailSendService.sendEmail as jest.Mock).mockResolvedValue({ success: true, status: 'sent', envelope_id: 'smtp-id' });
  (AgentMailSendService.sendViaAgentMail as jest.Mock).mockResolvedValue({ success: true, status: 'sent', external_message_id: 'agent-id' });
  (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue({ success: true, messageId: 'twilio-id' });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const filters: any = {}; const q: any = {};
    q.select = () => q; q.eq = (k: string, v: unknown) => { filters[k] = v; return q; };
    const result = () => ({ error: null, data: table === 'settings' ? { channels }
      : table === 'secure_tokens' ? tokens.filter(t => t.token_type === filters.token_type)
      : table === 'messages' ? storedMessage
      : table === 'conversations' ? conversation?.site_id === filters.site_id ? conversation : null
      : table === 'leads' ? lead : null });
    const originalResult = result;
    const scopedResult = () => table === 'whatsapp_templates' ? { error: null,
      data: templates.find(t => t.site_id === filters.site_id && t.account_sid === filters.account_sid && t.template_sid === filters.template_sid) || null } : originalResult();
    q.single = q.maybeSingle = async () => scopedResult();
    q.then = (resolve: any) => Promise.resolve(scopedResult()).then(resolve);
    return q;
  });
});

test.each(['email', 'whatsapp', 'sms', 'telegram', 'voice'] as const)('sends selected Zavu %s and never first connection', async channel => {
  channels.connections = [connected('first', channel), connected('selected', channel)];
  const to = channel === 'email' ? 'ada@example.com' : channel === 'telegram' ? '-100123456' : '+15551234567';
  expect((await sendExactDelivery({ ...base(), channel, to })).success).toBe(true);
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ channel, to, senderId: 'selected-sender', text: 'Hello' }));
  expect(sendTwilioWhatsAppMessage).not.toHaveBeenCalled();
  expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled();
});

test.each(['missing', 'disabled', 'wrong-channel', 'duplicate', 'senderless'])('refuses %s connection without any transport', async scenario => {
  const c = channels.connections[1];
  if (scenario === 'missing') channels.connections.pop();
  if (scenario === 'disabled') c.enabled = false;
  if (scenario === 'wrong-channel') c.type = 'whatsapp';
  if (scenario === 'duplicate') channels.connections.push({ ...c });
  if (scenario === 'senderless') delete c.zavu_sender_id;
  expect((await sendExactDelivery(base())).success).toBe(false);
  expect(sendChannelMessage).not.toHaveBeenCalled(); expect(EmailSendService.sendEmail).not.toHaveBeenCalled();
});

test('live retry revalidates inventory and does not use stale sender', async () => {
  expect((await sendExactDelivery(base())).success).toBe(true);
  channels.connections[1].status = 'disconnected';
  expect((await sendExactDelivery(base())).success).toBe(false);
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
});

test('connection changing during preparation refuses before invoking dispatch receipt or transport', async () => {
  const before = jest.fn();
  let settingsReads = 0;
  const originalFrom = (supabaseAdmin.from as jest.Mock).getMockImplementation()!;
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (table === 'settings' && ++settingsReads === 2) channels.connections[1].enabled = false;
    return originalFrom(table);
  });
  expect((await sendExactDelivery({ ...base(), before_dispatch: before })).success).toBe(false);
  expect(before).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('AgentMail pins selected inbox; failure never reaches SMTP or Zavu; newsletter omits signature', async () => {
  process.env.AGENTMAIL_API_KEY = randomBytes(24).toString('hex');
  channels.agent_email = { status: 'active', username: 'selected', domain: 'example.com' };
  const input = { ...base(), connection_id: 'legacy:agent_email', omit_signature: true };
  expect((await sendExactDelivery(input)).success).toBe(true);
  expect(AgentMailSendService.sendViaAgentMail).toHaveBeenCalledWith(expect.objectContaining({ senderEmail: 'selected@example.com', username: 'selected', domain: 'example.com', signatureHtml: '', preserveMessageMetadata: true }));
  expect(EmailSignatureService.generateAgentSignature).not.toHaveBeenCalled();
  (AgentMailSendService.sendViaAgentMail as jest.Mock).mockRejectedValue(new Error('provider failed'));
  expect((await sendExactDelivery(input)).success).toBe(false);
  expect(EmailSendService.sendEmail).not.toHaveBeenCalled(); expect(sendChannelMessage).not.toHaveBeenCalled();
  delete process.env.AGENTMAIL_API_KEY;
});

test('SMTP pins exact labelled credentials and rejects different-account tokens', async () => {
  const password = randomBytes(24).toString('hex');
  channels.email = { status: 'active', email: 'selected@example.com', outgoingServer: 'smtp.example.com' };
  tokens = [{ token_type: 'email', identifier: 'selected@example.com', value: JSON.stringify({ email: 'selected@example.com', password }) }];
  expect((await sendExactDelivery({ ...base(), connection_id: 'legacy:email' })).success).toBe(true);
  expect(EmailSendService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ fromEmail: 'selected@example.com', smtpConfig: expect.objectContaining({ password, user: 'selected@example.com' }) }));
  tokens[0].identifier = 'foreign@example.com';
  expect((await sendExactDelivery({ ...base(), connection_id: 'legacy:email' })).success).toBe(false);
  expect(EmailSendService.sendEmail).toHaveBeenCalledTimes(1);
});

test.each(['whatsapp', 'agent_whatsapp'])('Twilio %s pins account/sender and approved exact template', async provider => {
  const accessToken = randomBytes(24).toString('hex');
  channels[provider] = { status: 'active', account_sid: 'AC-selected', access_token: accessToken, existingNumber: '+15557654321' };
  (WhatsAppTemplateService.checkResponseWindow as jest.Mock).mockResolvedValue({ withinWindow: false });
  (WhatsAppTemplateService.findExistingTemplate as jest.Mock).mockResolvedValue({ templateSid: 'HX-selected', placeholderMap: ['lead.name'] });
  (WhatsAppTemplateService.checkTemplateApprovalStatus as jest.Mock).mockResolvedValue({ approved: true });
  const input = { ...base(), message: 'Hello there Ada', channel: 'whatsapp' as const, connection_id: `legacy:${provider}`, to: '+15551234567' };
  expect((await sendExactDelivery(input)).success).toBe(true);
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledWith(expect.objectContaining({ accountSid: 'AC-selected', authToken: accessToken, fromNumber: '+15557654321', strictSingleMessage: true, contentSid: 'HX-selected', contentVariables: { '1': 'Ada' } }));
  expect(WhatsAppTemplateService.findExistingTemplate).toHaveBeenCalledWith('Hello there Ada', siteId, 'AC-selected', { approvedExactOnly: true, trackUsage: false });
  (WhatsAppTemplateService.checkTemplateApprovalStatus as jest.Mock).mockResolvedValue({ approved: false });
  expect((await sendExactDelivery(input)).success).toBe(false);
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(1); expect(sendChannelMessage).not.toHaveBeenCalled();
});

test('WhatsApp prepare config returns null only for valid Zavu and throws for invalid exact selection', async () => {
  channels.connections = [connected('selected', 'whatsapp')];
  expect(await getExactWhatsAppConfig(siteId, 'selected')).toBeNull();
  channels.connections[0].enabled = false;
  await expect(getExactWhatsAppConfig(siteId, 'selected')).rejects.toThrow();
});

test('configured WhatsApp token uses exact sender label and refuses ambiguous account/sender credentials', async () => {
  const token = randomBytes(24).toString('hex');
  channels.whatsapp = { status: 'active', account_sid: 'AC-selected', existingNumber: '+15557654321' };
  tokens = [{ token_type: 'twilio_whatsapp', identifier: '+15557654321', value: token }];
  expect(await getExactWhatsAppConfig(siteId, 'legacy:whatsapp')).toMatchObject({ accessToken: token, phoneNumberId: 'AC-selected', fromNumber: '+15557654321' });
  tokens.push({ token_type: 'twilio_whatsapp', identifier: 'AC-selected', value: randomBytes(24).toString('hex') });
  await expect(getExactWhatsAppConfig(siteId, 'legacy:whatsapp')).rejects.toThrow();
  tokens = [{ token_type: 'twilio_whatsapp', identifier: '+15558888888', value: token }];
  await expect(getExactWhatsAppConfig(siteId, 'legacy:whatsapp')).rejects.toThrow();
});

test('queued numbered Twilio template is account/site-bound, variables rebuilt, never substitutes foreign template', async () => {
  channels.whatsapp = { status: 'active', account_sid: 'AC-selected', access_token: randomBytes(24).toString('hex'), from_number: '+15557654321' };
  storedMessage = { id: 'message', content: 'Hello\n\n{{1}}', conversation_id: 'conversation', lead_id: 'lead', custom_data: {
    connection_id: 'legacy:whatsapp', channel: 'whatsapp', template_sid: 'HX-queued', placeholder_map: ['lead.name'],
  } };
  conversation = { id: 'conversation', site_id: siteId }; lead = { id: 'lead', site_id: siteId, name: 'Ada' };
  templates = [{ site_id: siteId, account_sid: 'AC-selected', template_sid: 'HX-queued', templated_body: 'Hello {{1}}', placeholder_map: ['lead.name'], status: 'active' }];
  (WhatsAppTemplateService.checkResponseWindow as jest.Mock).mockResolvedValue({ withinWindow: false });
  (WhatsAppTemplateService.checkTemplateApprovalStatus as jest.Mock).mockResolvedValue({ approved: true });
  const input = { ...base(), channel: 'whatsapp' as const, connection_id: 'legacy:whatsapp', to: '+15551234567', message_id: 'message' };
  expect((await sendExactDelivery(input)).success).toBe(true);
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledWith(expect.objectContaining({ contentSid: 'HX-queued', contentVariables: { '1': 'Ada' }, message: 'Hello\n\nAda', accountSid: 'AC-selected' }));
  expect(WhatsAppTemplateService.findExistingTemplate).not.toHaveBeenCalled();
  templates[0].account_sid = 'AC-foreign';
  expect((await sendExactDelivery(input)).success).toBe(false);
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(1);
  templates[0].account_sid = 'AC-selected'; templates[0].site_id = 'foreign-site';
  expect((await sendExactDelivery(input)).success).toBe(false);
  expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(1);
});

test('queued message beats conversation selection; foreign conversation and malformed selected metadata fail closed', async () => {
  storedMessage = { id: 'message', content: 'Stored content', conversation_id: 'conversation', custom_data: { connection_id: 'selected', channel: 'email' } };
  conversation = { id: 'conversation', site_id: siteId, custom_data: { connection_id: 'first' } };
  expect((await sendExactDelivery({ ...base(), message_id: 'message' })).success).toBe(true);
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Stored content', senderId: 'selected-sender' }));
  storedMessage.custom_data.connection_id = '';
  expect((await sendExactDelivery({ ...base(), message_id: 'message' })).success).toBe(false);
  storedMessage.custom_data.connection_id = 'selected'; conversation.site_id = 'foreign';
  expect((await sendExactDelivery({ ...base(), message_id: 'message' })).success).toBe(false);
  expect(sendChannelMessage).toHaveBeenCalledTimes(1);
});

test('tracked Voice preserves queued objective/context and exact connection', async () => {
  channels.connections = [connected('first', 'voice'), connected('selected', 'voice')];
  storedMessage = { id: 'message', content: 'Stored greeting', conversation_id: 'conversation', lead_id: 'lead', custom_data: {
    connection_id: 'selected', channel: 'voice', voice_mode: 'agent_call', voice_objective: 'Stored objective', voice_additional_context: 'Stored context',
  } };
  conversation = { id: 'conversation', site_id: siteId }; lead = { id: 'lead', site_id: siteId, phone: '+15551234567' };
  (placeTrackedVoiceCall as jest.Mock).mockResolvedValue({ call: { id: 'call', status: 'queued' }, deliveryId: 'delivery', duplicate: false });
  expect((await sendExactDelivery({ ...base(), channel: 'voice', to: lead.phone, message_id: 'message', objective: 'Untrusted override' })).success).toBe(true);
  expect(placeTrackedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ selectedConnectionId: 'selected', selectedSenderId: 'selected-sender', objective: 'Stored objective', additionalContext: 'Stored context', greeting: 'Stored greeting' }));
  expect(sendChannelMessage).not.toHaveBeenCalled();
});