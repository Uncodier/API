import { deliverExplicitAudio, markAudioPreflightFailed } from '../explicit-audio-delivery';
import { validateResponseFormat } from '../response-format';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { synthesizeSpeech } from '@/lib/services/ai/tts-service';
import { audioSenderIdentity } from '../audio-sender-identity';
import { ChannelSendService } from '../ChannelSendService';
import { sendExactAudioDelivery } from '@/lib/messaging/exact-audio-delivery';
import { sendChannelMessage } from '@/lib/services/zavu/client';

jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('../audio-routing', () => ({ resolveAudioRouting: jest.fn(async () => ({
  kind: 'zavu', connectionId: 'connection', senderId: 'sender',
})) }));
jest.mock('@/lib/integrations/outstand/client', () => ({ getOutstandClient: jest.fn() }));
jest.mock('@/lib/integrations/outstand/conversation-access', () => ({ authorizeOutstandConversation: jest.fn() }));
jest.mock('@/lib/services/social-comments/delivery', () => ({ sendCommentReply: jest.fn() }));
jest.mock('@/lib/billing/licensed-resources', () => ({
  getSiteLicensedResources: jest.fn(async () => ({ channels: { connections: [
    { id: 'connection', type: 'telegram', zavu_sender_id: 'sender' },
  ] } })),
  isLicensedChannelConnection: () => true,
  requireLicensedChannel: jest.fn(),
}));
jest.mock('@/lib/messaging/exact-delivery', () => ({ loadExactAccount: jest.fn(async () => ({
  id: 'connection', provider: 'zavu', config: { zavu_sender_id: 'sender' },
})) }));
jest.mock('@/lib/messaging/exact-whatsapp', () => ({ exactWhatsAppConfig: jest.fn() }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {} }));
jest.mock('@/lib/services/whatsapp/twilio-whatsapp-transport', () => ({ sendTwilioWhatsAppMessage: jest.fn() }));

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  from: jest.fn(), storage: { from: jest.fn() },
} }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {
  PRICING: { AUDIO_GENERATION_MINUTE: 1 }, validateCredits: jest.fn(), deductCredits: jest.fn(),
} }));
jest.mock('@/lib/services/ai/tts-service', () => ({
  validateSpeechOptions: jest.fn(() => ({ provider: 'azure', voice: 'nova', deployment: 'speech' })),
  synthesizeSpeech: jest.fn(),
}));

describe('explicit audio delivery', () => {
  let row: any;
  let updates: any[];
  const upload = jest.fn();
  const dispatch = jest.fn();
  const params = { siteId: 'site', conversationId: 'conversation', messageId: 'message',
    channel: 'telegram', text: 'Hello', recipient: 'recipient', sender: 'sender', dispatch };

  beforeEach(() => {
    jest.clearAllMocks();
    row = { id: 'message', content: 'Hello', role: 'assistant', custom_data: { source: 'telegram', response_format: 'audio' } };
    updates = [];
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      let next: any;
      const filters: any[] = [];
      const execute = async () => {
        if (table === 'conversations') return { data: { id: 'conversation' } };
        if (!next) return { data: structuredClone(row) };
        const matches = filters.every(([key, value]) =>
          key === 'custom_data' ? JSON.stringify(row.custom_data) === value || row.custom_data === value
            : key === 'content' ? row.content === value : true);
        if (!matches) return { data: null };
        row.custom_data = next.custom_data;
        updates.push(structuredClone(next.custom_data));
        return { data: { id: row.id } };
      };
      const q: any = {
        select: () => q,
        eq: (key: string, value: any) => { filters.push([key, value]); return q; },
        is: (key: string, value: any) => { filters.push([key, value]); return q; },
        update: (value: any) => { next = value; return q; },
        maybeSingle: execute,
        then: (resolve: any, reject: any) => execute().then(resolve, reject),
      };
      return q;
    });
    (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({ upload,
      getPublicUrl: () => ({ data: { publicUrl: 'https://assets.example.test/reply.mp3' } }) });
    upload.mockResolvedValue({ error: null });
    (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
    (CreditService.deductCredits as jest.Mock).mockResolvedValue(undefined);
    (synthesizeSpeech as jest.Mock).mockResolvedValue({ audio: Buffer.from('synthetic audio'), mimeType: 'audio/mpeg' });
    dispatch.mockResolvedValue('provider-id');
    jest.mocked(sendChannelMessage).mockResolvedValue({ message: { id: 'provider-id', status: 'sent' } });
  });

  it.each(['whatsapp', 'telegram', 'messenger'])('accepts explicit audio for %s', channel => {
    expect(validateResponseFormat('audio', channel)).toBe('audio');
  });
  it.each(['instagram', 'facebook', 'sms', 'email', 'voice'])('rejects audio on %s', channel => {
    expect(() => validateResponseFormat('audio', channel)).toThrow();
  });
  it('preserves omission and text and rejects unknown formats', () => {
    expect(validateResponseFormat(undefined, 'email')).toBeUndefined();
    expect(validateResponseFormat('text', 'email')).toBe('text');
    expect(() => validateResponseFormat('auto', 'telegram')).toThrow();
  });
  it('synthesizes short replies once, persists an attachment, and reuses the send receipt', async () => {
    expect(await deliverExplicitAudio(params)).toBe('provider-id');
    expect(await deliverExplicitAudio(params)).toBe('provider-id');
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg' });
    expect(row.custom_data).toMatchObject({ source: 'telegram', response_format: 'audio', status: 'sent',
      attachments: [{ type: 'audio', mimeType: 'audio/mpeg' }] });
    expect(updates.map(value => value.audio_delivery.state)).toEqual(['preparing', 'ready', 'dispatching', 'sent']);
  });
  it('does not resend or regenerate after a provider timeout', async () => {
    dispatch.mockRejectedValue(new Error('timeout'));
    await expect(deliverExplicitAudio(params)).rejects.toThrow('unconfirmed');
    await expect(deliverExplicitAudio(params)).rejects.toThrow('reconcile');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(row.custom_data.status).toBe('placement_unknown');
  });
  it.each(['zavu', 'twilio'] as const)('reuses direct and approved receipts with a canonical %s account identity', async provider => {
    const identity = () => provider === 'zavu'
      ? audioSenderIdentity({ provider: 'zavu', senderId: 'sender' })
      : audioSenderIdentity({ provider: 'twilio', accountSid: 'test-account', fromNumber: '+15555550100' });
    await deliverExplicitAudio({ ...params, sender: identity() });
    expect(await deliverExplicitAudio({ ...params, sender: identity() })).toBe('provider-id');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
    // A ready receipt is resumable through either adapter without another TTS charge.
    row.custom_data.audio_delivery.state = 'ready';
    row.custom_data.status = 'failed';
    expect(await deliverExplicitAudio({ ...params, sender: identity() })).toBe('provider-id');
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a receipt for a different provider account with the same From number', async () => {
    const sender = (accountSid: string) => audioSenderIdentity({ provider: 'twilio', accountSid, fromNumber: '+15555550100' });
    await deliverExplicitAudio({ ...params, sender: sender('first-account') });
    await expect(deliverExplicitAudio({ ...params, sender: sender('second-account') })).rejects.toThrow('destination changed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('shares actual direct/approved adapter receipts (direct first: %s)', async directFirst => {
    row.custom_data.connection_id = 'connection';
    const direct = () => ChannelSendService.sendMessage({ site_id: 'site', channel: 'telegram',
      to: 'recipient', message: 'Hello', conversation_id: 'conversation', message_id: 'message', response_format: 'audio' });
    const approved = () => sendExactAudioDelivery({ siteId: 'site', channel: 'telegram', connectionId: 'connection',
      conversationId: 'conversation', messageId: 'message', text: 'Hello', recipient: 'recipient' });
    expect(await (directFirst ? direct() : approved())).toMatchObject({ success: true, messageId: 'provider-id' });
    expect(await (directFirst ? approved() : direct())).toMatchObject({ success: true, messageId: 'provider-id' });
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
  });
  it('does not persist a failed Zavu response with an ID as a sent receipt', async () => {
    row.custom_data.connection_id = 'connection';
    jest.mocked(sendChannelMessage).mockResolvedValue({ success: false, message: { id: 'failed-id', status: 'failed' } });
    const result = await ChannelSendService.sendMessage({ site_id: 'site', channel: 'telegram', to: 'recipient',
      message: 'Hello', conversation_id: 'conversation', message_id: 'message', response_format: 'audio' });
    expect(result.success).toBe(false);
    expect(row.custom_data.audio_delivery.state).toBe('unknown');
    expect(row.custom_data.status).not.toBe('sent');
    expect(row.custom_data.audio_delivery.provider_message_id).toBeUndefined();
  });
  it('does not send text or recharge after failed synthesis', async () => {
    (synthesizeSpeech as jest.Mock).mockRejectedValue(new Error('unavailable'));
    await expect(deliverExplicitAudio(params)).rejects.toThrow('no text was sent');
    await expect(deliverExplicitAudio(params)).rejects.toThrow('reconcile');
    expect(dispatch).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });
  it('rejects changed content before charging', async () => {
    row.content = 'Edited';
    await expect(deliverExplicitAudio(params)).rejects.toThrow('changed');
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });
  it('rejects changed destination after sending', async () => {
    await deliverExplicitAudio(params);
    await expect(deliverExplicitAudio({ ...params, recipient: 'other' })).rejects.toThrow('destination changed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('allows only one concurrent owner', async () => {
    const results = await Promise.allSettled([deliverExplicitAudio(params), deliverExplicitAudio(params)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });
  it('blocks missing message scope and inbound messages', async () => {
    await expect(deliverExplicitAudio({ ...params, messageId: undefined })).rejects.toThrow('saved message');
    row.role = 'user';
    await expect(deliverExplicitAudio(params)).rejects.toThrow('does not belong');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('never generates audio after a template workflow owns the message', async () => {
    row.custom_data.template_delivery = { state: 'pending', template_id: 'template' };
    await expect(deliverExplicitAudio(params)).rejects.toThrow('Template already owns');
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('supports legacy null metadata without dropping receipt ownership', async () => {
    row.custom_data = null;
    expect(await deliverExplicitAudio(params)).toBe('provider-id');
    expect(row.custom_data.audio_delivery.state).toBe('sent');
  });
  it('marks an unstarted preflight failed but preserves uncertain and completed receipts', async () => {
    await markAudioPreflightFailed(params);
    expect(row.custom_data.status).toBe('failed');
    row.custom_data = { status: 'placement_unknown', audio_delivery: { state: 'unknown' } };
    await markAudioPreflightFailed(params);
    expect(row.custom_data.status).toBe('placement_unknown');
    row.custom_data = { status: 'sent' };
    await markAudioPreflightFailed(params);
    expect(row.custom_data.status).toBe('sent');
  });
});