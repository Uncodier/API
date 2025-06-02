import { WhatsAppSendService } from './WhatsAppSendService';

// Mock de supabaseAdmin
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn()
        }))
      })),
      insert: jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest.fn()
        }))
      }))
    }))
  }
}));

// Mock de fetch global
global.fetch = jest.fn();

describe('WhatsAppSendService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_API_TOKEN;
  });

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
      site_id: 'test-site-id'
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
        phone_number: '1234567890' // Sin +
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PHONE_NUMBER');
    });

    it('debería manejar error de configuración no encontrada', async () => {
      // Mock de supabase que devuelve error
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from().select().eq().single.mockResolvedValueOnce({
        error: new Error('Settings not found'),
        data: null
      });

      const result = await WhatsAppSendService.sendMessage(mockParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WHATSAPP_CONFIG_NOT_FOUND');
    });

    it('debería enviar mensaje exitosamente con variables de entorno', async () => {
      // Configurar variables de entorno
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
      process.env.WHATSAPP_API_TOKEN = 'test-token';

      // Mock de supabase para obtener información del sitio
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from().select().eq().single
        .mockResolvedValueOnce({
          data: { name: 'Test Site', url: 'https://test.com' },
          error: null
        })
        .mockResolvedValueOnce({
          data: { channels: {} },
          error: null
        });

      // Mock de fetch para API de WhatsApp
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ id: 'test-message-id' }]
        })
      } as Response);

      // Mock para insertar log
      supabaseAdmin.from().insert.mockResolvedValueOnce({
        error: null
      });

      const result = await WhatsAppSendService.sendMessage({
        ...mockParams,
        from: 'Test Sender'
      });

      expect(result.success).toBe(true);
      expect(result.message_id).toBe('test-message-id');
      expect(result.status).toBe('sent');
    });

    it('debería manejar error de API de WhatsApp', async () => {
      // Configurar variables de entorno
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
      process.env.WHATSAPP_API_TOKEN = 'test-token';

      // Mock de supabase para obtener información del sitio
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from().select().eq().single
        .mockResolvedValueOnce({
          data: { name: 'Test Site' },
          error: null
        })
        .mockResolvedValueOnce({
          data: { channels: {} },
          error: null
        });

      // Mock de fetch que devuelve error
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: { message: 'Invalid phone number' }
        })
      } as Response);

      const result = await WhatsAppSendService.sendMessage(mockParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WHATSAPP_SEND_FAILED');
    });
  });
}); 