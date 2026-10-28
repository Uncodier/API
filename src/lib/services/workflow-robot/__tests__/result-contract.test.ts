import { assessWorkflowResult } from '../result-gate';
import { createWorkflowPlanResultCapture } from '../plan-result';
import { readWorkflowResultContractVersion } from '../result-contract';
import { createWorkflowToolExecutionTracker } from '../execution-tracker';

const completed = {
  status: 'completed', summary: 'Analyzed the supplied records.', data: { total: 3 },
  evidence: [{ type: 'observation', reference: 'Three records in the supplied input.' }],
  criteria: [], validation: [],
};

describe('versioned workflow result contracts', () => {
  it('keeps old snapshots legacy and refuses unknown future contracts', () => {
    expect(readWorkflowResultContractVersion(undefined)).toBe(1);
    expect(readWorkflowResultContractVersion({})).toBe(1);
    expect(readWorkflowResultContractVersion({ result_contract_version: 2 })).toBe(2);
    for (const version of [null, '2', 3, false]) {
      expect(() => readWorkflowResultContractVersion({ result_contract_version: version })).toThrow('Unsupported');
    }
  });

  it('accepts supplied-context work without fabricating a successful tool execution', async () => {
    const capture = createWorkflowPlanResultCapture({ expected_output: '{ total: 0 }' }, {
      resultContractVersion: 2, requireToolExecution: true,
    });
    expect(await capture.tool.execute(completed)).toMatchObject({ accepted: true, terminal: true });
    expect(capture.getResult()).toMatchObject({ gate: { passed: true }, observations: [
      expect.objectContaining({ name: 'tool-execution', ok: false, severity: 'warning' }),
    ] });
    expect(capture.getResult()!.gate!.signals.some(signal => signal.name === 'tool-execution')).toBe(false);
  });

  it('does not rewrite the completion rules of a legacy run', async () => {
    const capture = createWorkflowPlanResultCapture({}, { requireToolExecution: true });
    expect(await capture.tool.execute(completed)).toMatchObject({ accepted: false });
    expect(capture.getResult()).toBeNull();
  });

  it('does not let a failed optional final tool veto a valid result', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    await tracker.track('optional_probe', {}, async () => ({ success: false, error: 'Probe unavailable' }));
    const capture = createWorkflowPlanResultCapture({}, { resultContractVersion: 2, executionTracker: tracker });
    expect(await capture.tool.execute(completed)).toMatchObject({ accepted: true });
    expect(capture.getResult()?.gate?.passed).toBe(true);
    expect(capture.getResult()?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'latest-execution', ok: false, severity: 'warning' }),
    ]));
  });

  it('treats inferred browser choreography as advice, not an execution permission', async () => {
    const capture = createWorkflowPlanResultCapture({}, { resultContractVersion: 2, requiresBrowser: true });
    expect(await capture.tool.execute(completed)).toMatchObject({ accepted: true });
    expect(capture.getResult()!.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'browser-navigation', ok: false, severity: 'warning' }),
    ]));
  });

  it('does not infer required clicks from prose when an explicit browser requirement was fulfilled', async () => {
    const tracker = createWorkflowToolExecutionTracker();
    for (const action of ['open', 'snapshot']) await tracker.track('sandbox_browser', { action }, async () => ({ ok: true }));
    const capture = createWorkflowPlanResultCapture({ instructions: 'Select the relevant facts from the page.', metadata: { requires_browser: true } }, {
      resultContractVersion: 2, requiresBrowser: true, executionTracker: tracker,
    });
    expect(await capture.tool.execute(completed)).toMatchObject({ accepted: true });
    expect(capture.getResult()?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'browser-interaction', ok: false, severity: 'warning' }),
    ]));
  });

  it.each([
    [{ expected_output: '{ total: 0 }' }, { ...completed, data: { total: 'wrong' } }, {}],
    [{ success_criteria: ['Total was checked.'] }, completed, {}],
    [{ metadata: { requires_browser: true } }, completed, {}],
    [{}, completed, { requiredToolExecutions: [{ tool: 'sendEmail' }] }],
  ])('preserves declared outputs, criteria, browser and actions: %j', async (step, payload, options) => {
    const capture = createWorkflowPlanResultCapture(step, { ...options, resultContractVersion: 2 });
    expect(await capture.tool.execute(payload)).toMatchObject({ accepted: false, terminal: false });
    expect(capture.getResult()).toBeNull();
    expect(await capture.tool.execute({ ...completed, status: 'failed', error: {
      message: 'The declared requirement was not completed.', retryable: false,
    } })).toMatchObject({ accepted: true, terminal: true, status: 'failed' });
  });

  it('returns pure observations with no state callbacks and does not mutate its inputs', () => {
    const input = { step: {}, data: completed.data, executions: [], requireToolExecution: true };
    const before = JSON.stringify(input);
    const result = assessWorkflowResult(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.contract.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['contract', 'observations']);
    expect(Object.values(result.observations[0]).some(value => typeof value === 'function')).toBe(false);
  });
});