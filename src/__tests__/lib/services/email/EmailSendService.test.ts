import * as nodemailer from 'nodemailer';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';

// Mock de nodemailer
jest.mock('nodemailer');

// Mock de EmailConfigService
jest.mock('@/lib/services/email/EmailConfigService');

// Mock de supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn()
        }))
      })),
      insert: jest.fn(() => Promise.resolve({ error: null }))
    }))
  }
}));

const mockTransporter = {
  sendMail: jest.fn()
};

const mockNodemailer = nodemailer as jest.Mocked<typeof nodemailer>;
const mockEmailConfigService = EmailConfigService as jest.Mocked<typeof EmailConfigService>;

// Configurar mocks
mockNodemailer.createTransport.mockReturnValue(mockTransporter as any);

const mockEmailConfig = {
  user: 'test@example.com',
  email: 'test@example.com',
  password: 'password123',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  tls: true
};

const mockSiteInfo = {
  name: 'Mi Sitio de Prueba',
  url: 'https://misitio.com'
};

// Mock de supabase
const mockSupabase = require('@/lib/database/supabase-client');

describe('EmailSendService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmailConfigService.getEmailConfig.mockResolvedValue(mockEmailConfig);
    
    // Mock exitoso para obtener información del sitio
    mockSupabase.supabaseAdmin.from.mockReturnValue({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn().mockResolvedValue({
            data: mockSiteInfo,
            error: null
          })
        }))
      }))
    });
  });

  describe('sendEmail', () => {
    it('should handle temporary email addresses', async () => {
      const result = await EmailSendService.sendEmail({
        email: 'no-email@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'site-123'
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('Temporary email address - no real email sent');
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('should send email successfully with valid parameters', async () => {
      mockTransporter.sendMail.mockResolvedValue({
        messageId: 'test-message-id',
        accepted: ['test@example.com']
      });

      const result = await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'site-123'
      });

      expect(result.success).toBe(true);
      expect(result.email_id).toBe('test-message-id');
      expect(result.status).toBe('sent');
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'agent@company.com <test@example.com>',
          to: 'test@example.com',
          subject: 'Test Subject'
        })
      );
    });

    it('should handle email configuration errors', async () => {
      mockEmailConfigService.getEmailConfig.mockRejectedValue(
        new Error('Site settings not found')
      );

      const result = await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'invalid-site-id'
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMAIL_CONFIG_NOT_FOUND');
      expect(result.error?.message).toContain('Email configuration not found for site invalid-site-id');
    });

    it('should handle SMTP transport errors', async () => {
      mockTransporter.sendMail.mockRejectedValue(
        new Error('SMTP connection failed')
      );

      const result = await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'site-123'
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMAIL_SEND_FAILED');
      expect(result.error?.message).toBe('SMTP connection failed');
    });

    it('should build HTML content correctly with site info', async () => {
      mockTransporter.sendMail.mockResolvedValue({
        messageId: 'test-id',
        accepted: ['test@example.com']
      });

      const multilineMessage = 'Line 1\nLine 2\nLine 3';

      await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: multilineMessage,
        site_id: 'site-123'
      });

      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.html).toContain('Line 1');
      expect(callArgs.html).toContain('Line 2');
      expect(callArgs.html).toContain('Line 3');
      expect(callArgs.text).toBe(multilineMessage);
    });

    it('should handle site info errors gracefully', async () => {
      // Mock error al obtener información del sitio
      mockSupabase.supabaseAdmin.from.mockReturnValue({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn().mockResolvedValue({
              data: null,
              error: new Error('Site not found')
            })
          }))
        }))
      });

      mockTransporter.sendMail.mockResolvedValue({
        messageId: 'test-id',
        accepted: ['test@example.com']
      });

      const result = await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'site-123'
      });

      expect(result.success).toBe(true);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Test message')
        })
      );
    });

    it('should handle secure SMTP port correctly', async () => {
      const secureConfig = {
        ...mockEmailConfig,
        smtpPort: 465
      };
      
      mockEmailConfigService.getEmailConfig.mockResolvedValue(secureConfig);
      mockTransporter.sendMail.mockResolvedValue({
        messageId: 'test-id',
        accepted: ['test@example.com']
      });

      await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'site-123'
      });

      expect(mockNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          secure: true // should be true for port 465
        })
      );
    });
  });

  describe('isValidEmail', () => {
    it('should validate correct email formats', () => {
      expect(EmailSendService.isValidEmail('test@example.com')).toBe(true);
      expect(EmailSendService.isValidEmail('user.name@domain.co.uk')).toBe(true);
      expect(EmailSendService.isValidEmail('user+tag@example.org')).toBe(true);
    });

    it('should reject invalid email formats', () => {
      expect(EmailSendService.isValidEmail('invalid-email')).toBe(false);
      expect(EmailSendService.isValidEmail('test@')).toBe(false);
      expect(EmailSendService.isValidEmail('@example.com')).toBe(false);
      expect(EmailSendService.isValidEmail('test@.com')).toBe(false);
      expect(EmailSendService.isValidEmail('')).toBe(false);
    });
  });
}); 