import {
  createWorkflowToolExecutionTracker,
  instrumentWorkflowTools,
} from '../execution-tracker';

describe('workflow tool execution tracker', () => {
  test('records routed business calls without storing arguments or results', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const [tool] = instrumentWorkflowTools([
      {
        name: 'tools',
        execute: jest.fn().mockResolvedValue({
          success: true,
          secret: 'must-not-be-recorded',
        }),
      },
    ], tracker);

    await tool.execute({
      action: 'call',
      name: 'leads',
      args: {
        action: 'create',
        token: 'must-not-be-recorded',
      },
    });

    expect(tracker.snapshot()).toEqual([
      expect.objectContaining({
        id: 'exec_1',
        tool: 'leads',
        action: 'create',
        status: 'succeeded',
      }),
    ]);
    expect(JSON.stringify(tracker.snapshot())).not.toContain('must-not-be-recorded');
  });

  test('does not count discovery calls and records reported failures', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const [router, browser] = instrumentWorkflowTools([
      {
        name: 'tools',
        execute: jest.fn().mockResolvedValue({ tools: [] }),
      },
      {
        name: 'sandbox_browser',
        execute: jest.fn().mockResolvedValue({ ok: false, error: 'blocked' }),
      },
    ], tracker);

    await router.execute({ action: 'list' });
    await browser.execute({ action: 'open', url: 'https://example.com' });

    expect(tracker.snapshot()).toEqual([
      expect.objectContaining({
        tool: 'sandbox_browser',
        action: 'open',
        status: 'failed',
        failure_code: 'reported_not_ok',
      }),
    ]);
  });

  test('detects a failure returned inside the tools router envelope', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const [router] = instrumentWorkflowTools([{
      name: 'tools',
      execute: jest.fn().mockResolvedValue({
        success: true,
        result: { success: false, error: 'CRM rejected the write' },
      }),
    }], tracker);

    await router.execute({
      action: 'call',
      name: 'leads',
      args: { action: 'create' },
    });

    expect(tracker.snapshot()).toEqual([
      expect.objectContaining({
        tool: 'leads',
        action: 'create',
        status: 'failed',
        failure_code: 'nested_reported_unsuccessful',
      }),
    ]);
  });
});
