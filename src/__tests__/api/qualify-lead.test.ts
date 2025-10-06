import { POST } from '@/app/api/agents/tools/qualify-lead/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NextRequest } from 'next/server';

// Mock Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn()
  }
}));

describe('/api/agents/tools/qualify-lead', () => {
  const mockSiteId = '123e4567-e89b-12d3-a456-426614174000';
  const mockLeadId = '123e4567-e89b-12d3-a456-426614174001';
  const mockEmail = 'test@example.com';
  const mockPhone = '+1234567890';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Validation', () => {
    it('should return 400 if site_id is missing', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      // First call - search for lead
      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      // Second call - update lead
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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
      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockResolvedValue({ data: [], error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      // First call - search for lead
      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      // Second call - update lead
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockIlike = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      // First call - search for lead
      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      // Second call - update lead
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        ilike: mockIlike,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockResolvedValue({ data: [mockLead], error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockUpdate = jest.fn().mockReturnThis();
      const mockSingle = jest.fn();

      mockSingle.mockResolvedValueOnce({ data: [mockLead], error: null });
      mockSingle.mockResolvedValueOnce({ data: mockUpdatedLead, error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        update: mockUpdate,
        single: mockSingle
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/qualify-lead', {
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

