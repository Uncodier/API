import { createWorkflowPlanResultCapture } from '../plan-result';
import { createWorkflowToolExecutionTracker } from '../execution-tracker';

describe('createWorkflowPlanResultCapture', () => {
  test('captures a completed structured result after every contract check passes', async () => {
    const capture = createWorkflowPlanResultCapture({
      type: 'task',
      expected_output: '{ opportunities: [] }',
      success_criteria: ['The target page was navigated.'],
      validation_rules: ['Every opportunity has a URL.'],
    });

    const response = await capture.tool.execute({
      status: 'completed',
      summary: 'Found one matching opportunity.',
      data: {
        opportunities: [{ url: 'https://example.com/job/1', value: '$500' }],
        total_opportunities: 1,
      },
      evidence: [
        {
          type: 'url',
          reference: 'https://example.com/job/1',
          verified: true,
        },
      ],
      criteria: [{ index: 1, passed: true, evidence: 'Page snapshot captured.' }],
      validation: [{ index: 1, passed: true, evidence: 'URL is present.' }],
    });

    expect(response).toMatchObject({
      accepted: true,
      terminal: true,
      status: 'completed',
    });
    expect(capture.getResult()).toMatchObject({
      status: 'completed',
      data: { total_opportunities: 1 },
      criteria: [{ index: 1, passed: true, evidence: 'Page snapshot captured.' }],
    });
    expect(capture.getResult()?.evidence[0].verified).toBeUndefined();
  });

  test('rejects completion when a declared check is missing or failed', async () => {
    const capture = createWorkflowPlanResultCapture({
      type: 'task',
      success_criteria: ['The target page was navigated.'],
      validation_rules: ['The result contains a URL.'],
    });

    const response = await capture.tool.execute({
      status: 'completed',
      summary: 'Done.',
      data: { opportunities: [] },
      evidence: [{ type: 'observation', reference: 'No results.' }],
      criteria: [{ index: 1, passed: true }],
      validation: [{ index: 1, passed: false }],
    });

    expect(response).toMatchObject({ accepted: false, terminal: false });
    expect(capture.getResult()).toBeNull();
  });

  test('rejects empty completed data when expected_output is defined', async () => {
    const capture = createWorkflowPlanResultCapture({
      type: 'task',
      expected_output: '{ opportunities: [] }',
    });

    await expect(capture.tool.execute({
      status: 'completed',
      summary: 'Done.',
      data: {},
      evidence: [],
      criteria: [],
      validation: [],
    })).resolves.toMatchObject({
      accepted: false,
      error: expect.stringContaining('data is empty'),
    });
  });

  test('captures a non-retryable failure without claiming success', async () => {
    const capture = createWorkflowPlanResultCapture({ type: 'task' });

    const response = await capture.tool.execute({
      status: 'failed',
      summary: 'The target rejected authentication.',
      data: {},
      evidence: [],
      criteria: [],
      validation: [],
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Login credentials are not configured.',
        retryable: false,
      },
    });

    expect(response).toMatchObject({
      accepted: true,
      terminal: true,
      status: 'failed',
    });
    expect(capture.getResult()?.error).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Login credentials are not configured.',
      retryable: false,
    });
  });

  test('allows skipped only for condition steps', async () => {
    const capture = createWorkflowPlanResultCapture({ type: 'task' });

    const response = await capture.tool.execute({
      status: 'skipped',
      summary: 'Condition did not match.',
      data: {},
      evidence: [],
      criteria: [],
      validation: [],
    });

    expect(response).toMatchObject({ accepted: false, terminal: false });
    expect(capture.getResult()).toBeNull();
  });

  test('requires real successful browser receipts before completion', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      { type: 'task' },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiresBrowser: true,
      },
    );
    const args = {
      status: 'completed',
      summary: 'Navigation completed.',
      data: { title: 'Jobs' },
      evidence: [],
      criteria: [],
      validation: [],
    };

    await expect(capture.tool.execute(args)).resolves.toMatchObject({
      accepted: false,
      error: expect.stringContaining('no substantive tool execution'),
    });
    await tracker.track(
      'sandbox_browser',
      { action: 'open' },
      async () => ({ ok: true }),
    );
    await tracker.track(
      'sandbox_browser',
      { action: 'snapshot' },
      async () => ({ ok: true }),
    );

    await expect(capture.tool.execute(args)).resolves.toMatchObject({
      accepted: true,
      status: 'completed',
    });
    expect(capture.getResult()?.executions).toEqual([
      expect.objectContaining({ tool: 'sandbox_browser', action: 'open', status: 'succeeded' }),
      expect.objectContaining({ tool: 'sandbox_browser', action: 'snapshot', status: 'succeeded' }),
    ]);
    expect(capture.getResult()?.evidence).toEqual([
      expect.objectContaining({ reference: 'exec_1', verified: true }),
      expect.objectContaining({ reference: 'exec_2', verified: true }),
    ]);
  });

  test('enforces declared MCP tool and action receipts', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      { type: 'task' },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiredToolExecutions: [{ tool: 'leads', action: 'create' }],
      },
    );
    await tracker.track('webSearch', {}, async () => ({ success: true }));

    await expect(capture.tool.execute({
      status: 'completed',
      summary: 'Done.',
      data: {},
      evidence: [],
      criteria: [],
      validation: [],
    })).resolves.toMatchObject({
      accepted: false,
      error: expect.stringContaining('leads:create'),
    });
  });

  test('does not complete after the latest substantive tool failed', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      { type: 'task' },
      { executionTracker: tracker, requireToolExecution: true },
    );
    await tracker.track('webSearch', {}, async () => ({ success: true }));
    await tracker.track('leads', { action: 'create' }, async () => ({
      success: false,
      error: 'write rejected',
    }));

    await expect(capture.tool.execute({
      status: 'completed',
      summary: 'Done.',
      data: { lead_id: 'claimed-id' },
      evidence: [],
      criteria: [],
      validation: [],
    })).resolves.toMatchObject({
      accepted: false,
      error: expect.stringContaining('latest tool execution'),
    });
  });
});
