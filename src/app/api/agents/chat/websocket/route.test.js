import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { GET, POST } from './route';

// Mock supabaseAdmin
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                then: () => {}
              })
            })
          })
        }),
        order: () => ({
          limit: () => Promise.resolve({
            data: [
              { id: '1', content: 'Hello', role: 'user' },
              { id: '2', content: 'Hi there', role: 'assistant' }
            ],
            error: null
          })
        })
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null })
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({
            data: { id: '123e4567-e89b-12d3-a456-426614174000' },
            error: null
          })
        })
      }),
      channel: () => ({
        on: () => ({
          subscribe: () => {}
        })
      })
    })
  }
}));

// Guardar el entorno original
const originalEnv = process.env;

describe('WebSocket API Basic Tests', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock URL
    global.URL = jest.fn().mockImplementation(() => ({
      searchParams: {
        get: jest.fn()
      }
    }));
    
    // Configurar process.env para evitar modificar NODE_ENV directamente
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restaurar process.env
    process.env = originalEnv;
  });

  describe('GET endpoint', () => {
    it('should validate the WebSocket endpoint exists', () => {
      expect(typeof GET).toBe('function');
    });
  });

  describe('POST endpoint', () => {
    it('should validate the HTTP fallback endpoint exists', () => {
      expect(typeof POST).toBe('function');
    });
  });
}); 