import { NextRequest } from 'next/server';
import { POST } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService } from '@/lib/services/workflow-service';
import { fireWorkflowDispatch } from '@/lib/services/workflow-robot/dispatch';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));
jest.mock('@/lib/services/workflow-service', () => ({
  WorkflowService: {
    getInstance: jest.fn(),
  },
}));
jest.mock('@/lib/services/workflow-robot/dispatch', () => ({
  fireWorkflowDispatch: jest.fn(),
}));

describe('POST /api/workflow/webhook', () => {
  const executeWorkflow = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    executeWorkflow.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      runId: 'run-1',
    });
    (WorkflowService.getInstance as jest.Mock).mockReturnValue({ executeWorkflow });
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
    (supabaseAdmin.from as jest.Mock).mockReturnValue(subscriptionQuery);

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
