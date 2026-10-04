const mockRpc = jest.fn();
const mockInsert = jest.fn();
const mockWorkflow = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), insert: mockInsert }),
} }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {
  getInstance: () => ({ executeWorkflow: (...args: unknown[]) => mockWorkflow(...args) }),
} }));
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));

import { POST } from '../route';
import type { NextRequest } from 'next/server';

describe('site setup shares the atomic signup credit issuer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: { success: true, outcome: 'already_initialized', credits_granted: 0 }, error: null });
    mockWorkflow.mockResolvedValue({ success: true, workflowId: 'synthetic', executionId: 'synthetic', runId: 'synthetic', status: 'running' });
  });

  it('calls the signup RPC with no caller-provided allowance and never inserts billing directly', async () => {
    const site = '10000000-0000-4000-8000-000000000001';
    const response = await POST(new Request('https://api.example.test/api/site/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_id: site }),
    }) as NextRequest);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('initialize_site_billing', { p_site_id: site });
    expect(mockInsert).not.toHaveBeenCalledWith(expect.objectContaining({ credits_available: expect.anything() }));
  });

  it('does not reintroduce direct credits as a fallback if the atomic issuer fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Synthetic unavailable database' } });
    const response = await POST(new Request('https://api.example.test/api/site/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: '10000000-0000-4000-8000-000000000001' }),
    }) as NextRequest);
    expect(response.status).toBe(200); // Existing setup continues without a financial fallback.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalledWith(expect.objectContaining({ credits_available: expect.anything() }));
  });
});