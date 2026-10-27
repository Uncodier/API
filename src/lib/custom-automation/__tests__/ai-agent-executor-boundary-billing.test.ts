import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { AssistantExecutionBoundaryError, type AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import { chargeOpenRouterUsage, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/billing/openrouter-usage-billing', () => ({
  ...jest.requireActual('@/lib/services/billing/openrouter-usage-billing'),
  chargeOpenRouterUsage: jest.fn().mockResolvedValue(undefined),
}));
const originalEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

function setup() {
  const events: string[] = [];
  const billing = {
    beforeDispatch: jest.fn(async () => { events.push('dispatch'); }),
    settle: jest.fn(async () => { events.push('settle'); }),
    failed: jest.fn(async () => { events.push('failed'); }),
  };
  const boundary: AssistantExecutionBoundary = {
    beforeModel: jest.fn(async () => { events.push('before'); }),
    onModelMessage: jest.fn(async () => { events.push('message'); }),
    executeTool: async (_call, execute) => execute(), afterTurn: async () => {}, billing,
  };
  const completion = { id: 'generation-offline', model: 'openai/example', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.01 },
    choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] };
  const create = jest.fn(async (_request: any) => { events.push('provider'); return completion; });
  const executor = new AIAgentExecutor({ siteId: 'test-site' });
  (executor as any).client.chat.completions.create = create;
  return { executor, boundary, billing, create, events, completion };
}

it('replaces rather than duplicates charging and reserves the full final payload once', async () => {
  const { executor, boundary, billing, create, events, completion } = setup();
  let expectedBytes = 0;
  create.mockImplementationOnce(async request => {
    expectedBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    events.push('provider'); return completion;
  });
  await executor.act({ system: 'Host instructions é', prompt: 'Run', tools: [{ name: 'lookup', description: 'Full tool schema', execute: jest.fn() }],
    executionBoundary: boundary, maxOutputTokens: 2048 });
  expect(events).toEqual(['before', 'dispatch', 'provider', 'settle', 'message']);
  const reservation = (billing.beforeDispatch.mock.calls as any)[0][0];
  expect(reservation).toEqual({ eventId: expect.any(String), inputBytes: expectedBytes, maxOutputTokens: 2048 });
  expect(billing.settle).toHaveBeenCalledWith({ eventId: reservation.eventId, usage: completion.usage,
    generationId: completion.id, model: completion.model });
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
  expect(billing.failed).not.toHaveBeenCalled();
});

it('retains default site billing for a boundary without a billing override', async () => {
  const { executor, boundary } = setup();
  delete boundary.billing;
  await executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary });
  expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
});

it('reserves only once across admission retries and settles the same event', async () => {
  const { executor, boundary, billing, create } = setup();
  create.mockRejectedValueOnce(Object.assign(new Error('can only afford 1000'), { status: 402 }));
  await executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary, maxOutputTokens: 2000 });
  expect(create).toHaveBeenCalledTimes(2);
  expect(boundary.beforeModel).toHaveBeenCalledTimes(2);
  expect(billing.beforeDispatch).toHaveBeenCalledTimes(1);
  expect(billing.settle).toHaveBeenCalledTimes(1);
  expect(billing.failed).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('reports uncertain provider failure once without default settlement', async () => {
  const { executor, boundary, billing, create } = setup();
  const error = Object.assign(new Error('socket timeout'), { generationId: 'uncertain-generation' });
  create.mockRejectedValueOnce(error);
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBe(error);
  const { eventId } = (billing.beforeDispatch.mock.calls as any)[0][0];
  expect(billing.failed).toHaveBeenCalledWith({ eventId, error, model: executor.getModel() });
  expect(billing.settle).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it.each(['beforeDispatch', 'settle', 'failed'] as const)('makes %s rejection fatal without tools or default charging', async hook => {
  const { executor, boundary, billing, create } = setup();
  billing[hook].mockRejectedValueOnce(new Error('socket timeout'));
  if (hook === 'failed') create.mockRejectedValueOnce(Object.assign(new Error('Rejected'), { status: 400 }));
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(create).toHaveBeenCalledTimes(hook === 'beforeDispatch' ? 0 : 1);
  expect(boundary.onModelMessage).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('preserves terminal billing error identity', async () => {
  const { executor, boundary, billing } = setup();
  const error = Object.assign(new Error('Billing reconciliation required'), { name: 'OpenRouterBillingError' });
  billing.settle.mockRejectedValueOnce(error);
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBe(error);
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('does not reserve, dispatch or settle when the first beforeModel rejects', async () => {
  const { executor, boundary, billing, create } = setup();
  boundary.beforeModel = async () => { throw new Error('Host denied execution'); };
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(create).not.toHaveBeenCalled();
  expect(billing.beforeDispatch).not.toHaveBeenCalled();
  expect(billing.failed).not.toHaveBeenCalled();
  expect(billing.settle).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('settles before tool effects and never attempts tools if settlement fails', async () => {
  const { executor, boundary, billing, create, completion } = setup();
  const execute = jest.fn().mockResolvedValue({ success: true });
  create.mockResolvedValue({ ...completion, choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
    id: 'bill-before-tool', type: 'function', function: { name: 'write', arguments: '{}' },
  }] }, finish_reason: 'tool_calls' }] } as any);
  billing.settle.mockRejectedValueOnce(new Error('Settlement unavailable'));
  await expect(executor.act({ prompt: 'Run', tools: [{ name: 'write', execute }], executionBoundary: boundary })).rejects.toBeInstanceOf(AssistantExecutionBoundaryError);
  expect(execute).not.toHaveBeenCalled();
  expect(billing.failed).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
});

it('preserves a retry-shaped terminal dispatch error without admission retry', async () => {
  const { executor, boundary, billing, create } = setup();
  const error = Object.assign(new Error('Unavailable reservation'), { name: 'OpenRouterBillingError', status: 503 });
  billing.beforeDispatch.mockRejectedValueOnce(error);
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBe(error);
  expect(billing.beforeDispatch).toHaveBeenCalledTimes(1);
  expect(billing.failed).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('preserves typed predispatch shortage without provider calls, settlement or replay', async () => {
  const { executor, boundary, billing, create } = setup();
  const error = new RequirementCreditsExhaustedError(0.4);
  billing.beforeDispatch.mockRejectedValueOnce(error);
  await expect(executor.act({ prompt: 'Run', tools: [], executionBoundary: boundary })).rejects.toBe(error);
  expect(billing.beforeDispatch).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
  expect(billing.failed).not.toHaveBeenCalled();
  expect(billing.settle).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});