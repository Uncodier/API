import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { POST } from '@/app/api/notifications/leadAttention/route';
import { NextRequest } from 'next/server';

// Mock de Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table) => {
      if (table === 'leads') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => ({
                data: {
                  id: 'test-lead-id',
                  name: 'Test Lead',
                  email: 'test@example.com',
                  assignee_id: 'test-assignee-id',
                  site_id: 'test-site-id',
                  status: 'contacted',
                  origin: 'email'
                },
                error: null
              }))
            }))
          }))
        };
      }
      
      if (table === 'auth.users') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => ({
                data: {
                  id: 'test-assignee-id',
                  email: 'assignee@example.com',
                  raw_user_meta_data: {
                    name: 'Test Assignee',
                    role: 'sales_manager'
                  }
                },
                error: null
              }))
            }))
          }))
        };
      }
      
      if (table === 'sites') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => ({
                data: {
                  id: 'test-site-id',
                  name: 'Test Site',
                  url: 'https://test-site.com',
                  logo_url: 'https://test-site.com/logo.png'
                },
                error: null
              }))
            }))
          }))
        };
      }
      
      if (table === 'settings') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => ({
                data: {
                  channels: {
                    email: {
                      email: 'support@test-site.com',
                      aliases: ['noreply@test-site.com']
                    }
                  }
                },
                error: null
              }))
            }))
          }))
        };
      }
      
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: null,
              error: null
            }))
          }))
        }))
      };
    })
  }
}));

// Mock de SendGrid
jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: {
    sendEmail: jest.fn(() => Promise.resolve({
      success: true,
      messageId: 'test-message-id'
    }))
  }
}));

// Mock de variables de entorno
process.env.UNCODIE_BRANDING_TEXT = 'Test Branding';
process.env.UNCODIE_COMPANY_NAME = 'Test Company';

describe('Lead Attention Notification API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should validate required fields', async () => {
    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify({
        // Missing required fields
      })
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('should accept valid lead attention notification request with minimal data', async () => {
    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001'
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.lead_id).toBe(validRequest.lead_id);
    expect(data.data.site_id).toBe('test-site-id');
    expect(data.data.assignee_id).toBe('test-assignee-id');
    expect(data.data.channel).toBe('other'); // default
    expect(data.data.priority).toBe('normal'); // default
  });

  it('should accept valid lead attention notification request with full data', async () => {
    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      message: 'Test message from lead',
      channel: 'email',
      priority: 'high',
      contact_info: {
        email: 'test@example.com',
        phone: '+1-555-123-4567'
      }
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.lead_id).toBe(validRequest.lead_id);
    expect(data.data.channel).toBe(validRequest.channel);
    expect(data.data.priority).toBe(validRequest.priority);
  });

  it('should handle different channel types', async () => {
    const channels = ['email', 'whatsapp', 'phone', 'chat', 'form', 'other'];
    
    for (const channel of channels) {
      const validRequest = {
        lead_id: '550e8400-e29b-41d4-a716-446655440001',
        message: `Test message from ${channel}`,
        channel,
        priority: 'normal'
      };

      const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequest)
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.channel).toBe(channel);
    }
  });

  it('should handle different priority levels', async () => {
    const priorities = ['low', 'normal', 'high', 'urgent'];
    
    for (const priority of priorities) {
      const validRequest = {
        lead_id: '550e8400-e29b-41d4-a716-446655440001',
        message: `Test message with ${priority} priority`,
        channel: 'email',
        priority
      };

      const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequest)
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.priority).toBe(priority);
    }
  });

  it('should handle optional contact info', async () => {
    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      message: 'Test message',
      channel: 'email',
      priority: 'normal',
      contact_info: {
        email: 'contact@example.com',
        phone: '+1-555-987-6543',
        contact_method: 'Email preferred'
      }
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should handle additional data', async () => {
    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      message: 'Test message',
      channel: 'form',
      priority: 'high',
      additional_data: {
        source: 'Contact form',
        page: '/contact',
        utm_source: 'google',
        utm_medium: 'cpc',
        timestamp: new Date().toISOString()
      }
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should handle request without message (optional)', async () => {
    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      channel: 'whatsapp',
      priority: 'urgent'
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should return error when lead has no assignee', async () => {
    // Mock para retornar un lead sin assignee_id
    const mockSupabase = require('@/lib/database/supabase-client');
    mockSupabase.supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === 'leads') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => ({
                data: {
                  id: 'test-lead-id',
                  name: 'Test Lead',
                  email: 'test@example.com',
                  assignee_id: null, // No assignee
                  site_id: 'test-site-id'
                },
                error: null
              }))
            }))
          }))
        };
      }
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => ({
              data: null,
              error: null
            }))
          }))
        }))
      };
    });

    const validRequest = {
      lead_id: '550e8400-e29b-41d4-a716-446655440001'
    };

    const request = new NextRequest('http://localhost/api/notifications/leadAttention', {
      method: 'POST',
      body: JSON.stringify(validRequest)
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('LEAD_NO_ASSIGNEE');
  });
}); 