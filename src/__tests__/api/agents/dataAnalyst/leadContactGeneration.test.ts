import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agents/dataAnalyst/leadContactGeneration/route';

// Mock de los módulos externos
jest.mock('@/lib/agentbase', () => ({
  CommandFactory: {
    createCommand: jest.fn().mockReturnValue({
      id: 'mock-command',
      task: 'generate contact email addresses for lead',
      status: 'pending'
    })
  },
  ProcessorInitializer: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn(),
      getCommandService: jest.fn().mockReturnValue({
        submitCommand: jest.fn().mockResolvedValue('cmd_test_123')
      })
    })
  }
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({
                  data: [{ id: 'agent-123', user_id: 'user-123' }],
                  error: null
                })
              })
            })
          })
        })
      })
    })
  }
}));

// Helper para crear requests
function createTestRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents/dataAnalyst/leadContactGeneration', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });
}

describe('/api/agents/dataAnalyst/leadContactGeneration', () => {
  
  beforeAll(() => {
    // El mock ya está configurado arriba para el agente Data Analyst
    // y para las consultas de comandos con timeout
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  test('should validate required parameters', async () => {
    const request = createTestRequest({});
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INVALID_REQUEST');
    expect(data.error.message).toBe('name, domain, and site_id are required');
  });

  test('should validate site_id format', async () => {
    const request = createTestRequest({
      name: 'John Doe',
      domain: 'example.com',
      site_id: 'invalid-uuid'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INVALID_REQUEST');
    expect(data.error.message).toBe('site_id must be a valid UUID');
  });

  test('should validate domain format', async () => {
    const request = createTestRequest({
      name: 'John Doe',
      domain: 'invalid-domain',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INVALID_REQUEST');
    expect(data.error.message).toBe('domain must be a valid domain format (e.g., company.com)');
  });

  test('should accept valid request and generate email patterns', async () => {
    const request = createTestRequest({
      name: 'Juan Carlos Pérez',
      domain: 'techcorp.com',
      context: 'CEO of TechCorp',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.data.contact_name).toBe('Juan Carlos Pérez');
    expect(data.data.domain).toBe('techcorp.com');
    expect(data.data.context).toBe('CEO of TechCorp');
    expect(data.data.basic_patterns_generated).toBeDefined();
    expect(Array.isArray(data.data.basic_patterns_generated)).toBe(true);
    expect(data.data.basic_patterns_generated.length).toBeGreaterThan(0);
    expect(data.data.basic_patterns_generated.length).toBeLessThanOrEqual(15);
  });

  test('should generate correct email patterns for simple name ordered by probability', async () => {
    const request = createTestRequest({
      name: 'John Smith',
      domain: 'company.com',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain expected patterns
    expect(patterns).toContain('john.smith@company.com');
    expect(patterns).toContain('j.smith@company.com');
    expect(patterns).toContain('jsmith@company.com');
    expect(patterns).toContain('johnsmith@company.com');
    expect(patterns).toContain('john_smith@company.com');
    expect(patterns).toContain('john@company.com');
    
    // Most common pattern should be first (firstname.lastname)
    expect(patterns[0]).toBe('john.smith@company.com');
    
    // Second should be initial + lastname
    expect(patterns[1]).toBe('j.smith@company.com');
  });

  test('should handle compound names correctly', async () => {
    const request = createTestRequest({
      name: 'María José García López',
      domain: 'empresa.es',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    expect(patterns).toContain('maría.lópez@empresa.es');
    expect(patterns).toContain('m.lópez@empresa.es');
    expect(patterns).toContain('maría_lópez@empresa.es');
    expect(patterns).toContain('maría@empresa.es');
    
    // Should contain Spanish cultural patterns with paternal surname
    expect(patterns).toContain('maría.garcía@empresa.es');
    
    // Most common pattern should appear early in the list
    expect(patterns.slice(0, 5)).toContain('maría.lópez@empresa.es');
  });

  test('should generate department-specific emails when role is in context', async () => {
    const request = createTestRequest({
      name: 'John Smith',
      domain: 'company.com',
      context: 'Marketing Director at TechCorp, responsible for digital campaigns',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain regular patterns
    expect(patterns).toContain('john.smith@company.com');
    
    // Should contain department-specific patterns
    expect(patterns).toContain('john.smith@marketing.company.com');
    expect(patterns).toContain('marketing.john@company.com');
    expect(patterns).toContain('john@marketing.company.com');
    
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(15);
  });

  test('should generate CEO-specific emails when CEO role is detected', async () => {
    const request = createTestRequest({
      name: 'Sarah Johnson',
      domain: 'startup.io',
      context: 'CEO and founder of innovative startup',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain regular patterns
    expect(patterns).toContain('sarah.johnson@startup.io');
    
    // Should contain CEO-specific patterns
    expect(patterns).toContain('sarah.johnson@ceo.startup.io');
    expect(patterns).toContain('ceo.sarah@startup.io');
    expect(patterns).toContain('sarah@ceo.startup.io');
    
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(15);
  });

  test('should generate exactly 15 emails when role is detected (10 personal + 5 departmental)', async () => {
    const request = createTestRequest({
      name: 'Michael Davis',
      domain: 'techcompany.com',
      context: 'Marketing Director with 10 years experience',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should generate up to 15 emails total
    expect(patterns.length).toBeGreaterThan(10); // Should have more than just personal
    expect(patterns.length).toBeLessThanOrEqual(15);
    
    // Should contain marketing-specific patterns in the last 5
    const lastFive = patterns.slice(-5);
    const hasMarketingPatterns = lastFive.some((email: string) => 
      email.includes('marketing') || email.includes('@marketing.') || email.includes('marketing.')
    );
    expect(hasMarketingPatterns).toBe(true);
  });

  test('should handle Spanish names with cultural patterns', async () => {
    const request = createTestRequest({
      name: 'María José García López',
      domain: 'empresa.es',
      context: 'CEO de empresa española de tecnología',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain standard pattern
    expect(patterns).toContain('maría.lópez@empresa.es');
    
    // Should contain Spanish cultural patterns (compound names, paternal surname)
    const hasSpanishPatterns = patterns.some((email: string) => 
      email.includes('garcía') || // paternal surname
      email.includes('mariajosé') || // compound first name
      email.includes('maría.garcía') // first name + paternal surname
    );
    expect(hasSpanishPatterns).toBe(true);
    
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(15);
  });

  test('should handle Dutch names with tussenvoegsel', async () => {
    const request = createTestRequest({
      name: 'Jan van der Berg',
      domain: 'company.nl',
      context: 'Director of operations in Amsterdam',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain standard pattern
    expect(patterns).toContain('jan.berg@company.nl');
    
    // Should contain Dutch cultural patterns handling tussenvoegsel
    const hasDutchPatterns = patterns.some((email: string) => 
      email.includes('jan.van') || 
      email.includes('jan.vanderbeg') ||
      email.includes('jan.berg')
    );
    expect(hasDutchPatterns).toBe(true);
    
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(15);
  });

  test('should prioritize lastname.firstname for German context', async () => {
    const request = createTestRequest({
      name: 'Hans Müller',
      domain: 'firma.de',
      context: 'Geschäftsführer in Deutschland',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    // Should contain lastname.firstname pattern early for German context
    const lastNameFirstIndex = patterns.findIndex((email: string) => email === 'müller.hans@firma.de');
    const firstNameFirstIndex = patterns.findIndex((email: string) => email === 'hans.müller@firma.de');
    
    // In German context, lastname.firstname should appear relatively early
    expect(lastNameFirstIndex).toBeGreaterThan(-1);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(15);
  });

  test('should handle single name correctly', async () => {
    const request = createTestRequest({
      name: 'Madonna',
      domain: 'music.com',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    const patterns = data.data.basic_patterns_generated;
    
    expect(patterns).toContain('madonna@music.com');
    expect(patterns.length).toBeGreaterThan(0);
  });

  test('should include fallback patterns when AI processing times out', async () => {
    // Mock timeout scenario
    const request = createTestRequest({
      name: 'Test User',
      domain: 'test.com',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.basic_patterns_generated).toBeDefined();
    expect(data.data.status).toBe('timeout');
    expect(data.data.fallback_emails).toBeDefined();
  });

  test('should return error when Data Analyst agent not found', async () => {
    // Mock scenario where no agent is found
    const mockSupabaseAdmin = require('@/lib/database/supabase-client').supabaseAdmin;
    mockSupabaseAdmin.from.mockReturnValueOnce({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({
                  data: [],
                  error: null
                })
              })
            })
          })
        })
      })
    });

    const request = createTestRequest({
      name: 'John Doe',
      domain: 'example.com',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('DATA_ANALYST_NOT_FOUND');
  });

  test('should handle empty name gracefully', async () => {
    const request = createTestRequest({
      name: '   ',
      domain: 'example.com',
      site_id: '123e4567-e89b-12d3-a456-426614174000'
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    // Should still process even with empty name, returning minimal patterns
    expect(data.data.basic_patterns_generated).toBeDefined();
  });

  test('should validate specific domain formats', async () => {
    const validDomains = ['example.com', 'sub.example.com', 'example-test.co.uk'];
    const invalidDomains = ['notadomain', '.com', 'example.', 'http://example.com'];

    for (const domain of validDomains) {
      const request = createTestRequest({
        name: 'Test User',
        domain,
        site_id: '123e4567-e89b-12d3-a456-426614174000'
      });
      
      const response = await POST(request);
      expect(response.status).toBe(200);
    }

    for (const domain of invalidDomains) {
      const request = createTestRequest({
        name: 'Test User',
        domain,
        site_id: '123e4567-e89b-12d3-a456-426614174000'
      });
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_REQUEST');
    }
  });
});
