// @ts-nocheck -- ESM Jest mocks use dynamic imports under the repository's ES5 target.
import { jest } from '@jest/globals';

const from = jest.fn();
const rpc = jest.fn();
const loadBoundChannelMessageRun = jest.fn();
const validateCredits = jest.fn();
const deductCredits = jest.fn();
const chatCreate = jest.fn();
const clientOptions = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from, rpc } }));
jest.unstable_mockModule('../channel-message', () => ({ loadBoundChannelMessageRun }));
jest.unstable_mockModule('@/lib/services/skills-service', () => ({ SkillsService: { getSkillBySlugOrName: () => null } }));
jest.unstable_mockModule('@/lib/services/billing/CreditService', () => ({ CreditService: {
  validateCredits, deductCredits, PRICING: { ASSISTANT_INPUT_TOKEN_MILLION: 1, ASSISTANT_OUTPUT_TOKEN_MILLION: 20 },
} }));
jest.unstable_mockModule('openai', () => ({ default: class OpenAI {
  constructor(options) { clientOptions(options); }
  chat = { completions: { create: chatCreate } };
} }));
// Capture, result gate, retry helpers, and prompt rendering are real.
const { advanceBoundedChannelMessageRun: advance } = await import('../bounded-channel-execution');
const input = { siteId: '11111111-1111-4111-8111-111111111111',
  runPlanId: '22222222-2222-4222-8222-222222222222', messageId: 'message-1' };
const instanceId = '33333333-3333-4333-8333-333333333333';
const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
const accepted = { status: 'completed', summary: 'Use a concise reply', data: {}, evidence: [], criteria: [], validation: [] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const completion = (result = accepted) => ({ usage, choices: [{ message: { tool_calls: [{
  type: 'function', function: { name: 'plan_result', arguments: JSON.stringify(result) },
}] } }] });
let plan, run, activeToken, writes;
const envKeys = ['OPENAI_API_KEY', 'ROBOT_SDK_PROVIDER', 'AI_MODEL'];
let savedEnv;

beforeEach(() => {
  jest.resetAllMocks();
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.ROBOT_SDK_PROVIDER = 'openai';
  delete process.env.AI_MODEL;
  plan = { id: input.runPlanId, site_id: input.siteId, instance_id: instanceId, status: 'pending',
    metadata: { trigger_payload: { message: 'Hi', message_id: input.messageId } },
    steps: [{ id: 'step-1', order: 1, title: 'Analyze', instructions: 'Assess the message', status: 'pending' }] };
  run = { status: 'pending' };
  activeToken = null;
  writes = [];
  loadBoundChannelMessageRun.mockImplementation(async () => clone({ plan, run, trigger: { config: {} } }));
  from.mockImplementation((table) => {
    expect(table).toBe('instance_plans');
    return { update: (patch) => {
      const filters = {};
      const query = {
        eq: (key, value) => { filters[key] = value; return query; },
        select: () => query,
        maybeSingle: async () => {
          expect(filters.id).toBe(input.runPlanId);
          if (plan.status !== filters.status) return { data: null, error: null };
          writes.push(clone(patch));
          plan = { ...plan, ...clone(patch) };
          return { data: { id: plan.id }, error: null };
        },
      };
      return query;
    } };
  });
  rpc.mockImplementation(async (name, args) => {
    expect(args.p_run_plan_id).toBe(input.runPlanId);
    if (name === 'claim_workflow_run_execution') {
      expect(args.p_lease_seconds).toBe(240);
      if (activeToken || ['completed', 'failed'].includes(run.status)) return { data: { state: 'busy' } };
      activeToken = args.p_claim_token;
      run.status = 'in_progress';
      return { data: { state: 'claimed' } };
    }
    if (args.p_claim_token !== activeToken) return { data: false };
    if (name === 'renew_workflow_run_execution_claim') {
      expect(args.p_lease_seconds).toBe(240);
      return { data: true };
    }
    expect(name).toBe('finish_workflow_run_execution');
    activeToken = null;
    run.status = args.p_status;
    return { data: true };
  });
  validateCredits.mockResolvedValue(true);
  deductCredits.mockResolvedValue({ success: true });
  chatCreate.mockImplementation(async () => {
    expect(activeToken).not.toBeNull();
    expect(plan.steps.some((step) => step.status === 'in_progress')).toBe(true);
    return completion();
  });
});

afterEach(() => {
  jest.useRealTimers();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

it('fails without any provider invocation when credits are insufficient', async () => {
  validateCredits.mockResolvedValue(false);
  expect(await advance(input)).toBe('failed');
  expect(validateCredits).toHaveBeenCalledWith(input.siteId, 0.001);
  expect(clientOptions).not.toHaveBeenCalled();
  expect(chatCreate).not.toHaveBeenCalled();
  expect(deductCredits).not.toHaveBeenCalled();
  expect(plan.steps[0]).toMatchObject({ status: 'failed', retry_count: 1 });
  expect(await advance(input)).toBe('failed');
  expect(validateCredits).toHaveBeenCalledTimes(1);
});

it.each(['missing tool', 'malformed JSON', 'rejected capture'])(
  'charges usage before rejecting %s, with trusted run/step/attempt metadata', async (kind) => {
    const response = completion();
    if (kind === 'missing tool') response.choices[0].message.tool_calls = [];
    if (kind === 'malformed JSON') response.choices[0].message.tool_calls[0].function.arguments = '{';
    if (kind === 'rejected capture') {
      // The real capture refuses a completed result missing a declared criterion.
      plan.steps[0].success_criteria = ['Must supply a factual observation'];
    }
    chatCreate.mockResolvedValueOnce(response);
    expect(await advance(input)).toBe('in_progress');
    expect(plan.steps[0]).toMatchObject({ status: 'pending', retry_count: 1, completed_at: null });
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [siteId, amount, type, , metadata] = deductCredits.mock.calls[0];
    expect(siteId).toBe(input.siteId);
    expect(amount).toBeCloseTo(0.002, 10);
    expect(type).toBe('assistant_tokens');
    expect(metadata).toMatchObject({ site_id: input.siteId, instance_id: instanceId, plan_id: input.runPlanId,
      run_plan_id: input.runPlanId, step_id: 'step-1', message_id: input.messageId,
      attempt: 1, retry_count: 0, provider: 'openai', model: 'gpt-4o', tokens: 1050, input_tokens: 1000, output_tokens: 50 });
    expect(validateCredits.mock.invocationCallOrder[0]).toBeLessThan(chatCreate.mock.invocationCallOrder[0]);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  },
);

it('does not charge a completed cached run or step again on later advances', async () => {
  plan.steps.push({ id: 'step-2', order: 2, title: 'Summarize', status: 'pending' });
  expect(await advance(input)).toBe('in_progress');
  expect(plan.steps[0].status).toBe('completed');
  expect(await advance(input)).toBe('completed');
  expect(await advance(input)).toBe('completed');
  expect(chatCreate).toHaveBeenCalledTimes(2);
  expect(deductCredits).toHaveBeenCalledTimes(2);
  expect(deductCredits.mock.calls.map((call) => call[4].step_id)).toEqual(['step-1', 'step-2']);
  // Reconcile a crash between completed-plan persistence and releasing the claim.
  run.status = 'in_progress';
  expect(await advance(input)).toBe('completed');
  expect(deductCredits).toHaveBeenCalledTimes(2);
  expect(chatCreate).toHaveBeenCalledTimes(2);
});

it('persists a 503 retry and recovery instructions for the next separately claimed advance', async () => {
  plan.steps[0].recovery_plan = 'Re-evaluate {{trigger.message}} without external calls.';
  chatCreate.mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }));
  expect(await advance(input)).toBe('in_progress');
  expect(plan.steps[0]).toMatchObject({ status: 'pending', retry_count: 1 });
  expect(run.status).toBe('pending');
  expect(activeToken).toBeNull();
  expect(chatCreate).toHaveBeenCalledTimes(1);
  expect(deductCredits).not.toHaveBeenCalled();
  expect(await advance(input)).toBe('completed');
  expect(chatCreate).toHaveBeenCalledTimes(2);
  const [request, options] = chatCreate.mock.calls[1];
  expect(request.messages[0].content).toContain('PREVIOUS ATTEMPT FAILED');
  expect(request.messages[0].content).toContain('HTTP 503');
  expect(request.messages[0].content).toContain('Attempt: 2 of 2 (retry_count=1/2)');
  expect(request.messages[0].content).toContain('RECOVERY PLAN');
  expect(request.messages[0].content).toContain('Re-evaluate Hi without external calls.');
  expect(request.messages[1].content).toContain('This is retry 1');
  expect(request.tools.map((tool) => tool.function.name)).toEqual(['plan_result']);
  expect(options).toMatchObject({ timeout: 90_000, maxRetries: 0, signal: expect.any(AbortSignal) });
  expect(clientOptions).toHaveBeenCalledWith(expect.objectContaining({ timeout: 90_000, maxRetries: 0 }));
  expect(deductCredits.mock.calls[0][4]).toMatchObject({ attempt: 2, retry_count: 1 });
  const tokens = rpc.mock.calls.filter(([name]) => name === 'claim_workflow_run_execution').map(([, args]) => args.p_claim_token);
  expect(new Set(tokens).size).toBe(2);
});

it.each([0, 1, 2])('honors max_retries=%s with the existing failure-count semantics', async (maxRetries) => {
  plan.steps[0].max_retries = maxRetries;
  chatCreate.mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 503 }));
  const attempts = Math.max(1, maxRetries);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    expect(await advance(input)).toBe(attempt < attempts ? 'in_progress' : 'failed');
    expect(chatCreate).toHaveBeenCalledTimes(attempt);
    expect(plan.steps[0].retry_count).toBe(attempt);
  }
  expect(await advance(input)).toBe('failed');
  expect(chatCreate).toHaveBeenCalledTimes(attempts);
});

it('makes explicit result.error.retryable=false terminal, but still bills its tokens', async () => {
  chatCreate.mockResolvedValue(completion({ ...accepted, status: 'failed',
    error: { message: 'Cannot satisfy the policy', retryable: false } }));
  expect(await advance(input)).toBe('failed');
  expect(plan.steps[0]).toMatchObject({ status: 'failed', retry_count: 1,
    result: { error: { retryable: false } } });
  expect(await advance(input)).toBe('failed');
  expect(chatCreate).toHaveBeenCalledTimes(1);
  expect(deductCredits).toHaveBeenCalledTimes(1);
});

it('delays failure-branch routing until retries exhaust and preserves parent output', async () => {
  plan.steps[0].metadata = { node_id: 'parent' };
  plan.steps[0].recovery_plan = 'Use a simpler answer.';
  plan.steps.push({ id: 'on-success', order: 2, title: 'Success', status: 'pending',
    metadata: { node_id: 'success', parent_node_id: 'parent', relation_context: 'on success' } },
  { id: 'on-failure', order: 3, title: 'Failure', status: 'pending',
    metadata: { node_id: 'failure', parent_node_id: 'parent', relation_context: 'on fail' } });
  const failed = completion({ ...accepted, status: 'failed', summary: 'Need more context',
    data: { reason: 'missing context' }, error: { message: 'Try again', retryable: true } });
  chatCreate.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);
  expect(await advance(input)).toBe('in_progress');
  expect(plan.steps.map((step) => step.status)).toEqual(['pending', 'pending', 'pending']);
  expect(await advance(input)).toBe('in_progress');
  expect(plan.steps.map((step) => step.status)).toEqual(['failed', 'pending', 'pending']);
  expect(chatCreate.mock.calls[1][0].messages[0].content).toContain('Last output from the failed attempt');
  expect(chatCreate.mock.calls[1][0].messages[0].content).toContain('missing context');
  expect(await advance(input)).toBe('completed');
  expect(plan.steps.map((step) => step.status)).toEqual(['failed', 'cancelled', 'completed']);
  expect(chatCreate.mock.calls[2][0].messages[0].content).toContain('Incoming relation: on fail');
  expect(chatCreate.mock.calls[2][0].messages[0].content).toContain('Need more context');
  expect(deductCredits).toHaveBeenCalledTimes(3);
});

it('does not misidentify unrelated legacy steps as a failure handler', async () => {
  plan.steps[0].max_retries = 0;
  plan.steps.push({ id: 'unrelated', order: 2, status: 'pending', title: 'Unrelated' });
  chatCreate.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
  expect(await advance(input)).toBe('failed');
  expect(plan.steps[1].status).toBe('cancelled');
  expect(chatCreate).toHaveBeenCalledTimes(1);
});

it.each(['false', 'throw'])('does not retry a %s billing failure after provider usage', async (kind) => {
  if (kind === 'false') deductCredits.mockResolvedValue({ success: false, error: 'database error' });
  else deductCredits.mockRejectedValue(Object.assign(new Error('billing unavailable'), { status: 503 }));
  expect(await advance(input)).toBe('failed');
  expect(await advance(input)).toBe('failed');
  expect(chatCreate).toHaveBeenCalledTimes(1);
  expect(deductCredits).toHaveBeenCalledTimes(1);
  expect(plan.steps[0].error_message).toContain('billing requires reconciliation');
});

it('never retries a nonretryable provider 400 failure', async () => {
  chatCreate.mockRejectedValueOnce(Object.assign(new Error('Bad request'), { status: 400 }));
  expect(await advance(input)).toBe('failed');
  expect(await advance(input)).toBe('failed');
  expect(chatCreate).toHaveBeenCalledTimes(1);
});

it('does not replay or recharge an interrupted in_progress turn even when retries remain', async () => {
  plan.status = 'in_progress';
  plan.steps[0] = { ...plan.steps[0], status: 'in_progress', retry_count: 1, max_retries: 20 };
  run.status = 'in_progress';
  expect(await advance(input)).toBe('failed');
  expect(plan.steps[0].error_message).toContain('without a durable result');
  expect(chatCreate).not.toHaveBeenCalled();
  expect(deductCredits).not.toHaveBeenCalled();
  expect(validateCredits).not.toHaveBeenCalled();
});

it('aborts a 90s request and never schedules an unknown-outcome retry', async () => {
  jest.useFakeTimers();
  chatCreate.mockImplementation((request, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  const result = advance(input);
  await jest.advanceTimersByTimeAsync(90_000);
  expect(await result).toBe('failed');
  expect(chatCreate.mock.calls[0][1].signal.aborted).toBe(true);
  expect(await advance(input)).toBe('failed');
  expect(chatCreate).toHaveBeenCalledTimes(1);
  expect(deductCredits).not.toHaveBeenCalled();
});

it('refuses another advance while the existing turn owns its lease', async () => {
  let complete;
  chatCreate.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const first = advance(input);
  while (!complete) await new Promise((resolve) => setImmediate(resolve));
  expect(await advance(input)).toBe('already_running');
  expect(chatCreate).toHaveBeenCalledTimes(1);
  complete(completion());
  expect(await first).toBe('completed');
  expect(deductCredits).toHaveBeenCalledTimes(1);
});