jest.mock('@/lib/services/channels/automation-send-guard', () => ({
  ...jest.requireActual('@/lib/services/channels/automation-send-guard'), assertAutomationSendAllowed: jest.fn(async () => undefined),
}));
import { randomBytes } from 'node:crypto';
import { decryptToken } from '@/lib/utils/token-decryption';
import { requireLegacyAudioRouting } from '@/lib/services/channels/audio-message-routing';
import { audioSenderIdentity } from '@/lib/services/channels/audio-sender-identity';
jest.mock('@/lib/services/channels/audio-message-routing', () => ({ requireLegacyAudioRouting: jest.fn() }));
import { deliverExplicitAudio } from '@/lib/services/channels/explicit-audio-delivery';
import { tryPrepareLongReplyAudio } from '@/lib/services/channels/long-reply-audio';
jest.mock('@/lib/services/channels/explicit-audio-delivery', () => ({
  deliverExplicitAudio: jest.fn(), markAudioPreflightFailed: jest.fn(), AudioDeliveryError: class AudioDeliveryError extends Error {},
}));

const mockFrom = jest.fn<ReturnType<typeof query> | { insert: typeof mockInsert }, [string]>();

jest.mock('@/lib/services/channels/long-reply-audio', () => ({
  tryPrepareLongReplyAudio: jest.fn(async () => null),
}));
jest.mock('uuid', () => ({ v4: jest.fn(() => '00000000-0000-4000-8000-000000000001') }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: jest.fn() }));

// Mock de supabaseAdmin
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom },
}));

// Mock de fetch global
global.fetch = jest.fn();

const mockInsert = jest.fn(async (_rows: unknown[]) => ({ error: null }));
import { WhatsAppSendService } from '../WhatsAppSendService';
import { WhatsAppTemplateService } from '../WhatsAppTemplateService';
let authToken: string;
let accountSid: string;

function query(data: unknown, error: Error | null = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(async () => ({ data, error })),
    maybeSingle: jest.fn(async () => ({ data, error })),
  };
}

function configureDatabase(missingSettings = false) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sites') return query({ name: 'Test Site', url: 'https://example.invalid' });
    if (table === 'secure_tokens') return query({ id: 'token-1', encrypted_value: randomBytes(32).toString('hex') });
    if (table === 'settings') return missingSettings
      ? query(null, new Error('Settings not found'))
      : query({ channels: { whatsapp: { account_sid: accountSid, existingNumber: '+15555550123' } } });
    if (table === 'whatsapp_logs') return { insert: mockInsert };
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('WhatsAppSendService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(global.fetch).mockReset();
    authToken = randomBytes(32).toString('hex');
    accountSid = `AC${randomBytes(16).toString('hex')}`;
    jest.mocked(decryptToken).mockReturnValue(authToken);
    configureDatabase();
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_API_TOKEN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('isValidPhoneNumber', () => {
    it('debería validar números de teléfono correctos', () => {
      expect(WhatsAppSendService.isValidPhoneNumber('+1234567890')).toBe(true);
      expect(WhatsAppSendService.isValidPhoneNumber('+34612345678')).toBe(true);
      expect(WhatsAppSendService.isValidPhoneNumber('+5511999887766')).toBe(true);
    });

    it('debería rechazar números de teléfono incorrectos', () => {
      expect(WhatsAppSendService.isValidPhoneNumber('1234567890')).toBe(false);
      expect(WhatsAppSendService.isValidPhoneNumber('612345678')).toBe(false);
      expect(WhatsAppSendService.isValidPhoneNumber('+123')).toBe(false);
      expect(WhatsAppSendService.isValidPhoneNumber('+')).toBe(false);
      expect(WhatsAppSendService.isValidPhoneNumber('')).toBe(false);
    });

    it('debería manejar números con espacios y caracteres especiales', () => {
      expect(WhatsAppSendService.isValidPhoneNumber('+1 (234) 567-890')).toBe(true);
      expect(WhatsAppSendService.isValidPhoneNumber('+34 612 345 678')).toBe(true);
      expect(WhatsAppSendService.isValidPhoneNumber('+55-11-99988-7766')).toBe(true);
    });
  });

  describe('sendMessage', () => {
    const mockParams = {
      phone_number: '+1234567890',
      message: 'Test message',
      site_id: 'test-site-id',
      responseWindowEnabled: true,
    };

    it('never converts explicitly selected text to audio', async () => {
      jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ sid: 'sent' }) } as Response);
      const result = await WhatsAppSendService.sendMessage({ ...mockParams, response_format: 'text', message: 'Hi '.repeat(200) });
      expect(result.success).toBe(true);
      expect(tryPrepareLongReplyAudio).not.toHaveBeenCalled();
    });

    it('blocks explicit audio outside the window even when a caller requests bypass', async () => {
      jest.spyOn(WhatsAppTemplateService, 'checkResponseWindow').mockResolvedValue({ withinWindow: false });
      const result = await WhatsAppSendService.sendMessage({ ...mockParams, response_format: 'audio',
        message_id: 'saved', conversation_id: 'conversation' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AUDIO_DELIVERY_FAILED');
      expect(result.template_required).not.toBe(true);
      expect(deliverExplicitAudio).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends one audio-only message with the original persisted text as synthesis input', async () => {
      jest.spyOn(WhatsAppTemplateService, 'checkResponseWindow').mockResolvedValue({ withinWindow: true });
      jest.mocked(deliverExplicitAudio).mockImplementationOnce(async params => params.dispatch({
        audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
      }));
      jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ sid: 'audio-id' }) } as Response);
      const result = await WhatsAppSendService.sendMessage({ ...mockParams, message: '**Hello**', response_format: 'audio',
        message_id: 'saved', conversation_id: 'conversation' });
      expect(result.message_id).toBe('audio-id');
      expect(deliverExplicitAudio).toHaveBeenCalledWith(expect.objectContaining({ text: '**Hello**', messageId: 'saved' }));
      expect(deliverExplicitAudio).toHaveBeenCalledWith(expect.objectContaining({
        sender: audioSenderIdentity({ provider: 'twilio', accountSid, fromNumber: '+15555550123' }),
      }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const body = new URLSearchParams(String(jest.mocked(global.fetch).mock.calls[0][1]?.body));
      expect(body.get('MediaUrl')).toBe('https://assets.example.test/reply.mp3');
      expect(body.get('Body') || '').toBe('');
    });

    it('does not send an audio bound to Zavu through the legacy Twilio adapter', async () => {
      jest.mocked(requireLegacyAudioRouting).mockRejectedValueOnce(new Error('Saved audio requires its selected Zavu adapter'));
      const result = await WhatsAppSendService.sendMessage({ ...mockParams, response_format: 'audio',
        message_id: 'saved', conversation_id: 'conversation' });
      expect(result.success).toBe(false);
      expect(deliverExplicitAudio).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses a changed Twilio account after preparing audio', async () => {
      jest.spyOn(WhatsAppTemplateService, 'checkResponseWindow').mockResolvedValue({ withinWindow: true });
      jest.mocked(deliverExplicitAudio).mockImplementationOnce(async params => params.dispatch({
        audioUrl: 'https://assets.example.test/reply.mp3', mimeType: 'audio/mpeg',
      }));
      jest.spyOn(WhatsAppSendService, 'getWhatsAppConfig')
        .mockResolvedValueOnce({ phoneNumberId: accountSid, accessToken: authToken, fromNumber: '+15555550123' })
        .mockResolvedValueOnce({ phoneNumberId: `AC${randomBytes(16).toString('hex')}`, accessToken: authToken, fromNumber: '+15555550123' });
      expect(await WhatsAppSendService.sendMessage({ ...mockParams, response_format: 'audio',
        message_id: 'saved', conversation_id: 'conversation' })).toMatchObject({ success: false });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('debería manejar números temporales', async () => {
      const result = await WhatsAppSendService.sendMessage({
        ...mockParams,
        phone_number: 'no-phone-example'
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('Temporary phone number - no real message sent');
    });

    it('debería validar formato de número de teléfono', async () => {
      const result = await WhatsAppSendService.sendMessage({
        ...mockParams,
        phone_number: 'not-a-phone' // Invalid even after the current rescue heuristics.
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PHONE_NUMBER');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('debería manejar error de configuración no encontrada', async () => {
      configureDatabase(true);

      const result = await WhatsAppSendService.sendMessage(mockParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WHATSAPP_CONFIG_NOT_FOUND');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('debería enviar mensaje exitosamente con secure_tokens y settings', async () => {
      jest.mocked(global.fetch).mockResolvedValueOnce(Response.json({ sid: 'test-message-id', status: 'queued' }));

      const result = await WhatsAppSendService.sendMessage({
        ...mockParams,
        from: 'Test Sender'
      });

      expect(result.success).toBe(true);
      expect(result.message_id).toBe('test-message-id');
      expect(result.status).toBe('sent');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` }),
        }),
      );
      expect(mockInsert).toHaveBeenCalledWith([expect.objectContaining({ whatsapp_message_id: 'test-message-id' })]);
    });

    it('debería manejar error de API de WhatsApp', async () => {
      jest.mocked(global.fetch).mockResolvedValueOnce(Response.json(
        { code: 21211, message: 'Invalid phone number' },
        { status: 400, statusText: 'Bad Request' },
      ));

      const result = await WhatsAppSendService.sendMessage(mockParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WHATSAPP_SEND_FAILED');
      expect(result.error?.message).toContain('Invalid phone number');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
}); 