import { ChannelSendService } from '../ChannelSendService';
import { assertAutomationSendAllowed, AutomationSendSuppressed } from '../automation-send-guard';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { tryPrepareLongReplyAudio } from '../long-reply-audio';
import { POST } from '@/app/api/agents/tools/sendChannelMessage/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('../automation-send-guard', () => ({ ...jest.requireActual('../automation-send-guard'), assertAutomationSendAllowed: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({ assertVoiceCallAllowed: jest.fn() }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn(async () => true) }));
jest.mock('@/lib/integrations/outstand/inbox-sync', () => ({ bindLocalOutstandMessage: jest.fn() }));
jest.mock('@/lib/integrations/outstand/client', () => ({ getOutstandClient: jest.fn() }));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({ authorizeOutstandConversation: jest.fn() }));
jest.mock('@/lib/services/social-comments/delivery', () => ({ sendCommentReply: jest.fn() }));
jest.mock('../long-reply-audio', () => ({ tryPrepareLongReplyAudio: jest.fn() }));
jest.mock('../explicit-audio-delivery', () => ({ deliverExplicitAudio: jest.fn(), markAudioPreflightFailed: jest.fn(), AudioDeliveryError: class extends Error {} }));
jest.mock('@/lib/services/whatsapp/zavu-template-delivery', () => ({ deliverZavuTemplate: jest.fn(), TemplateDeliveryError: class extends Error {} }));
jest.mock('@/lib/billing/licensed-resources', () => ({
  getSiteLicensedResources: jest.fn(async () => ({ channels: { connections: [{ id: 'connection', type: 'telegram', zavu_sender_id: 'sender' }] } })),
  isLicensedChannelConnection: jest.fn(() => true), requireLicensedChannel: jest.fn(),
}));
const input = { site_id: 'site', conversation_id: 'conversation', message_id: 'message',
  channel: 'telegram', to: 'recipient', message: 'Reply prepared before human handoff' };

beforeEach(() => { jest.clearAllMocks(); jest.mocked(assertAutomationSendAllowed).mockReset(); });

test('human handoff during long audio preparation suppresses at provider boundary', async () => {
  jest.mocked(assertAutomationSendAllowed).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AutomationSendSuppressed('agent_snoozed'));
  jest.mocked(tryPrepareLongReplyAudio).mockResolvedValue({ audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg' } as any);
  const result = await ChannelSendService.sendMessage(input);
  expect(tryPrepareLongReplyAudio).toHaveBeenCalledTimes(1);
  expect(assertAutomationSendAllowed).toHaveBeenCalledTimes(2);
  expect(sendChannelMessage).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, skipped: true, reason: 'agent_snoozed', delivered: false });
});

test('HTTP skip is terminal success without sent metadata writes or receipt validation', async () => {
  jest.mocked(assertAutomationSendAllowed).mockRejectedValue(new AutomationSendSuppressed('stale_automatic_reply'));
  const response = await POST(new Request('https://api.example.test/api/agents/tools/sendChannelMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }) as any);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, status: 'skipped', skipped: true, delivered: false, reason: 'stale_automatic_reply' });
  expect(sendChannelMessage).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});