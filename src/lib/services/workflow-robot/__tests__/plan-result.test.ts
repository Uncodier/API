import { createWorkflowPlanResultCapture } from '../plan-result';
import { createWorkflowToolExecutionTracker } from '../execution-tracker';

describe('createWorkflowPlanResultCapture', () => {
  test('only lets a task skip when its relation has a custom condition', async () => {
    const payload = { status: 'skipped', summary: 'Customer has not approved', data: {},
      evidence: [], criteria: [], validation: [] };
    const standard = createWorkflowPlanResultCapture({ type: 'task', metadata: { relation_context: 'on success' } });
    expect(await standard.tool.execute(payload)).toMatchObject({ accepted: false });
    const custom = createWorkflowPlanResultCapture({ type: 'task', metadata: { relation_context: 'when approved by customer' } });
    expect(await custom.tool.execute(payload)).toMatchObject({ accepted: true, status: 'skipped' });
  });

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

  test('rejects browser completion when instructed interaction never happened', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      {
        type: 'task',
        title: 'CRM opportunities',
        instructions:
          'Navega a Freelancer, selecciónar el filtro y devuelve las oportunidades.',
        expected_output:
          '{[{url:"url", summary:"opportunity", value:"bid range"}], total-opportuinies:x}',
      },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiresBrowser: true,
      },
    );
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
    await tracker.track(
      'sandbox_run_command',
      { command: 'curl' },
      async () => ({ exitCode: 0 }),
    );

    const response = await capture.tool.execute({
      status: 'completed',
      summary: 'Fetched opportunities through an API.',
      data: {
        opportunities: [{
          url: 'https://www.freelancer.com/projects/1',
          summary: 'Project',
          value: '$100',
        }],
        'total-opportuinies': 5671,
      },
      evidence: [],
      criteria: [],
      validation: [],
    });

    expect(response).toMatchObject({
      accepted: false,
      terminal: false,
      gate: {
        passed: false,
        signals: expect.arrayContaining([
          expect.objectContaining({
            name: 'browser-interaction',
            ok: false,
          }),
          expect.objectContaining({
            name: 'contract-normalized',
            ok: false,
            detail: expect.stringContaining('total_opportunities'),
          }),
          expect.objectContaining({
            name: 'output-shape',
            ok: false,
            detail: expect.stringContaining('data.total_opportunities'),
          }),
        ]),
      },
    });
    expect(capture.getResult()).toBeNull();
  });

  test('accepts an interaction followed by a fresh browser observation', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      {
        type: 'task',
        instructions:
          'Open Freelancer, select the project filter, and return the results.',
        expected_output:
          '{"opportunities":[{"url":"url","summary":"text","value":"range"}]}',
      },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiresBrowser: true,
      },
    );
    for (const action of ['open', 'snapshot', 'click', 'snapshot']) {
      await tracker.track(
        'sandbox_browser',
        { action },
        async () => ({ ok: true }),
      );
    }

    const response = await capture.tool.execute({
      status: 'completed',
      summary: 'Selected the filter and observed the resulting list.',
      data: {
        opportunities: [{
          url: 'https://www.freelancer.com/projects/1',
          summary: 'Project',
          value: '$100',
        }],
      },
      evidence: [],
      criteria: [],
      validation: [],
    });

    expect(response).toMatchObject({ accepted: true, terminal: true });
    expect(capture.getResult()?.gate).toMatchObject({
      passed: true,
      signals: expect.arrayContaining([
        expect.objectContaining({
          name: 'browser-post-interaction-observation',
          ok: true,
        }),
      ]),
    });
  });

  test('requires observation after the final browser interaction', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      {
        type: 'task',
        instructions: 'Select a filter and apply it.',
        expected_output: '{ results: [] }',
      },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiresBrowser: true,
      },
    );
    for (const action of ['open', 'snapshot', 'click', 'snapshot', 'click']) {
      await tracker.track(
        'sandbox_browser',
        { action },
        async () => ({ ok: true }),
      );
    }
    const args = {
      status: 'completed',
      summary: 'Applied the filter.',
      data: { results: [] },
      evidence: [],
      criteria: [],
      validation: [],
    };

    await expect(capture.tool.execute(args)).resolves.toMatchObject({
      accepted: false,
      gate: {
        signals: expect.arrayContaining([
          expect.objectContaining({
            name: 'browser-post-interaction-observation',
            ok: false,
          }),
        ]),
      },
    });

    await tracker.track(
      'sandbox_browser',
      { action: 'snapshot' },
      async () => ({ ok: true }),
    );
    await expect(capture.tool.execute(args)).resolves.toMatchObject({
      accepted: true,
    });
  });

  test('allows the contract to disable inferred browser interaction', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    const capture = createWorkflowPlanResultCapture(
      {
        type: 'task',
        instructions: 'Read the currently selected filter without changing it.',
        browser_interaction_required: false,
      },
      {
        executionTracker: tracker,
        requireToolExecution: true,
        requiresBrowser: true,
      },
    );
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

    await expect(capture.tool.execute({
      status: 'completed',
      summary: 'Read the current filter.',
      data: { filter: 'Current' },
      evidence: [],
      criteria: [],
      validation: [],
    })).resolves.toMatchObject({ accepted: true });
  });

  test('rejects structured output missing fields declared in expected_output', async () => {
    const capture = createWorkflowPlanResultCapture({
      type: 'task',
      expected_output:
        '{"opportunities":[{"url":"url","summary":"text","value":"range"}],"total_opportunities":0}',
    });

    const response = await capture.tool.execute({
      status: 'completed',
      summary: 'Returned incomplete data.',
      data: {
        opportunities: [{
          url: 'https://example.com/project',
          summary: 'Project',
          value: '$100',
        }, {
          url: 'https://example.com/project-2',
          summary: 'Incomplete project',
        }],
        total_opportunities: 2,
      },
      evidence: [],
      criteria: [],
      validation: [],
    });

    expect(response).toMatchObject({
      accepted: false,
      gate: {
        signals: expect.arrayContaining([
          expect.objectContaining({
            name: 'output-shape',
            ok: false,
            detail: expect.stringContaining('data.opportunities[1].value'),
          }),
        ]),
      },
    });
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
