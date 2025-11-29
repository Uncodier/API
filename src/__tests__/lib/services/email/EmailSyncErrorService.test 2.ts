/**
 * Tests for EmailSyncErrorService - Static Methods Only
 */

// Mock the supabase client to avoid database connection issues in tests
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn()
        }))
      })),
      update: jest.fn(() => ({
        eq: jest.fn()
      }))
    }))
  }
}));

import { EmailSyncErrorService } from '@/lib/services/email/EmailSyncErrorService';

describe('EmailSyncErrorService', () => {
  describe('determineErrorType', () => {
    it('should identify configuration errors', () => {
      const tokenError = new Error('No se encontró token de email para el sitio');
      const settingsError = new Error('Site settings not found');
      const configError = new Error('Email configuration not found');

      expect(EmailSyncErrorService.determineErrorType(tokenError)).toBe('configuration');
      expect(EmailSyncErrorService.determineErrorType(settingsError)).toBe('configuration');
      expect(EmailSyncErrorService.determineErrorType(configError)).toBe('configuration');
    });

    it('should identify connection errors', () => {
      const connectError = new Error('Connection failed');
      const timeoutError = new Error('Request timeout');
      const authError = new Error('Authentication failed');
      const econnrefusedError = new Error('ECONNREFUSED');
      const enotfoundError = new Error('ENOTFOUND');
      const loginError = new Error('Login failed');

      expect(EmailSyncErrorService.determineErrorType(connectError)).toBe('connection');
      expect(EmailSyncErrorService.determineErrorType(timeoutError)).toBe('connection');
      expect(EmailSyncErrorService.determineErrorType(authError)).toBe('connection');
      expect(EmailSyncErrorService.determineErrorType(econnrefusedError)).toBe('connection');
      expect(EmailSyncErrorService.determineErrorType(enotfoundError)).toBe('connection');
      expect(EmailSyncErrorService.determineErrorType(loginError)).toBe('connection');
    });

    it('should default to fetch error for unknown errors', () => {
      const unknownError = new Error('Some random error');
      const parseError = new Error('JSON parse error');

      expect(EmailSyncErrorService.determineErrorType(unknownError)).toBe('fetch');
      expect(EmailSyncErrorService.determineErrorType(parseError)).toBe('fetch');
    });
  });

  describe('shouldHandleAsFailure', () => {
    it('should handle configuration errors as failures', () => {
      expect(EmailSyncErrorService.shouldHandleAsFailure('configuration')).toBe(true);
    });

    it('should handle connection errors as failures', () => {
      expect(EmailSyncErrorService.shouldHandleAsFailure('connection')).toBe(true);
    });

    it('should not handle fetch errors as failures', () => {
      expect(EmailSyncErrorService.shouldHandleAsFailure('fetch')).toBe(false);
    });
  });
});
