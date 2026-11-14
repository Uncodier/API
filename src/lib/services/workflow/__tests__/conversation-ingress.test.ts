import { createHash } from 'node:crypto';
import type { Client } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/client';

const mockStart = jest.fn();
const mockExecute = jest.fn();
const mockSignalWithStart = jest.fn();
const mockDescribe = jest.fn();
const mockResult = jest.fn();
const mockGetHandle = jest.fn();
const mockClient = { workflow: {
  start: mockStart, execute: mockExecute, signalWithStart: mockSignalWithStart, getHandle: mockGetHandle,
} };
jest.mock('@/lib/services/workflow/base-workflow-service', () => ({
  BaseWorkflowService: class { async initializeClient() { return mockClient; } },
}));
jest.mock('@/lib/services/channels/outbound-media', () => ({ validateOutboundMedia: jest.fn() }));

import { BusinessWorkflowService } from '../business-workflow-service';
import { conversationIngressId, conversationMessageResult } from '../conversation-ingress';

const hash = (scope: string) => createHash('sha256').update(scope).digest('hex');
const supportArgs = { site_id: 'site', conversationId: 'conversation', message: 'Hello',
  agentId: 'agent', origin: 'website', origin_message_id: 'original', custom_data: { preserved: true } };
const whatsappArgs = { siteId: 'site', conversationId: 'conversation', phoneNumber: '+15551234567',
  messageContent: 'Hello', agentId: 'agent', businessAccountId: 'account', messageId: 'message' };

describe('durable conversation ingress API contract', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSignalWithStart.mockResolvedValue({ workflowId: 'coordinator', firstExecutionRunId: 'never-return-this' });
    mockStart.mockResolvedValue({ workflowId: 'message', firstExecutionRunId: 'direct-run' });
    mockExecute.mockResolvedValue({ reply: 'direct' });
    mockDescribe.mockResolvedValue({ runId: 'child-run' });
    mockResult.mockResolvedValue({ reply: 'child' });
    mockGetHandle.mockImplementation((_id: string, runId?: string) => runId
      ? { result: mockResult } : { describe: mockDescribe });
  });
  afterEach(() => { jest.useRealTimers(); });

  it('hashes raw conversation IDs, isolates sites, and shares scope across workflow types', async () => {
    const expectedId = `conversation-ingress-site-${hash('conversation')}`;
    expect(conversationIngressId({ siteId: 'site', conversationId: 'conversation' })).toBe(expectedId);
    expect(conversationIngressId({ siteId: 'other', conversationId: 'conversation' })).not.toBe(expectedId);
    const service = BusinessWorkflowService.getInstance();
    await service.customerSupportMessage(supportArgs, { workflowId: 'support', taskQueue: 'high' });
    await service.answerWhatsappMessage(whatsappArgs, { workflowId: 'whatsapp', taskQueue: 'high', async: true });
    expect(mockSignalWithStart.mock.calls.map(([, options]) => options.workflowId)).toEqual([expectedId, expectedId]);
  });

  it('submits unchanged support args/metadata and returns immediately without child or coordinator run IDs', async () => {
    const response = await BusinessWorkflowService.getInstance().customerSupportMessage(supportArgs,
      { workflowId: 'message', taskQueue: 'high', async: true });
    expect(mockSignalWithStart).toHaveBeenCalledWith('conversationIngressWorkflow', {
      workflowId: `conversation-ingress-site-${hash('conversation')}`, taskQueue: 'high', args: [],
      signal: 'submitConversationMessage', signalArgs: [{ workflowId: 'message',
        workflowType: 'customerSupportMessageWorkflow', taskQueue: 'high', args: [supportArgs,
          { origin: 'website', origin_message_id: 'original', agentId: 'agent' }] }],
    });
    expect(response).toEqual({ success: true, workflowId: 'message', status: 'running' });
    expect(mockGetHandle).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('preserves per-message workflow IDs on duplicate accepted submissions', async () => {
    const service = BusinessWorkflowService.getInstance();
    const options = { workflowId: 'stable-message', async: true };
    expect(await service.customerSupportMessage(supportArgs, options)).toEqual(
      await service.customerSupportMessage(supportArgs, options));
    expect(mockSignalWithStart).toHaveBeenCalledTimes(2);
    expect(mockSignalWithStart.mock.calls[1][1].signalArgs[0].workflowId).toBe('stable-message');
  });

  it.each(['support', 'whatsapp'])('sync %s waits for admission then returns the run-bound child result', async (kind) => {
    jest.useFakeTimers();
    mockDescribe.mockRejectedValueOnce(new WorkflowNotFoundError('Not started', 'message', undefined));
    const service = BusinessWorkflowService.getInstance();
    const responsePromise = kind === 'support'
      ? service.customerSupportMessage(supportArgs, { workflowId: 'message', async: false })
      : service.answerWhatsappMessage(whatsappArgs, { workflowId: 'message', async: false });
    await jest.advanceTimersByTimeAsync(250);
    expect(await responsePromise).toEqual({ success: true, workflowId: 'message', status: 'completed', data: { reply: 'child' } });
    expect(mockDescribe).toHaveBeenCalledTimes(2);
    expect(mockGetHandle).toHaveBeenLastCalledWith('message', 'child-run');
    expect(mockResult).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('preserves the WhatsApp synchronous default and its original argument array', async () => {
    const response = await BusinessWorkflowService.getInstance().answerWhatsappMessage(whatsappArgs, { workflowId: 'message' });
    expect(response.status).toBe('completed');
    expect(mockSignalWithStart.mock.calls[0][1].signalArgs[0]).toEqual({
      workflowId: 'message', workflowType: 'whatsappMessageWorkflow', args: [whatsappArgs], taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
    });
  });

  it('uses only complete trusted Zavu tuple scope when conversation ID is absent', async () => {
    const custom_data = { source: 'zavu_inbound_message', channel: 'whatsapp', connection_id: 'connection',
      zavu_sender_id: 'sender', zavu_from: 'raw-recipient' };
    const input = { siteId: 'site', origin: 'whatsapp', channel_delivery: true, custom_data };
    const expectedId = `conversation-ingress-site-${hash(JSON.stringify(['zavu', 'whatsapp', 'connection', 'sender', 'raw-recipient']))}`;
    expect(conversationIngressId(input)).toBe(expectedId);
    expect(conversationIngressId({ ...input, conversationId: 'conversation' })).toBe(expectedId);
    expect(conversationIngressId({ ...input, custom_data: { ...custom_data, connection_id: 'other' } })).not.toBe(expectedId);
    for (const field of ['channel', 'connection_id', 'zavu_sender_id', 'zavu_from', 'source']) {
      expect(conversationIngressId({ ...input, custom_data: { ...custom_data, [field]: undefined } })).toBeUndefined();
    }
    expect(conversationIngressId({ ...input, channel_delivery: false })).toBeUndefined();
    expect(conversationIngressId({ ...input, origin: 'website' })).toBeUndefined();
    await BusinessWorkflowService.getInstance().customerSupportMessage({ message: 'Hello', site_id: 'site',
      origin: 'whatsapp', channel_delivery: true, custom_data }, { async: true });
    expect(mockSignalWithStart.mock.calls[0][1].workflowId).toBe(expectedId);
  });

  it('falls back to existing direct execution/start if site or conversation scope is absent', async () => {
    const service = BusinessWorkflowService.getInstance();
    expect(await service.customerSupportMessage({ message: 'Hello', site_id: 'site' }, { workflowId: 'message' }))
      .toEqual({ success: true, workflowId: 'message', runId: 'direct-run', executionId: 'direct-run', status: 'running' });
    await service.customerSupportMessage({ ...supportArgs, site_id: undefined, visitor_id: 'visitor' }, { async: false });
    expect(mockExecute).toHaveBeenCalledWith('customerSupportMessageWorkflow', expect.any(Object));
    await service.answerWhatsappMessage({ ...whatsappArgs, conversationId: null });
    expect(mockExecute).toHaveBeenCalledWith('whatsappMessageWorkflow', expect.objectContaining({ args: [{ ...whatsappArgs, conversationId: null }] }));
    expect(mockSignalWithStart).not.toHaveBeenCalled();
  });

  it('does not report failed signal acceptance as success', async () => {
    mockSignalWithStart.mockRejectedValue(new Error('Temporal unavailable'));
    const response = await BusinessWorkflowService.getInstance().customerSupportMessage(supportArgs);
    expect(response).toEqual({ success: false, error: { code: 'WORKFLOW_EXECUTION_ERROR', message: 'Temporal unavailable' } });
    expect(mockGetHandle).not.toHaveBeenCalled();
  });

  it('propagates describe and child-result errors without re-submission', async () => {
    mockDescribe.mockRejectedValueOnce(new Error('Describe failed'));
    expect((await BusinessWorkflowService.getInstance().customerSupportMessage(supportArgs, { async: false })).success).toBe(false);
    mockResult.mockRejectedValueOnce(new Error('Child failed'));
    const response = await BusinessWorkflowService.getInstance().answerWhatsappMessage(whatsappArgs);
    expect(response.error?.message).toBe('Child failed');
    expect(mockSignalWithStart).toHaveBeenCalledTimes(2);
  });

  it('bounds the admission wait without cancelling the accepted child', async () => {
    jest.useFakeTimers();
    mockDescribe.mockRejectedValue(new WorkflowNotFoundError('Not started', 'message', undefined));
    const pending = conversationMessageResult(mockClient as unknown as Client, 'message');
    const assertion = expect(pending).rejects.toThrow('The accepted message has not been cancelled');
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    await assertion;
    expect(mockResult).not.toHaveBeenCalled();
  });
});