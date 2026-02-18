import { POST } from '@/app/api/agents/tools/leads/qualify/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NextRequest } from 'next/server';

// Mock Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn()
  }
}));

describe('/api/agents/tools/leads/qualify', () => {
  const mockSiteId = '123e4567-e89b-12d3-a456-426614174000';
  const mockLeadId = '123e4567-e89b-12d3-a456-426614174001';
  const mockEmail = 'test@example.com';
  const mockPhone = '+1234567890';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Validation', () => {
    it('should return 400 if site_id is missing', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('site_id is required');
    });

    it('should return 400 if site_id is not a valid UUID', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: 'invalid-uuid',
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('site_id must be a valid UUID');
    });

    it('should return 400 if no identifier is provided', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('At least one identifier is required: lead_id, email, or phone');
    });

    it('should return 400 if status is missing', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('status is required');
    });

    it('should return 400 if status is invalid', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'invalid_status'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid status');
    });

    it('should return 400 if lead_id is not a valid UUID', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: 'invalid-uuid',
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('lead_id must be a valid UUID');
    });

    it('should return 400 if email format is invalid', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          email: 'invalid-email',
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('email format is invalid');
    });
  });

  describe('Lead lookup by lead_id', () => {
    it('should successfully update lead status when found by lead_id', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'new',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'qualified',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn(), update: jest.fn(), single: jest.fn() };
      // SELECT: select().eq(site_id).eq(id) - 1st eq returns chainable, 2nd returns Promise
      // UPDATE: update().eq(id).select().single() - 3rd eq returns chainable, single returns Promise
      chainable.eq
        .mockReturnValueOnce(chainable)
        .mockResolvedValueOnce({ data: [mockLead], error: null })
        .mockReturnValueOnce(chainable);
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.status_changed).toBe(true);
      expect(data.lead.status).toBe('qualified');
      expect(data.status_change).toEqual({
        from: 'new',
        to: 'qualified',
        timestamp: expect.any(String)
      });
    });

    it('should return 404 if lead not found', async () => {
      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn() };
      // SELECT: eq(site_id) returns chainable, eq(id) returns Promise with empty data
      chainable.eq.mockReturnValueOnce(chainable).mockResolvedValueOnce({ data: [], error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Lead not found with the provided identifiers');
    });
  });

  describe('Lead lookup by email', () => {
    it('should successfully update lead status when found by email', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'contacted',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'qualified',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn(), update: jest.fn(), single: jest.fn() };
      chainable.eq
        .mockReturnValueOnce(chainable)
        .mockResolvedValueOnce({ data: [mockLead], error: null })
        .mockReturnValueOnce(chainable);
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          email: mockEmail,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.status_changed).toBe(true);
      expect(data.lead.status).toBe('qualified');
    });
  });

  describe('Lead lookup by phone', () => {
    it('should successfully update lead status when found by phone', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        phone: mockPhone,
        name: 'Test Lead',
        status: 'new',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'contacted',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), ilike: jest.fn(), update: jest.fn(), single: jest.fn() };
      // SELECT: select().eq(site_id).ilike(phone) - ilike returns Promise (no .single())
      chainable.ilike.mockResolvedValueOnce({ data: [mockLead], error: null });
      // UPDATE: update().eq(id).select().single()
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          phone: mockPhone,
          status: 'contacted'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.status_changed).toBe(true);
      expect(data.lead.status).toBe('contacted');
    });
  });

  describe('Status already set', () => {
    it('should return success without updating if status is already set', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'qualified',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn() };
      // SELECT only - no update when status already set
      chainable.eq.mockReturnValueOnce(chainable).mockResolvedValueOnce({ data: [mockLead], error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.status_changed).toBe(false);
      expect(data.message).toBe('Lead already has the specified status');
    });
  });

  describe('Notes parameter', () => {
    it('should include notes when updating lead status', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'new',
        notes: 'Initial note',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'qualified',
        notes: 'Lead qualified after demo',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn(), update: jest.fn(), single: jest.fn() };
      chainable.eq
        .mockReturnValueOnce(chainable)
        .mockResolvedValueOnce({ data: [mockLead], error: null })
        .mockReturnValueOnce(chainable);
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'qualified',
          notes: 'Lead qualified after demo'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.lead.notes).toBe('Lead qualified after demo');
    });
  });

  describe('Next actions generation', () => {
    it('should generate appropriate next actions for qualified status', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'new',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'qualified',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn(), update: jest.fn(), single: jest.fn() };
      chainable.eq
        .mockReturnValueOnce(chainable)
        .mockResolvedValueOnce({ data: [mockLead], error: null })
        .mockReturnValueOnce(chainable);
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'qualified'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.next_actions).toBeDefined();
      expect(Array.isArray(data.next_actions)).toBe(true);
      expect(data.next_actions.length).toBeGreaterThan(0);
      
      // Check that qualified actions are included
      const actionTypes = data.next_actions.map((a: any) => a.action_type);
      expect(actionTypes).toContain('demo');
      expect(actionTypes).toContain('assessment');
    });

    it('should generate appropriate next actions for converted status', async () => {
      const mockLead = {
        id: mockLeadId,
        site_id: mockSiteId,
        email: mockEmail,
        name: 'Test Lead',
        status: 'qualified',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const mockUpdatedLead = {
        ...mockLead,
        status: 'converted',
        updated_at: new Date().toISOString()
      };

      const chainable = { select: jest.fn().mockReturnThis(), eq: jest.fn(), update: jest.fn(), single: jest.fn() };
      chainable.eq
        .mockReturnValueOnce(chainable)
        .mockResolvedValueOnce({ data: [mockLead], error: null })
        .mockReturnValueOnce(chainable);
      chainable.update.mockReturnValue(chainable);
      chainable.single.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue(chainable);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/leads/qualify', {
        method: 'POST',
        body: JSON.stringify({
          site_id: mockSiteId,
          lead_id: mockLeadId,
          status: 'converted'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      
      const actionTypes = data.next_actions.map((a: any) => a.action_type);
      expect(actionTypes).toContain('onboarding');
      expect(actionTypes).toContain('celebrate');
    });
  });
});

