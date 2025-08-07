/**
 * Tests para la integración de NeverBounce
 * 
 * Nota: Estos tests requieren que esté configurada la variable de entorno
 * NEVER_BOUNCE_API_KEY para ejecutarse completamente.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

// Mock de NeverBounce para evitar hacer llamadas reales durante los tests
jest.mock('neverbounce', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      single: {
        check: jest.fn().mockImplementation((email: string) => {
          // Simular diferentes respuestas según el email
          if (email === 'valid@example.com') {
            return Promise.resolve({
              result: 'valid',
              flags: ['has_dns', 'has_dns_mx'],
              suggested_correction: null
            });
          }
          
          if (email === 'invalid@notreal.xyz') {
            return Promise.resolve({
              result: 'invalid',
              flags: [],
              suggested_correction: null
            });
          }
          
          if (email === 'test@10minutemail.com') {
            return Promise.resolve({
              result: 'disposable',
              flags: ['disposable'],
              suggested_correction: null
            });
          }
          
          if (email === 'typo@gmial.com') {
            return Promise.resolve({
              result: 'invalid',
              flags: [],
              suggested_correction: 'typo@gmail.com'
            });
          }
          
          // Email válido por defecto
          return Promise.resolve({
            result: 'valid',
            flags: [],
            suggested_correction: null
          });
        })
      }
    }))
  };
});

describe('NeverBounce Email Validation API', () => {
  beforeAll(() => {
    // Configurar variable de entorno para los tests
    process.env.NEVER_BOUNCE_API_KEY = 'test_api_key';
  });

  describe('POST /api/integrations/neverbounce/validate', () => {
    test('should validate a valid email successfully', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'valid@example.com'
        })
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          email: 'valid@example.com',
          isValid: true,
          result: 'valid',
          flags: expect.any(Array),
          suggested_correction: null,
          execution_time: expect.any(Number),
          message: expect.any(String),
          timestamp: expect.any(String)
        }
      });
    });

    test('should handle invalid email', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'invalid@notreal.xyz'
        })
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          email: 'invalid@notreal.xyz',
          isValid: false,
          result: 'invalid',
          message: expect.stringContaining('invalid'),
          timestamp: expect.any(String)
        }
      });
    });

    test('should detect disposable email', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'test@10minutemail.com'
        })
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          email: 'test@10minutemail.com',
          isValid: false,
          result: 'disposable',
          timestamp: expect.any(String)
        }
      });
    });

    test('should provide suggested correction for typos', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'typo@gmial.com'
        })
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          email: 'typo@gmial.com',
          isValid: false,
          result: 'invalid',
          suggested_correction: 'typo@gmail.com',
          timestamp: expect.any(String)
        }
      });
    });

    test('should return 400 for missing email', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(400);

      const result = await response.json();
      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'Email is required',
          details: expect.any(String)
        }
      });
    });

    test('should handle malformed email format', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'not-an-email'
        })
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          email: 'not-an-email',
          isValid: false,
          result: 'invalid',
          flags: ['invalid_format'],
          message: 'Invalid email format',
          timestamp: expect.any(String)
        }
      });
    });

    test('should handle empty email string', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: ''
        })
      });

      expect(response.status).toBe(400);

      const result = await response.json();
      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'Email is required'
        }
      });
    });
  });

  describe('GET /api/integrations/neverbounce/validate', () => {
    test('should return service information', async () => {
      const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
        method: 'GET'
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result).toMatchObject({
        success: true,
        data: {
          service: 'NeverBounce Email Validation',
          version: '1.0.0',
          description: expect.any(String),
          endpoints: {
            validate: {
              method: 'POST',
              path: '/api/integrations/neverbounce/validate',
              description: expect.any(String),
              body: expect.any(Object),
              response: expect.any(Object)
            }
          },
          status: expect.stringMatching(/configured|not_configured/),
          timestamp: expect.any(String)
        }
      });
    });
  });
});

// Tests de integración (requieren API key real)
describe('NeverBounce Integration Tests', () => {
  // Solo ejecutar si hay API key real configurada
  const skipIfNoApiKey = process.env.NEVER_BOUNCE_API_KEY?.startsWith('nb_') ? test : test.skip;

  skipIfNoApiKey('should work with real NeverBounce API', async () => {
    // Desactivar el mock para este test
    jest.unmock('neverbounce');
    
    const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'support@neverbounce.com' // Email público de NeverBounce
      })
    });

    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result).toMatchObject({
      success: true,
      data: {
        email: 'support@neverbounce.com',
        isValid: expect.any(Boolean),
        result: expect.any(String),
        execution_time: expect.any(Number),
        timestamp: expect.any(String)
      }
    });
  });
});

// Test de performance
describe('Performance Tests', () => {
  test('should respond within reasonable time', async () => {
    const startTime = Date.now();
    
    const response = await fetch('http://localhost:3000/api/integrations/neverbounce/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com'
      })
    });

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    expect(response.status).toBe(200);
    expect(responseTime).toBeLessThan(5000); // Menos de 5 segundos
  });
});