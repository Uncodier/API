import { ApiKeyService } from '../ApiKeyService';
import { supabase } from '@/lib/database/supabase-client';

// Mock environment variables
process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_length!!';

// Mock Supabase client
jest.mock('@/lib/database/supabase-client', () => ({
  supabase: {
    from: jest.fn(() => ({
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis()
    }))
  }
}));

describe('ApiKeyService', () => {
  const testUserId = '123e4567-e89b-12d3-a456-426614174000';
  const testSiteId = '123e4567-e89b-12d3-a456-426614174001';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateApiKey', () => {
    it('should generate a valid API key with default prefix', () => {
      const apiKey = ApiKeyService.generateApiKey();
      expect(apiKey).toMatch(/^key_[A-Za-z0-9_-]+$/);
      expect(apiKey.length).toBeGreaterThan(32); // Asegurar longitud mínima
    });

    it('should generate a valid API key with custom prefix', () => {
      const prefix = 'test';
      const apiKey = ApiKeyService.generateApiKey(prefix);
      expect(apiKey).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`));
    });

    it('should generate unique keys', () => {
      const key1 = ApiKeyService.generateApiKey();
      const key2 = ApiKeyService.generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe('encryption and decryption', () => {
    it('should successfully encrypt and decrypt an API key', () => {
      const originalKey = ApiKeyService.generateApiKey();
      
      // @ts-ignore - Acceder a método privado para testing
      const encrypted = ApiKeyService['encryptApiKey'](originalKey);
      expect(encrypted).toContain(':'); // Verificar formato iv:encrypted
      
      // @ts-ignore - Acceder a método privado para testing
      const decrypted = ApiKeyService['decryptApiKey'](encrypted);
      expect(decrypted).toBe(originalKey);
    });

    it('should generate different encryptions for the same key', () => {
      const apiKey = ApiKeyService.generateApiKey();
      
      // @ts-ignore - Acceder a método privado para testing
      const encrypted1 = ApiKeyService['encryptApiKey'](apiKey);
      // @ts-ignore - Acceder a método privado para testing
      const encrypted2 = ApiKeyService['encryptApiKey'](apiKey);
      
      expect(encrypted1).not.toBe(encrypted2); // IVs diferentes
      
      // @ts-ignore - Acceder a método privado para testing
      const decrypted1 = ApiKeyService['decryptApiKey'](encrypted1);
      // @ts-ignore - Acceder a método privado para testing
      const decrypted2 = ApiKeyService['decryptApiKey'](encrypted2);
      
      expect(decrypted1).toBe(apiKey);
      expect(decrypted2).toBe(apiKey);
    });

    it('should throw error when decrypting invalid format', () => {
      expect(() => {
        // @ts-ignore - Acceder a método privado para testing
        ApiKeyService['decryptApiKey']('invalid_format');
      }).toThrow('Invalid encrypted key format');
    });

    it('should throw error when encryption key is missing', () => {
      const originalEnv = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      expect(() => {
        // @ts-ignore - Acceder a método privado para testing
        ApiKeyService['encryptApiKey']('test_key');
      }).toThrow('Missing ENCRYPTION_KEY environment variable');

      process.env.ENCRYPTION_KEY = originalEnv;
    });
  });

  describe('createApiKey', () => {
    const mockApiKeyData = {
      name: 'Test API Key',
      scopes: ['read', 'write'],
      site_id: testSiteId,
      expirationDays: 90
    };

    it('should create a new API key with correct format', async () => {
      const mockDbResponse = {
        data: { id: 'test-id', prefix: 'key', expires_at: new Date().toISOString() },
        error: null
      };

      (supabase.from as jest.Mock).mockImplementation(() => ({
        insert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue(mockDbResponse)
      }));

      const result = await ApiKeyService.createApiKey(testUserId, mockApiKeyData);

      expect(result).toHaveProperty('apiKey');
      expect(result.apiKey).toMatch(/^key_[A-Za-z0-9_-]+$/);
      expect(result).toHaveProperty('id', 'test-id');
      expect(result).toHaveProperty('prefix', 'key');
      expect(result).toHaveProperty('expires_at');
    });

    it('should throw error on database failure', async () => {
      const mockDbResponse = {
        data: null,
        error: new Error('Database error')
      };

      (supabase.from as jest.Mock).mockImplementation(() => ({
        insert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue(mockDbResponse)
      }));

      await expect(
        ApiKeyService.createApiKey(testUserId, mockApiKeyData)
      ).rejects.toThrow('Failed to create API key');
    });
  });

  describe('validateApiKey', () => {
    const mockValidKey = 'test_validkey123';
    const mockEncryptedKey = 'iv:encrypted';

    beforeEach(() => {
      // Mock del método privado decryptApiKey
      jest.spyOn(ApiKeyService.prototype as any, 'decryptApiKey')
        .mockImplementation(function(this: any, ...args: unknown[]) {
          const key = args[0];
          if (typeof key === 'string' && key === mockEncryptedKey) {
            return mockValidKey;
          }
          throw new Error('Decryption failed');
        });
    });

    it('should validate a correct API key', async () => {
      const mockDbResponse = {
        data: [{
          id: 'test-id',
          key_hash: mockEncryptedKey,
          status: 'active',
          expires_at: new Date(Date.now() + 86400000).toISOString() // tomorrow
        }],
        error: null
      };

      (supabase.from as jest.Mock).mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(mockDbResponse)
      }));

      const result = await ApiKeyService.validateApiKey(mockValidKey);
      expect(result.isValid).toBe(true);
      expect(result.keyData).toBeDefined();
    });

    it('should invalidate expired key', async () => {
      const mockDbResponse = {
        data: [{
          id: 'test-id',
          key_hash: mockEncryptedKey,
          status: 'active',
          expires_at: new Date(Date.now() - 86400000).toISOString() // yesterday
        }],
        error: null
      };

      (supabase.from as jest.Mock).mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(mockDbResponse),
        update: jest.fn().mockReturnThis()
      }));

      const result = await ApiKeyService.validateApiKey(mockValidKey);
      expect(result.isValid).toBe(false);
    });

    it('should handle invalid key format', async () => {
      const result = await ApiKeyService.validateApiKey('invalid_format_no_prefix');
      expect(result.isValid).toBe(false);
    });
  });
}); 