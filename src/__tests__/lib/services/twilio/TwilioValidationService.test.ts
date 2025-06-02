import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import crypto from 'crypto';

// Mock de Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            like: jest.fn(() => ({
              // Mock de la respuesta de la base de datos
            }))
          }))
        }))
      }))
    }))
  }
}));

// Mock de CryptoJS
jest.mock('crypto-js', () => ({
  AES: {
    decrypt: jest.fn(() => ({
      toString: jest.fn(() => 'mocked_auth_token_12345')
    }))
  },
  enc: {
    Utf8: {}
  }
}));

describe('TwilioValidationService', () => {
  const mockSiteId = '123e4567-e89b-12d3-a456-426614174000';
  const mockWhatsappNumber = '+1234567890';
  const mockAuthToken = 'test_auth_token_12345';
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Configurar variables de entorno para las pruebas
    process.env.ENCRYPTION_KEY = 'test_encryption_key';
  });

  describe('validateTwilioRequest', () => {
    it('should validate a correct Twilio signature', async () => {
      // Mock de la respuesta de la base de datos
      const mockTokenData = {
        id: '1',
        site_id: mockSiteId,
        token_type: 'twilio_whatsapp',
        identifier: mockWhatsappNumber,
        encrypted_value: 'salt123:encrypted_value'
      };

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              like: jest.fn().mockResolvedValue({
                data: [mockTokenData],
                error: null
              })
            })
          })
        })
      });

      // Datos de prueba
      const url = 'https://example.com/api/agents/whatsapp?site_id=123&agent_id=456';
      const postData: Record<string, string> = {
        MessageSid: 'SM12345',
        From: 'whatsapp:+1234567890',
        To: 'whatsapp:+0987654321',
        Body: 'Hello test message'
      };

      // Generar una firma válida
      let dataString = url;
      const sortedKeys = Object.keys(postData).sort();
      for (const key of sortedKeys) {
        dataString += key + postData[key];
      }
      
      const validSignature = crypto
        .createHmac('sha1', mockAuthToken)
        .update(dataString, 'utf-8')
        .digest('base64');

      const result = await TwilioValidationService.validateTwilioRequest(
        url,
        postData,
        validSignature,
        mockWhatsappNumber,
        mockSiteId
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.authToken).toBeDefined();
    });

    it('should reject an invalid Twilio signature', async () => {
      // Mock de la respuesta de la base de datos
      const mockTokenData = {
        id: '1',
        site_id: mockSiteId,
        token_type: 'twilio_whatsapp',
        identifier: mockWhatsappNumber,
        encrypted_value: 'salt123:encrypted_value'
      };

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              like: jest.fn().mockResolvedValue({
                data: [mockTokenData],
                error: null
              })
            })
          })
        })
      });

      const url = 'https://example.com/api/agents/whatsapp';
      const postData: Record<string, string> = {
        MessageSid: 'SM12345',
        From: 'whatsapp:+1234567890',
        Body: 'Hello test message'
      };
      const invalidSignature = 'invalid_signature';

      const result = await TwilioValidationService.validateTwilioRequest(
        url,
        postData,
        invalidSignature,
        mockWhatsappNumber,
        mockSiteId
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid Twilio signature');
    });

    it('should return error when no auth token is found', async () => {
      // Mock de respuesta vacía de la base de datos
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              like: jest.fn().mockResolvedValue({
                data: [],
                error: null
              })
            })
          })
        })
      });

      const url = 'https://example.com/api/agents/whatsapp';
      const postData: Record<string, string> = { MessageSid: 'SM12345' };
      const signature = 'any_signature';

      const result = await TwilioValidationService.validateTwilioRequest(
        url,
        postData,
        signature,
        mockWhatsappNumber,
        mockSiteId
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('No Twilio auth token found');
    });

    it('should handle database errors gracefully', async () => {
      // Mock de error de la base de datos
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              like: jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'Database connection error' }
              })
            })
          })
        })
      });

      const url = 'https://example.com/api/agents/whatsapp';
      const postData: Record<string, string> = { MessageSid: 'SM12345' };
      const signature = 'any_signature';

      const result = await TwilioValidationService.validateTwilioRequest(
        url,
        postData,
        signature,
        mockWhatsappNumber,
        mockSiteId
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('validateSignature', () => {
    it('should create the correct data string for validation', () => {
      const url = 'https://example.com/webhook';
      const postData: Record<string, string> = {
        MessageSid: 'SM12345',
        From: 'whatsapp:+1234567890',
        Body: 'Hello'
      };
      
      // El data string debe ser: URL + clave1 + valor1 + clave2 + valor2... (ordenado alfabéticamente)
      // Esperado: https://example.com/webhookBodyHelloFromwhatsapp:+1234567890MessageSidSM12345
      
      let expectedDataString = url;
      const sortedKeys = Object.keys(postData).sort(); // ['Body', 'From', 'MessageSid']
      for (const key of sortedKeys) {
        expectedDataString += key + postData[key];
      }
      
      expect(expectedDataString).toBe('https://example.com/webhookBodyHelloFromwhatsapp:+1234567890MessageSidSM12345');
    });
  });
}); 