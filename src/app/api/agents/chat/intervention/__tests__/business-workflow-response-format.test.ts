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

  it('requires a phone unless the routed worker can resolve a saved WhatsApp text from its IDs', async () => {
    const prior = process.env.WHATSAPP_ROUTED_TEXT_WORKER_READY;
    const args = { site_id: 'site', message: 'Hello', conversation_id: 'chat', message_id: 'saved' };
    const service = BusinessWorkflowService.getInstance();
    try {
      delete process.env.WHATSAPP_ROUTED_TEXT_WORKER_READY;
      expect((await service.sendWhatsappFromAgent(args)).success).toBe(false);
      process.env.WHATSAPP_ROUTED_TEXT_WORKER_READY = 'true';
      expect((await service.sendWhatsappFromAgent({ ...args, response_format: 'audio' })).success).toBe(false);
      expect((await service.sendWhatsappFromAgent({ ...args, message_id: undefined })).success).toBe(false);
      expect((await service.sendWhatsappFromAgent(args)).success).toBe(true);
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockStart.mock.calls[0][1].args[0]).not.toHaveProperty('phone_number');
    } finally {
      if (prior === undefined) delete process.env.WHATSAPP_ROUTED_TEXT_WORKER_READY;
      else process.env.WHATSAPP_ROUTED_TEXT_WORKER_READY = prior;
    }
  });
});