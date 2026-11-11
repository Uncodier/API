jest.mock('@/lib/services/channels/automation-send-guard', () => ({
  ...jest.requireActual('@/lib/services/channels/automation-send-guard'), assertAutomationSendAllowed: jest.fn(async () => undefined),
}));
import { ChannelSendService, sanitizeZavuRecipient } from '../ChannelSendService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import * as zavuClient from '@/lib/services/zavu/client';
import * as longReplyAudio from '../long-reply-audio';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { authorizeOutstandConversation } from '@/lib/integrations/outstand/conversation-access';
import { deliverExplicitAudio } from '../explicit-audio-delivery';
import { audioSenderIdentity } from '../audio-sender-identity';
import { resolveAudioRouting } from '../audio-routing';
import { deliverZavuTemplate } from '@/lib/services/whatsapp/zavu-template-delivery';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { assertAutomationSendAllowed, AutomationSendSuppressed } from '../automation-send-guard';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { requireSavedOutboundMedia } from '../saved-outbound-media';
jest.mock('../saved-outbound-media', () => ({ requireSavedOutboundMedia: jest.fn(async () => undefined) }));
jest.mock('../native-media-delivery', () => ({ dispatchNativeMedia: jest.fn(async (_input: unknown, _provider: string, send: () => Promise<unknown>) => send()) }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));
jest.mock('@/lib/services/whatsapp/zavu-template-delivery', () => ({ deliverZavuTemplate: jest.fn(), TemplateDeliveryError: class extends Error {} }));
jest.mock('../audio-routing', () => ({ resolveAudioRouting: jest.fn() }));
jest.mock('../explicit-audio-delivery', () => ({ deliverExplicitAudio: jest.fn(), markAudioPreflightFailed: jest.fn(), AudioDeliveryError: class extends Error {} }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {
  checkResponseWindow: jest.fn(async () => ({ withinWindow: true })),
} }));

const mockedSupabase = supabaseAdmin as any;

// Mock database and provider boundaries.
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
    rpc: jest.fn(),
  }
}));

jest.mock('@/lib/services/zavu/client', () => ({
  sendChannelMessage: jest.fn()
}));
jest.mock('@/lib/integrations/outstand/client', () => ({
  getOutstandClient: jest.fn(),
}));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({
  authorizeOutstandConversation: jest.fn(),
}));

jest.mock('../long-reply-audio', () => ({
  tryPrepareLongReplyAudio: jest.fn().mockResolvedValue(null)
}));

describe('ChannelSendService', () => {
  const mockSiteId = 'test-site-id';
  const mockTo = '123456789';
  const mockMessage = 'Hello from Telegram';
  const mockSenderId = 'zavu-sender-123';
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(requireSavedOutboundMedia).mockResolvedValue(undefined);
    jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: true });
    mockedSupabase.maybeSingle.mockResolvedValue({ data: { custom_data: {} } });
    jest.mocked(resolveAudioRouting).mockImplementation(async input => ({ kind: 'zavu',
      connectionId: typeof input.connectionId === 'string' ? input.connectionId : 'connection-0', senderId: mockSenderId }));
    mockedSupabase.rpc.mockImplementation(() => ({ abortSignal: async () => {
      const result = await mockedSupabase.single();
      if (!result?.data) return result;
      return { ...result, data: { ...result.data, social_media: [], effective_plan: 'engine',
        channels: { ...result.data.channels, connections: (result.data.channels.connections || []).map((c: any, index: number) =>
          ({ id: `connection-${index}`, status: 'connected', license_suspended: false, ...c })) } } };
    } }));
    (authorizeOutstandConversation as jest.Mock).mockResolvedValue({
      success: true,
      conversation: {
        id: 'outstand-conversation-1',
        socialAccountId: 'account-1',
      },
    } as never);
  });

  it('uses the saved media connection rather than first channel sender', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'telegram', zavu_sender_id: 'first' }, { type: 'telegram', zavu_sender_id: 'saved' },
    ] } } });
    jest.mocked(requireSavedOutboundMedia).mockResolvedValue({ connection_id: 'connection-1' });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'sent', status: 'sent' } } as any);
    expect((await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: '', conversation_id: 'conversation', message_id: 'message', message_type: 'image', media_url: 'https://assets.example.test/photo' })).success).toBe(true);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'saved' }));
  });

  it('saved approval or metadata mismatch rejects before any provider including Outstand', async () => {
    jest.mocked(requireSavedOutboundMedia).mockRejectedValue(Object.assign(new Error('Unapproved media'), { status: 400 }));
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: mockTo,
      message: '', conversation_id: 'conversation', message_id: 'message', message_type: 'image', media_url: 'https://assets.example.test/photo' }))
      .toMatchObject({ success: false, status: 400 });
    expect(getOutstandClient).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('unbound saved Instagram media cannot fall through to an arbitrary Zavu connection', async () => {
    jest.mocked(requireSavedOutboundMedia).mockResolvedValue({ message_type: 'image' });
    mockedSupabase.maybeSingle.mockResolvedValue({ data: { custom_data: {} } });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: mockTo,
      message: '', conversation_id: 'conversation', message_id: 'message', message_type: 'image', media_url: 'https://assets.example.test/photo' }))
      .toMatchObject({ success: false, status: 400 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('bound saved Instagram media bypasses stale Outstand metadata and pins Zavu', async () => {
    jest.mocked(requireSavedOutboundMedia).mockResolvedValue({ connection_id: 'connection-0' });
    mockedSupabase.maybeSingle.mockResolvedValue({ data: { custom_data: { outstand_conversation_id: 'stale-outstand' } } });
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [{ type: 'instagram', zavu_sender_id: 'bound-zavu' }] } } });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'sent', status: 'sent' } } as any);
    expect((await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: mockTo,
      message: '', conversation_id: 'conversation', message_id: 'message', message_type: 'image', media_url: 'https://assets.example.test/photo' })).success).toBe(true);
    expect(getOutstandClient).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'bound-zavu' }));
  });

  it.each(['image', 'video', 'audio', 'document'] as const)('sends media-only %s using the exact selected Zavu sender and payload', async message_type => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'messenger', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'media-sent', status: 'queued' } });
    const mime_type = message_type === 'document' ? 'application/pdf' : `${message_type}/example`;
    const media_url = 'https://assets.example.test/media';
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'messenger', to: mockTo,
      message_type, media_url, mime_type })).toEqual({ success: true, messageId: 'media-sent', provider: 'zavu' });
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({ to: mockTo, channel: 'messenger',
      senderId: mockSenderId, messageType: message_type, content: { mediaUrl: media_url, mimeType: mime_type }, subject: undefined });
    expect(assertSafeRemoteUrl).toHaveBeenCalledWith(media_url);
    expect(assertAutomationSendAllowed).toHaveBeenCalledTimes(2);
    expect(longReplyAudio.tryPrepareLongReplyAudio).not.toHaveBeenCalled();
    expect(deliverExplicitAudio).not.toHaveBeenCalled();
  });

  it.each(['sms', 'voice', 'facebook', 'instagram'])('rejects unsupported %s document without any provider sends', async channel => {
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel, to: mockTo,
      message: 'Do not downgrade', message_type: 'document', media_url: 'https://assets.example.test/file.pdf' }))
      .toMatchObject({ success: false, status: 400 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
    expect(getOutstandClient).not.toHaveBeenCalled();
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it('rejects generated speech combined with explicit media without dispatch or speech generation', async () => {
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hello', message_type: 'audio', media_url: 'https://assets.example.test/a.mp3', response_format: 'audio' }))
      .toMatchObject({ success: false, status: 400 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
    expect(deliverExplicitAudio).not.toHaveBeenCalled();
  });

  it('requires public media DNS and never downgrades an unsafe attachment to text', async () => {
    jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error('private address'));
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hello', message_type: 'image', media_url: 'https://private.example.test/a.jpg' }))
      .toMatchObject({ success: false, status: 400 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('blocks existing WhatsApp media outside the response window without text template substitution', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'whatsapp', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValueOnce({ withinWindow: false });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'whatsapp', to: mockTo,
      message_type: 'image', media_url: 'https://assets.example.test/a.jpg' })).toMatchObject({ success: false, status: 400 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
    expect(deliverZavuTemplate).not.toHaveBeenCalled();
  });

  it('uses a connected Zavu Instagram sender for a saved non-comment conversation with no Outstand metadata', async () => {
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.eq = jest.fn(() => query);
    query.maybeSingle = jest.fn(async () => ({ data: { custom_data: { source: 'instagram' } }, error: null }));
    mockedSupabase.from.mockReturnValueOnce(query);
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'instagram', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'ig-zavu', status: 'queued' } });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: 'ig-user',
      conversation_id: 'local-dm', message_type: 'image', media_url: 'https://assets.example.test/a.jpg' }))
      .toEqual({ success: true, messageId: 'ig-zavu', provider: 'zavu' });
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram',
      senderId: mockSenderId, messageType: 'image', content: { mediaUrl: 'https://assets.example.test/a.jpg' } }));
    expect(getOutstandClient).not.toHaveBeenCalled();
  });

  it.each([{ message: { id: 'failed', status: 'failed' } }, { message: { id: 'missing-status' } },
    { success: false, message: { id: 'declined', status: 'sent' } }])('does not report media success without provider acceptance', async response => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'telegram', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue(response);
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message_type: 'image', media_url: 'https://assets.example.test/a.jpg' })).toMatchObject({ success: false });
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('rechecks automation suppression immediately before media dispatch', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'telegram', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(assertAutomationSendAllowed).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AutomationSendSuppressed('agent_snoozed'));
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message_type: 'image', media_url: 'https://assets.example.test/a.jpg' })).toMatchObject({ skipped: true, delivered: false });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('keeps explicit text as text even when long or containing an audio URL', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'telegram', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'sent' } });
    const message = 'Long reply '.repeat(100) + 'https://assets.example.test/storage/v1/object/public/a.mp3';
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message, response_format: 'text' });
    expect(result.success).toBe(true);
    expect(longReplyAudio.tryPrepareLongReplyAudio).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ text: message }));
  });

  it.each(['telegram', 'messenger', 'whatsapp'])('routes explicit %s audio through the durable delivery owner', async channel => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: channel, zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(deliverExplicitAudio).mockImplementationOnce(async params => params.dispatch({
      audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
    }));
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'audio-sent', status: 'sent' } });
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel, to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' });
    expect(result.messageId).toBe('audio-sent');
    expect(longReplyAudio.tryPrepareLongReplyAudio).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ messageType: 'audio',
      content: { mediaUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg' } }));
  });

  it('rejects Instagram audio without falling back to text', async () => {
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: mockTo,
      message: 'Hi', response_format: 'audio' });
    expect(result.success).toBe(false);
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
    expect(getOutstandClient).not.toHaveBeenCalled();
  });
  it('pins an approved audio message to its saved connection instead of the first sender', async () => {
    mockedSupabase.maybeSingle.mockResolvedValue({ data: { custom_data: { connection_id: 'chosen' } } });
    jest.mocked(resolveAudioRouting).mockResolvedValueOnce({ kind: 'zavu', connectionId: 'chosen', senderId: 'chosen-sender' });
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { id: 'other', type: 'messenger', zavu_sender_id: 'other-sender' },
      { id: 'chosen', type: 'messenger', zavu_sender_id: 'chosen-sender' },
    ] } }, error: null });
    jest.mocked(deliverExplicitAudio).mockResolvedValueOnce('audio-id');
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'messenger', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' })).toMatchObject({ success: true });
    expect(deliverExplicitAudio).toHaveBeenCalledWith(expect.objectContaining({
      sender: audioSenderIdentity({ provider: 'zavu', senderId: 'chosen-sender' }),
    }));
  });

  it.each([
    { success: false, message: { id: 'failed-id', status: 'failed' } },
    { message: { id: 'failed-id', status: 'failed' } },
    { success: false, message: { id: 'rejected-id', status: 'queued' } },
    { message: { id: 'unknown-id' } },
    { message: { status: 'sent' } },
  ])('never treats a rejected or unconfirmed audio response as sent: %j', async providerResult => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'telegram', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(deliverExplicitAudio).mockImplementationOnce(async params => params.dispatch({
      audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
    }));
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue(providerResult);
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' });
    expect(result.success).toBe(false);
    expect(result.messageId).toBeUndefined();
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `audio-delivery:${mockSiteId}:saved`, messageType: 'audio',
    }));
  });

  it.each(['queued', 'sending', 'sent', 'delivered', 'read'])('recognizes provider acceptance for audio state %s', async status => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { type: 'messenger', zavu_sender_id: mockSenderId },
    ] } }, error: null });
    jest.mocked(deliverExplicitAudio).mockImplementationOnce(async params => params.dispatch({
      audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
    }));
    jest.mocked(zavuClient.sendChannelMessage).mockResolvedValue({ message: { id: 'accepted-id', status } });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'messenger', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' }))
      .toMatchObject({ success: true, messageId: 'accepted-id' });
  });
  it('resolves an unbound manual message to its conversation account instead of the first available sender', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { id: 'first', type: 'telegram', zavu_sender_id: 'first-sender' },
      { id: 'conversation-account', type: 'telegram', zavu_sender_id: 'conversation-sender' },
    ] } }, error: null });
    jest.mocked(resolveAudioRouting).mockResolvedValueOnce({ kind: 'zavu', connectionId: 'conversation-account', senderId: 'conversation-sender' });
    jest.mocked(deliverExplicitAudio).mockResolvedValueOnce('audio-id');
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'manual', conversation_id: 'conversation' })).toMatchObject({ success: true });
    expect(resolveAudioRouting).toHaveBeenCalledWith({ siteId: mockSiteId, channel: 'telegram',
      conversationId: 'conversation', connectionId: undefined });
    expect(deliverExplicitAudio).toHaveBeenCalledWith(expect.objectContaining({
      sender: audioSenderIdentity({ provider: 'zavu', senderId: 'conversation-sender' }),
    }));
  });
  it('does not synthesize or default to another sender when audio routing is ambiguous', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { id: 'first', type: 'telegram', zavu_sender_id: 'first-sender' },
      { id: 'second', type: 'telegram', zavu_sender_id: 'second-sender' },
    ] } }, error: null });
    jest.mocked(resolveAudioRouting).mockRejectedValueOnce(new Error('Audio sender is ambiguous'));
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'manual', conversation_id: 'conversation' });
    expect(result.success).toBe(false);
    expect(deliverExplicitAudio).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses the pinned template path when WhatsApp audio cannot use the window (already pending: %s)', async alreadyPending => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { id: 'selected-wa', type: 'whatsapp', zavu_sender_id: 'selected-sender' },
    ] } }, error: null });
    mockedSupabase.maybeSingle.mockResolvedValue({ data: { custom_data: { connection_id: 'selected-wa',
      ...(alreadyPending ? { template_delivery: { state: 'pending' } } : {}) } } });
    jest.mocked(resolveAudioRouting).mockResolvedValueOnce({ kind: 'zavu', connectionId: 'selected-wa', senderId: 'selected-sender' });
    jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: alreadyPending });
    const pending = { success: true as const, template_pending: true, template_used: false,
      status: 'template_pending' as const, delivery_format: 'template' as const, requested_response_format: 'audio' as const,
      template_id: 'template', message_id: 'saved' };
    jest.mocked(deliverZavuTemplate).mockResolvedValueOnce(pending);
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'whatsapp', to: mockTo,
      message: 'Hola', response_format: 'audio', message_id: 'saved', conversation_id: 'conversation' }))
      .toMatchObject({ success: true, templateDelivery: pending });
    expect(deliverZavuTemplate).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'selected-wa',
      senderId: 'selected-sender', messageId: 'saved', text: 'Hola' }));
    expect(deliverExplicitAudio).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });
  it('rejects inconsistent sender snapshots rather than preparing for the stale account', async () => {
    mockedSupabase.single.mockResolvedValue({ data: { channels: { connections: [
      { id: 'same-connection', type: 'telegram', zavu_sender_id: 'previous-sender' },
    ] } }, error: null });
    jest.mocked(resolveAudioRouting).mockResolvedValueOnce({ kind: 'zavu', connectionId: 'same-connection', senderId: 'new-sender' });
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo,
      message: 'Hi', response_format: 'audio', message_id: 'manual', conversation_id: 'conversation' });
    expect(result.success).toBe(false);
    expect(deliverExplicitAudio).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should successfully send a telegram message when settings exist', async () => {
    // Setup mock supabase response
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [
            { type: 'telegram', zavu_sender_id: mockSenderId }
          ]
        }
      },
      error: null
    });

    // Setup mock Zavu response
    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'msg_123' }
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_123');
    
    // Verify DB query
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: mockSiteId });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
    
    // Verify Zavu call with correct senderId
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: mockTo,
      text: mockMessage,
      channel: 'telegram',
      senderId: mockSenderId,
      subject: undefined
    });
  });

  it.each(['license_suspended', 'disconnected'])('does not execute an unavailable %s sender', async status => {
    mockedSupabase.single.mockResolvedValue({ error: null, data: { channels: { connections: [
      { id: 'chosen', type: 'telegram', zavu_sender_id: mockSenderId, status, license_suspended: status === 'license_suspended' },
    ] } } });
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage });
    expect(result.success).toBe(false);
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('rechecks license after audio preparation, preventing an expired sender from sending', async () => {
    mockedSupabase.single.mockResolvedValueOnce({ error: null, data: { channels: { connections: [
      { id: 'chosen', type: 'telegram', status: 'connected', zavu_sender_id: mockSenderId },
    ] } } }).mockResolvedValueOnce({ error: null, data: { channels: { connections: [
      { id: 'chosen', type: 'telegram', status: 'license_suspended', license_suspended: true, zavu_sender_id: mockSenderId },
    ] } } });
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage });
    expect(result.success).toBe(false);
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses the first licensed Telegram sender in stored order (first suspended: %s)', async suspended => {
    const connections = [
      { id: 'first', type: 'telegram', status: 'connected', zavu_sender_id: 'first-sender', license_suspended: suspended },
      { id: 'second', type: 'telegram', status: 'connected', zavu_sender_id: 'second-sender', license_suspended: false },
    ];
    mockedSupabase.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: {
      effective_plan: 'foundry', social_media: [], channels: { connections },
    } }) }));
    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'accepted' } });
    const result = await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage });
    expect(result).toMatchObject({ success: true, messageId: 'accepted' });
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      senderId: suspended ? 'second-sender' : 'first-sender',
    }));
    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(2);
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it('denies Telegram when all connected senders are license suspended', async () => {
    const connections = ['first', 'second'].map(id => ({
      id, type: 'telegram', status: 'connected', zavu_sender_id: `${id}-sender`, license_suspended: true,
    }));
    mockedSupabase.rpc.mockReturnValue({ abortSignal: async () => ({ error: null, data: {
      effective_plan: 'commission', social_media: [], channels: { connections },
    } }) });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage }))
      .toMatchObject({ success: false });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('does not switch to a second licensed sender when the first expires during audio preparation', async () => {
    const connections = ['first', 'second'].map(id => ({
      id, type: 'telegram', status: 'connected', zavu_sender_id: `${id}-sender`, license_suspended: false,
    }));
    mockedSupabase.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: {
      effective_plan: 'foundry', social_media: [], channels: { connections },
    } }) }));
    jest.spyOn(longReplyAudio, 'tryPrepareLongReplyAudio').mockImplementationOnce(async () => {
      connections[0].license_suspended = true;
      return { audioUrl: 'https://example.test/audio.mp3', mimeType: 'audio/mpeg' };
    });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage }))
      .toMatchObject({ success: false, status: 403 });
    expect(longReplyAudio.tryPrepareLongReplyAudio).toHaveBeenCalled();
    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(2);
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it.each(['active', 'synced'])('does not accept non-voice provider status %s', async status => {
    mockedSupabase.single.mockResolvedValue({ error: null, data: { channels: { connections: [
      { id: 'first', type: 'telegram', status, zavu_sender_id: mockSenderId, license_suspended: false },
    ] } } });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage }))
      .toMatchObject({ success: false });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('skips a protected manually disabled sender before audio preparation', async () => {
    mockedSupabase.single.mockResolvedValue({ error: null, data: { channels: { connections: [
      { id: 'first', type: 'telegram', zavu_sender_id: 'disabled', _license: { manually_disabled: true } },
      { id: 'second', type: 'telegram', zavu_sender_id: mockSenderId },
    ] } } });
    expect((await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage })).success).toBe(true);
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: mockSenderId }));
  });

  it('manual disable after audio preparation stops the pinned provider dispatch', async () => {
    const connections = [{ id: 'chosen', type: 'telegram', status: 'connected',
      zavu_sender_id: mockSenderId, license_suspended: false, _license: { manually_disabled: false } }];
    mockedSupabase.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: {
      effective_plan: 'engine', social_media: [], channels: { connections },
    } }) }));
    jest.spyOn(longReplyAudio, 'tryPrepareLongReplyAudio').mockImplementationOnce(async () => {
      connections[0]._license.manually_disabled = true;
      return null;
    });
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'telegram', to: mockTo, message: mockMessage }))
      .toMatchObject({ success: false, status: 403 });
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should successfully send a long message as audio if tryPrepareLongReplyAudio returns an audio URL', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [
            { type: 'telegram', zavu_sender_id: mockSenderId }
          ]
        }
      },
      error: null
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'msg_123' }
    });

    jest.spyOn(longReplyAudio, 'tryPrepareLongReplyAudio').mockResolvedValueOnce({
      audioUrl: 'https://example.com/audio.mp3',
      mimeType: 'audio/mpeg'
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: 'a'.repeat(500)
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_123');
    
    // Verify Zavu call with correct senderId and audio payload
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: mockTo,
      channel: 'telegram',
      senderId: mockSenderId,
      messageType: 'audio',
      content: { mediaUrl: 'https://example.com/audio.mp3', mimeType: 'audio/mpeg' },
      subject: undefined
    });
  });

  it('should return error if no sender is configured for the channel', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: []
        }
      },
      error: null
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'messenger',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No sender configured');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if site settings fetch fails', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: null,
      error: new Error('DB Error')
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('current license');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if required params are missing', async () => {
    const result = await ChannelSendService.sendMessage({
      site_id: '',
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
    expect(mockedSupabase.from).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should resolve whatsapp sender and send with subject omitted', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'whatsapp', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'wa_1' },
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'whatsapp',
      to: '+5215550001111',
      message: mockMessage,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wa_1');
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: '+5215550001111',
      text: mockMessage,
      channel: 'whatsapp',
      senderId: mockSenderId,
      subject: undefined,
    });
  });

  it('should resolve email sender and pass subject', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'email', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockResolvedValue({
      message: { id: 'em_1' },
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'email',
      to: 'user@example.com',
      message: mockMessage,
      subject: 'Re: Your inquiry',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('em_1');
    expect(zavuClient.sendChannelMessage).toHaveBeenCalledWith({
      to: 'user@example.com',
      text: mockMessage,
      channel: 'email',
      senderId: mockSenderId,
      subject: 'Re: Your inquiry',
    });
  });

  it('should return error if whatsapp sender is missing', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: {
          connections: [{ type: 'telegram', zavu_sender_id: mockSenderId }],
        },
      },
      error: null,
    });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'whatsapp',
      to: '+5215550001111',
      message: mockMessage,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No sender configured');
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('should return error if zavu API throws', async () => {
    (mockedSupabase.single as jest.Mock).mockResolvedValue({
      data: {
        channels: { connections: [{ type: 'telegram', zavu_sender_id: mockSenderId }] }
      },
      error: null
    });

    (zavuClient.sendChannelMessage as jest.Mock).mockRejectedValue(new Error('Zavu API failed'));

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'telegram',
      to: mockTo,
      message: mockMessage
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Zavu API failed');
  });

  it.each(['image', 'video'] as const)('sends Instagram media-only %s as native media_urls after authorization', async message_type => {
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.eq = jest.fn(() => query);
    query.maybeSingle = jest.fn(async () => ({ data: { custom_data: { outstand_conversation_id: 'outstand-dm' } }, error: null }));
    mockedSupabase.from.mockReturnValueOnce(query);
    const sendConversationMessage = jest.fn(async () => ({ success: true, message: { id: 'media-dm' } }));
    jest.mocked(getOutstandClient).mockReturnValue({ sendConversationMessage } as any);
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: 'user',
      conversation_id: 'local-dm', message_type, media_url: 'https://assets.example.test/media' }))
      .toEqual({ success: true, messageId: 'media-dm', provider: 'outstand' });
    expect(sendConversationMessage).toHaveBeenCalledWith('outstand-dm', { media_urls: ['https://assets.example.test/media'] }, mockSiteId);
    expect(authorizeOutstandConversation).toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith('site_id', mockSiteId);
    expect(assertAutomationSendAllowed).toHaveBeenCalledTimes(2);
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('rejects Instagram media when the saved conversation is a comment, never falling back to a public reply', async () => {
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.eq = jest.fn(() => query);
    query.maybeSingle = jest.fn(async () => ({ data: { custom_data: { source: 'outstand_comment' } }, error: null }));
    mockedSupabase.from.mockReturnValueOnce(query);
    expect(await ChannelSendService.sendMessage({ site_id: mockSiteId, channel: 'instagram', to: 'user',
      message: 'Never send as a comment', conversation_id: 'local-comment', message_type: 'image', media_url: 'https://assets.example.test/a.jpg' }))
      .toMatchObject({ success: false, status: 400 });
    expect(getOutstandClient).not.toHaveBeenCalled();
    expect(zavuClient.sendChannelMessage).not.toHaveBeenCalled();
    expect(mockedSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('sends an Instagram DM when the conversation has Outstand DM metadata', async () => {
    const conversationQuery: Record<string, jest.Mock> = {};
    conversationQuery.select = jest.fn(() => conversationQuery);
    conversationQuery.eq = jest.fn(() => conversationQuery);
    conversationQuery.maybeSingle = jest.fn(async () => ({
      data: {
        custom_data: {
          source: 'outstand_dm',
          outstand_conversation_id: 'outstand-conversation-1',
        },
      },
      error: null,
    }));
    (mockedSupabase.from as jest.Mock).mockReturnValueOnce(conversationQuery);

    const sendConversationMessage = jest.fn(async () => ({
      success: true,
      message: { id: 'outstand-message-1' },
    }));
    (getOutstandClient as jest.Mock).mockReturnValue({ sendConversationMessage });

    const result = await ChannelSendService.sendMessage({
      site_id: mockSiteId,
      channel: 'instagram',
      to: 'instagram-user',
      message: 'Reply by DM',
      conversation_id: 'local-conversation-id',
    });

    expect(result).toEqual({
      success: true,
      messageId: 'outstand-message-1',
      provider: 'outstand',
    });
    expect(sendConversationMessage).toHaveBeenCalledWith(
      'outstand-conversation-1',
      { content: 'Reply by DM' },
      mockSiteId,
    );
    expect(authorizeOutstandConversation).toHaveBeenCalledWith(
      expect.anything(),
      'outstand-conversation-1',
      mockSiteId,
    );
  });
});

describe('sanitizeZavuRecipient', () => {
  it('strips +52 so a 10-digit Telegram id that was stored as MX phone is restored', () => {
    expect(sanitizeZavuRecipient('+521888278689')).toBe('1888278689');
  });

  it('strips a generic + prefix', () => {
    expect(sanitizeZavuRecipient('+1888278689')).toBe('1888278689');
  });

  it('leaves a raw chat id unchanged', () => {
    expect(sanitizeZavuRecipient('1888278689')).toBe('1888278689');
  });
});