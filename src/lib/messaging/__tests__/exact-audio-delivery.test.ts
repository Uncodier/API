jest.mock('../exact-delivery', () => ({ loadExactAccount: jest.fn() }));
jest.mock('../exact-whatsapp', () => ({ exactWhatsAppConfig: jest.fn() }));
jest.mock('@/lib/services/channels/explicit-audio-delivery', () => ({
  deliverExplicitAudio: jest.fn(), markAudioPreflightFailed: jest.fn(), AudioDeliveryError: class extends Error {},
}));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: { checkResponseWindow: jest.fn() } }));
jest.mock('@/lib/services/whatsapp/twilio-whatsapp-transport', () => ({ sendTwilioWhatsAppMessage: jest.fn() }));
import { sendExactAudioDelivery } from '../exact-audio-delivery';
import { loadExactAccount } from '../exact-delivery';
import { exactWhatsAppConfig } from '../exact-whatsapp';
import { deliverExplicitAudio } from '@/lib/services/channels/explicit-audio-delivery';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { audioSenderIdentity } from '@/lib/services/channels/audio-sender-identity';

const input = { siteId: 'site', channel: 'telegram' as const, connectionId: 'selected',
  conversationId: 'conversation', messageId: 'saved', text: 'Hello', recipient: 'recipient' };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadExactAccount).mockResolvedValue({ id: 'selected', provider: 'zavu',
    config: { zavu_sender_id: 'sender' } } as any);
  jest.mocked(exactWhatsAppConfig).mockResolvedValue(null);
  jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: true });
  jest.mocked(deliverExplicitAudio).mockImplementation(async params => params.dispatch({
    audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
  }));
  jest.mocked(sendChannelMessage).mockResolvedValue({ message: { id: 'audio-id', status: 'sent' } });
});
test('approved audio preserves the selected account and audio receipt', async () => {
  expect(await sendExactAudioDelivery(input)).toMatchObject({ success: true, messageId: 'audio-id' });
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'sender',
    messageType: 'audio', idempotencyKey: 'audio-delivery:site:saved' }));
  expect(deliverExplicitAudio).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'saved', text: 'Hello',
    sender: audioSenderIdentity({ provider: 'zavu', senderId: 'sender' }),
  }));
});
test('never switches accounts after preparation', async () => {
  jest.mocked(loadExactAccount).mockResolvedValueOnce({ id: 'selected', provider: 'zavu', config: { zavu_sender_id: 'sender' } } as any)
    .mockResolvedValueOnce({ id: 'selected', provider: 'zavu', config: { zavu_sender_id: 'other' } } as any);
  expect(await sendExactAudioDelivery(input)).toMatchObject({ success: false });
  expect(sendChannelMessage).not.toHaveBeenCalled();
});
test('rejects WhatsApp audio outside its response window before synthesis', async () => {
  jest.mocked(WhatsAppTemplateService.checkResponseWindow).mockResolvedValue({ withinWindow: false });
  expect(await sendExactAudioDelivery({ ...input, channel: 'whatsapp' })).toMatchObject({ success: false });
  expect(deliverExplicitAudio).not.toHaveBeenCalled();
});