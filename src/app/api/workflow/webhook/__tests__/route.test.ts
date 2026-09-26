// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

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
});
