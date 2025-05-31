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
  user: 'test@company.com',
  email: 'test@company.com',
  password: 'test-password',
  smtpHost: 'smtp.company.com',
  smtpPort: 587,
  tls: true
};

describe('EmailSendService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmailConfigService.getEmailConfig.mockResolvedValue(mockEmailConfig);
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
      expect(result.recipient).toBe('no-email@example.com');
      
      // No debería llamar a servicios externos para emails temporales
      expect(mockEmailConfigService.getEmailConfig).not.toHaveBeenCalled();
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('should send email successfully with valid parameters', async () => {
      mockTransporter.sendMail.mockResolvedValue({
        messageId: 'test-message-id-123',
        accepted: ['test@example.com'],
        rejected: []
      });

      const result = await EmailSendService.sendEmail({
        email: 'test@example.com',
        from: 'agent@company.com',
        subject: 'Test Subject',
        message: 'Test message content',
        agent_id: 'agent-123',
        conversation_id: 'conv-456',
        lead_id: 'lead-789',
        site_id: 'site-123'
      });

      expect(result.success).toBe(true);
      expect(result.email_id).toBe('test-message-id-123');
      expect(result.recipient).toBe('test@example.com');
      expect(result.sender).toBe('agent@company.com');
      expect(result.subject).toBe('Test Subject');
      expect(result.status).toBe('sent');
      expect(result.message_preview).toContain('Test message content');

      // Verificar que se configuró nodemailer correctamente
      expect(mockNodemailer.createTransport).toHaveBeenCalledWith({
        host: mockEmailConfig.smtpHost,
        port: mockEmailConfig.smtpPort,
        secure: false, // smtpPort !== 465
        auth: {
          user: mockEmailConfig.user,
          pass: mockEmailConfig.password,
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      // Verificar que se envió el email
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: `AI Assistant <${mockEmailConfig.user}>`,
          to: 'test@example.com',
          subject: 'Test Subject',
          text: 'Test message content',
          replyTo: 'agent@company.com',
          html: expect.stringContaining('Test message content')
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

    it('should build HTML content correctly', async () => {
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

      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('<p style="margin: 10px 0;">Line 1</p>'),
          text: multilineMessage
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