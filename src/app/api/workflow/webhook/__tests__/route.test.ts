// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

const from = jest.fn();
const getInstance = jest.fn();
const fireWorkflowDispatch = jest.fn();
const isInternalServiceRequest = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({ WorkflowService: { getInstance } }));
jest.unstable_mockModule('@/lib/services/workflow-robot/dispatch', () => ({ fireWorkflowDispatch }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest }));
const { POST } = await import('../route');

describe('POST /api/workflow/webhook', () => {
  const executeWorkflow = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    isInternalServiceRequest.mockReturnValue(true);
    executeWorkflow.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      runId: 'run-1',
    });
    getInstance.mockReturnValue({ executeWorkflow });
  });

  it('rejects a spoofed tenant event before reading its body or executing workflows', async () => {
    isInternalServiceRequest.mockReturnValue(false);
    const response = await POST(new NextRequest('http://localhost/api/workflow/webhook', {
      method: 'POST', body: JSON.stringify({
        type: 'INSERT', table: 'leads', record: { site_id: 'someone-elses-site' },
      }),
    }));
    expect(response.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('uses the singular event and forwards the deleted record snapshot', async () => {
    const subscriptionQuery = {
      select: jest.fn(),
      eq: jest.fn(),
      in: jest.fn(),
    };
    subscriptionQuery.select.mockReturnValue(subscriptionQuery);
    subscriptionQuery.eq
      .mockReturnValueOnce(subscriptionQuery)
      .mockResolvedValueOnce({
        data: [{
          id: 'subscription-1',
          endpoint_id: 'endpoint-1',
          event_type: 'deal.deleted',
          is_active: true,
        }],
        error: null,
      });
    subscriptionQuery.in.mockReturnValue(subscriptionQuery);
    from.mockReturnValue(subscriptionQuery);

    const oldRecord = {
      id: 'deal-1',
      site_id: 'site-1',
      name: 'Deleted deal',
    };
    const event_id = randomUUID();
    const response = await POST(new NextRequest(
      'http://localhost/api/workflow/webhook',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'DELETE',
          table: 'deals',
          schema: 'public',
          record: null,
          old_record: oldRecord,
          event_id,
        }),
      },
    ));

    expect(response.status).toBe(202);
    expect(subscriptionQuery.in).toHaveBeenCalledWith(
      'event_type',
      ['deal.deleted', 'deals.deleted'],
    );
    expect(fireWorkflowDispatch).toHaveBeenCalledWith({
      table: 'deals',
      op: 'delete',
      row: oldRecord,
      site_id: 'site-1',
      event_id,
    });
    expect(executeWorkflow).toHaveBeenCalledWith(
      'webhookDispatchWorkflow',
      expect.objectContaining({
        site_id: 'site-1',
        table: 'deals',
        object_id: 'deal-1',
        event_type: 'DELETE',
        event: 'deal.deleted',
        record: oldRecord,
        subscription_ids: ['subscription-1'],
      }),
      expect.any(Object),
    );
  });

  it.each(['INSERT', 'UPDATE', 'DELETE'])('preserves %s event identity on repeated ingress without subscriptions', async type => {
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(),
      then: resolve => Promise.resolve({ data: [], error: null }).then(resolve) };
    from.mockReturnValue(query);
    const row = { id: 'lead-1', site_id: 'site-1', updated_at: '2026-11-04T10:00:00Z' };
    const event_id = randomUUID();
    const body = { type, table: 'leads', schema: 'public', event_id,
      record: type === 'DELETE' ? null : row, old_record: type === 'INSERT' ? null : row };
    for (let i = 0; i < 2; i++) {
      const response = await POST(new NextRequest('https://example.invalid/api/workflow/webhook', {
        method: 'POST', body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
    }
    expect(fireWorkflowDispatch).toHaveBeenCalledTimes(2);
    expect(fireWorkflowDispatch.mock.calls[0][0]).toEqual({ table: 'leads', op: type.toLowerCase(), row, site_id: 'site-1', event_id });
    expect(fireWorkflowDispatch.mock.calls[1][0]).toEqual(fireWorkflowDispatch.mock.calls[0][0]);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('still rejects missing site_id before dispatching a DELETE snapshot', async () => {
    const response = await POST(new NextRequest('https://example.invalid/api/workflow/webhook', {
      method: 'POST', body: JSON.stringify({ type: 'DELETE', table: 'leads', record: null,
        old_record: { id: 'lead-1' }, event_id: randomUUID() }),
    }));
    expect(response.status).toBe(400);
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('keeps legacy webhook payloads compatible with deterministic dispatch fallback', async () => {
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(),
      then: resolve => Promise.resolve({ data: [], error: null }).then(resolve) };
    from.mockReturnValue(query);
    const row = { id: 'lead-1', site_id: 'site-1' };
    const response = await POST(new NextRequest('https://example.invalid/api/workflow/webhook', {
      method: 'POST', body: JSON.stringify({ type: 'INSERT', table: 'leads', schema: 'public', record: row, old_record: null }),
    }));
    expect(response.status).toBe(200);
    expect(fireWorkflowDispatch).toHaveBeenCalledWith({ table: 'leads', op: 'insert', row, site_id: 'site-1' });
  });
});
