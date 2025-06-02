import { NextRequest } from 'next/server';
import { EmailSendService } from '@/lib/services/email/EmailSendService';

// Mock de EmailSendService
jest.mock('@/lib/services/email/EmailSendService');

// Mock completo del cliente de Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((tableName) => {
      if (tableName === 'settings') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => Promise.resolve({
                data: {
                  channels: {
                    email: {
                      email: 'test@example.com'
                    }
                  }
                },
                error: null
              }))
            }))
          }))
        };
      } else {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              order: jest.fn(() => ({
                limit: jest.fn(() => Promise.resolve({
                  data: [],
                  error: null
                }))
              }))
            }))
          })),
          insert: jest.fn(() => Promise.resolve({ error: null }))
        };
      }
    })
  }
}));

const mockEmailSendService = EmailSendService as jest.Mocked<typeof EmailSendService>;

// Importar las funciones después de los mocks para evitar problemas de inicialización
const { POST, GET } = require('@/app/api/agents/tools/sendEmail/route');

describe('/api/agents/tools/sendEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST', () => {
    it('should send email successfully with valid parameters', async () => {
      // Mock successful EmailSendService response
      mockEmailSendService.sendEmail.mockResolvedValue({
        success: true,
        email_id: 'test-message-id-123',
        recipient: 'test@example.com',
        sender: 'agent@company.com',
        subject: 'Test Subject',
        message_preview: 'Test message content',
        sent_at: new Date().toISOString(),
        status: 'sent'
      });

      mockEmailSendService.isValidEmail.mockImplementation((email: string) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message content',
          agent_id: 'agent-123',
          conversation_id: 'conv-456',
          lead_id: 'lead-789',
          site_id: 'site-123'
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(201);
      expect(responseData.success).toBe(true);
      expect(responseData.email_id).toBe('test-message-id-123');
      expect(responseData.recipient).toBe('test@example.com');
      expect(responseData.sender).toBe('agent@company.com');
      expect(responseData.subject).toBe('Test Subject');
      expect(responseData.status).toBe('sent');

      // Verificar que se llamó a EmailSendService
      expect(mockEmailSendService.sendEmail).toHaveBeenCalledWith({
        email: 'test@example.com',
        from: 'agent@company.com',
        fromEmail: 'test@example.com',
        subject: 'Test Subject',
        message: 'Test message content',
        agent_id: 'agent-123',
        conversation_id: 'conv-456',
        lead_id: 'lead-789',
        site_id: 'site-123'
      });
    });

    it('should handle temporary email address without sending real email', async () => {
      mockEmailSendService.sendEmail.mockResolvedValue({
        success: true,
        email_id: 'mock-id',
        recipient: 'no-email@example.com',
        sender: 'agent@company.com',
        subject: 'Test Subject',
        message_preview: 'Test message for temporary email',
        sent_at: new Date().toISOString(),
        status: 'skipped',
        reason: 'Temporary email address - no real email sent'
      });

      mockEmailSendService.isValidEmail.mockImplementation((email: string) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'no-email@example.com',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message for temporary email',
          site_id: 'site-123'
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.status).toBe('skipped');
      expect(responseData.reason).toBe('Temporary email address - no real email sent');
      expect(responseData.recipient).toBe('no-email@example.com');
    });

    it('should return error for missing required fields', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          // Missing: subject, message, site_id (from is optional)
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
      expect(responseData.error.message).toContain('subject is required');
    });

    it('should return error for missing site_id', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message'
          // Missing: site_id
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
      expect(responseData.error.message).toBe('site_id is required');
    });

    it('should return error for invalid email format', async () => {
      mockEmailSendService.isValidEmail.mockImplementation((email: string) => {
        if (email === 'invalid-email') return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'invalid-email',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message',
          site_id: 'site-123'
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
      expect(responseData.error.message).toBe('Invalid recipient email format');
    });

    it('should handle email configuration errors', async () => {
      mockEmailSendService.isValidEmail.mockImplementation((email: string) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      });

      // Mock EmailSendService failure
      mockEmailSendService.sendEmail.mockResolvedValue({
        success: false,
        error: {
          code: 'EMAIL_CONFIG_NOT_FOUND',
          message: 'Email configuration not found for site site-123'
        }
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message content',
          site_id: 'site-123'
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('EMAIL_CONFIG_NOT_FOUND');
    });

    it('should handle SMTP transport errors', async () => {
      mockEmailSendService.isValidEmail.mockImplementation((email: string) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      });

      // Mock EmailSendService failure
      mockEmailSendService.sendEmail.mockResolvedValue({
        success: false,
        error: {
          code: 'EMAIL_SEND_FAILED',
          message: 'SMTP connection error'
        }
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          from: 'agent@company.com',
          subject: 'Test Subject',
          message: 'Test message content',
          site_id: 'site-123'
        }),
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('EMAIL_SEND_FAILED');
    });
  });

  describe('GET', () => {
    it('should handle GET requests for email logs query', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/sendEmail?agent_id=agent-123');

      const response = await GET(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(Array.isArray(responseData.emails)).toBe(true);
    });
  });
}); 