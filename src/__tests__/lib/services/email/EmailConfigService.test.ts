import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Mock del cliente de Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn()
  }
}));

// Mock del módulo crypto-js
jest.mock('crypto-js', () => ({
  AES: {
    decrypt: jest.fn()
  },
  enc: {
    Utf8: {
      toString: jest.fn()
    }
  }
}));

// Mock del servicio de desencriptación
global.fetch = jest.fn();

const mockSupabaseAdmin = supabaseAdmin as jest.Mocked<typeof supabaseAdmin>;

describe('EmailConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock process.env
    process.env.ENCRYPTION_KEY = 'test-encryption-key';
  });

  describe('getEmailConfig', () => {
    it('should include aliases when configured in email channel', async () => {
      // Mock para settings con aliases
      const mockSettingsData = {
        channels: {
          email: {
            email: 'test@example.com',
            incomingServer: 'imap.example.com',
            incomingPort: 993,
            outgoingServer: 'smtp.example.com',
            outgoingPort: 587,
            aliases: ['support@example.com', 'info@example.com', 'sales@example.com']
          }
        }
      };

      // Mock para secure_tokens
      const mockTokenData = {
        encrypted_value: 'test:encryptedValue'
      };

      // Setup mocks
      mockSupabaseAdmin.from.mockImplementation((tableName: string) => {
        if (tableName === 'settings') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockSettingsData,
                  error: null
                })
              })
            })
          } as any;
        } else if (tableName === 'secure_tokens') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: mockTokenData,
                    error: null
                  })
                })
              })
            })
          } as any;
        }
        return {} as any;
      });

      // Mock CryptoJS decrypt to return a valid password
      const CryptoJS = require('crypto-js');
      CryptoJS.AES.decrypt.mockReturnValue({
        toString: jest.fn().mockReturnValue('test-password')
      });

      // Mock fetch para el servicio de desencriptación (fallback)
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: {
            tokenValue: 'test-password'
          }
        })
      });

      const result = await EmailConfigService.getEmailConfig('test-site-id');

      expect(result).toEqual({
        user: 'test@example.com',
        email: 'test@example.com', 
        password: 'test-password',
        host: 'imap.example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        tls: true,
        aliases: ['support@example.com', 'info@example.com', 'sales@example.com']
      });
      
      expect(result.aliases).toEqual(['support@example.com', 'info@example.com', 'sales@example.com']);
    });

    it('should handle configuration without aliases', async () => {
      // Mock para settings sin aliases
      const mockSettingsData = {
        channels: {
          email: {
            email: 'test@example.com',
            incomingServer: 'imap.example.com',
            incomingPort: 993,
            outgoingServer: 'smtp.example.com',
            outgoingPort: 587
            // No aliases property
          }
        }
      };

      // Mock para secure_tokens
      const mockTokenData = {
        encrypted_value: 'test:encryptedValue'
      };

      // Setup mocks
      mockSupabaseAdmin.from.mockImplementation((tableName: string) => {
        if (tableName === 'settings') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockSettingsData,
                  error: null
                })
              })
            })
          } as any;
        } else if (tableName === 'secure_tokens') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: mockTokenData,
                    error: null
                  })
                })
              })
            })
          } as any;
        }
        return {} as any;
      });

      // Mock CryptoJS decrypt to return a valid password
      const CryptoJS = require('crypto-js');
      CryptoJS.AES.decrypt.mockReturnValue({
        toString: jest.fn().mockReturnValue('test-password')
      });

      // Mock fetch para el servicio de desencriptación (fallback)
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: {
            tokenValue: 'test-password'
          }
        })
      });

      const result = await EmailConfigService.getEmailConfig('test-site-id');

      expect(result.aliases).toBeNull();
    });
  });
}); 