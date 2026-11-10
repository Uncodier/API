const mockStart = jest.fn();
const mockExecute = jest.fn();
jest.mock('@/lib/services/workflow/base-workflow-service', () => ({
  BaseWorkflowService: class {
    async initializeClient() { return { workflow: { start: mockStart, execute: mockExecute } }; }
  },
}));
import { BusinessWorkflowService } from '@/lib/services/workflow/business-workflow-service';

describe('Intervention business workflow response format contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStart.mockResolvedValue({ workflowId: 'workflow', firstExecutionRunId: 'run' });
    mockExecute.mockResolvedValue({ success: true });
  });

  it.each([
    ['whatsapp', true], ['telegram', true], ['messenger', true],
    ['whatsapp', false], ['telegram', false], ['messenger', false],
  ] as const)('passes audio intact to %s (async=%s)', async (channel, async) => {
    const service = BusinessWorkflowService.getInstance();
    const args = { message: 'Hello', site_id: 'site', response_format: 'audio' as const,
      message_id: 'message', conversation_id: 'conversation' };
    const response = channel === 'whatsapp'
      ? await service.sendWhatsappFromAgent({ ...args, phone_number: '+15551234567' }, { async })
      : await service.sendChannelMessageFromAgent({ ...args, channel, to: 'recipient' }, { async });
    expect(response.success).toBe(true);
    expect(async ? mockStart : mockExecute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      args: [expect.objectContaining(args)],
    }));
  });

  it.each([undefined, 'text'] as const)('keeps legacy omission and explicit text distinct (%s)', async (format) => {
    await BusinessWorkflowService.getInstance().sendWhatsappFromAgent({ phone_number: '+15551234567',
      message: 'Hello', site_id: 'site', ...(format ? { response_format: format } : {}) });
    const args = mockStart.mock.calls[0][1].args[0];
    if (format) expect(args.response_format).toBe(format);
    else expect(args).not.toHaveProperty('response_format');
  });

  it('rejects audio on unsupported workflow channels before Temporal starts', async () => {
    const response = await BusinessWorkflowService.getInstance().sendChannelMessageFromAgent({ channel: 'email',
      to: 'recipient', message: 'Hello', site_id: 'site', response_format: 'audio' });
    expect(response.success).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});