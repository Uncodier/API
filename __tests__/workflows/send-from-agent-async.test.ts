import { BusinessWorkflowService } from '@/lib/services/workflow/business-workflow-service';

describe('sendWhatsappFromAgent / sendEmailFromAgent async start', () => {
  const start = jest.fn();
  const execute = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    start.mockResolvedValue({
      workflowId: 'wf-started',
      firstExecutionRunId: 'run-started',
    });
    execute.mockResolvedValue({ success: true });

    jest.spyOn(BusinessWorkflowService.prototype as any, 'initializeClient').mockResolvedValue({
      workflow: { start, execute },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts WhatsApp workflow by default and does not execute', async () => {
    const service = BusinessWorkflowService.getInstance();
    const result = await service.sendWhatsappFromAgent({
      phone_number: '+15551234567',
      message: 'hello',
      site_id: 'site-1',
    });

    expect(start).toHaveBeenCalledWith(
      'sendWhatsappFromAgentWorkflow',
      expect.objectContaining({
        args: [expect.objectContaining({ phone_number: '+15551234567', site_id: 'site-1' })],
      })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      success: true,
      workflowId: 'wf-started',
      runId: 'run-started',
      status: 'running',
    }));
  });

  it('starts email workflow by default and does not execute', async () => {
    const service = BusinessWorkflowService.getInstance();
    const result = await service.sendEmailFromAgent({
      email: 'lead@example.com',
      subject: 'Hello',
      message: 'hello',
      site_id: 'site-1',
    });

    expect(start).toHaveBeenCalledWith(
      'sendEmailFromAgentWorkflow',
      expect.objectContaining({
        args: [expect.objectContaining({ email: 'lead@example.com', site_id: 'site-1' })],
      })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('running');
    expect(result.workflowId).toBe('wf-started');
  });

  it('uses execute when async is false', async () => {
    const service = BusinessWorkflowService.getInstance();
    const result = await service.sendWhatsappFromAgent(
      {
        phone_number: '+15551234567',
        message: 'hello',
        site_id: 'site-1',
      },
      { async: false, workflowId: 'wf-sync' }
    );

    expect(execute).toHaveBeenCalledWith(
      'sendWhatsappFromAgentWorkflow',
      expect.objectContaining({ workflowId: 'wf-sync' })
    );
    expect(start).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('returns success false without starting Temporal when phone is missing', async () => {
    const service = BusinessWorkflowService.getInstance();
    const result = await service.sendWhatsappFromAgent({
      phone_number: '',
      message: 'hello',
      site_id: 'site-1',
    } as any);

    expect(start).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
  });
});
