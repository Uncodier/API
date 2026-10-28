jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: { getInstance: jest.fn() } }));
jest.mock('composio-core', () => ({ OpenAIToolSet: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

import { executeTools } from '../../../agents/toolEvaluator/executor/executeTools';
import { getCustomToolDefinition } from '../../../agents/toolEvaluator/executor/customToolsMap';
import { fetchApiTool, fetchApiToolGet, ToolApiError } from '@/app/api/agents/tools/utils/fetch-helper';
import { POST } from '@/app/api/agents/tools/reservation_schedules/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NextRequest } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

const call = { id: 'call-1', name: 'scheduling', arguments: '{}', type: 'function', status: 'initialized' } as any;

describe('Customer Support tool contracts', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

  it.each(['scheduling', 'reservations', 'checkout', 'CONTACT_HUMAN'])('records %s operational failure and preserves recovery', async name => {
    const output = { success: false, error: 'Cannot confirm', recovery: { auto_retry: false, write_state: 'unknown' } };
    const results = await executeTools([{ ...call, name }], { [name]: async () => output });
    expect(results[0]).toMatchObject({ status: 'error', error: 'Cannot confirm', output });
  });

  it.each([false, 0, '', null, []])('preserves a valid falsy/empty result: %p', async output => {
    expect((await executeTools([call], { scheduling: async () => output }))[0].output).toEqual(output);
  });

  it('preserves structured errors thrown by transport or scheduling', async () => {
    const output = { success: false, reservation_id: 'reservation-1', recovery: { suggested_dates: ['2026-10-29'] } };
    const results = await executeTools([call], { scheduling: async () => { throw new ToolApiError('Invalid date', output, 400); } });
    expect(results[0]).toMatchObject({ status: 'error', error: 'Invalid date', output });
  });

  it('injects command scope into direct handlers without replacing an explicit site', async () => {
    const handler = jest.fn().mockResolvedValue({ success: true });
    await executeTools([call], { scheduling: handler }, { site_id: 'site-1', command_id: 'cmd-1' });
    expect(handler).toHaveBeenCalledWith({ site_id: 'site-1', command_id: 'cmd-1' });
    await executeTools([{ ...call, arguments: '{"site_id":"site-2"}' }], { scheduling: handler }, { site_id: 'site-1' });
    expect(handler).toHaveBeenLastCalledWith({ site_id: 'site-2' });
  });

  it.each(['POST', 'GET'])('retains recovery for %s HTTP errors and rejects HTTP-200 business failures', async method => {
    const output = { success: false, error: { message: 'Unavailable' }, catalog_item_id: 'item-1', reservation_id: 'reservation-1' };
    for (const status of [400, 200]) {
      global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(output), { status }));
      const request = method === 'POST' ? fetchApiTool('/tool', {}, 'Fallback') : fetchApiToolGet('/tool', 'Fallback');
      await expect(request).rejects.toMatchObject({ message: 'Unavailable', result: output, status });
    }
  });

  it('maps CONTACT_HUMAN intervention and delivery confirmation from the actual response envelope', () => {
    const response: any = { success: true, data: { intervention_id: 'intervention-1', status: 'pending', conversation_id: 'conversation-1', created_at: 'now', team_notification: { notifications_sent: 1 }, channel_response: { sent: true } } };
    const mapping = getCustomToolDefinition('CONTACT_HUMAN')!.responseMapping;
    const mapped = Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, path.split('.').reduce((value, part) => value?.[part], response)]));
    expect(mapped).toMatchObject({ success: true, intervention_id: 'intervention-1', status: 'pending', requested_at: 'now', conversation_id: 'conversation-1', team_notification: { notifications_sent: 1 }, channel_response: { sent: true } });
  });

  it.each(['list', 'get', 'delete', 'upsert'])('rejects reservation_schedules %s without a site before accessing the DB', async action => {
    const request = new NextRequest('https://api.example.invalid/tool', { method: 'POST', body: JSON.stringify({ action, id: 'schedule-1' }) });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('retains false Temporal tool data and clears the workflow timeout', async () => {
    jest.useFakeTimers();
    try {
      (WorkflowService.getInstance as jest.Mock).mockReturnValue({ executeWorkflow: jest.fn().mockResolvedValue({ success: true, data: false }) });
      const results = await executeTools([{ ...call, name: 'GET_TASKS' }], {});
      expect(results[0].output).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});