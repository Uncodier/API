import { randomBytes } from 'node:crypto';
import { decryptToken } from '@/lib/utils/token-decryption';

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