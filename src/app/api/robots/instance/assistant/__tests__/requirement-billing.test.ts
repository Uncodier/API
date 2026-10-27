import { randomUUID } from 'node:crypto';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: any[]) => rpc(...args) } }));
import { createRequirementAssistantBilling } from '../requirement-billing';
import { OpenRouterBillingError, RequirementCreditsExhaustedError } from '@/lib/services/billing/openrouter-usage-billing';

function fixture() {
  const run = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    sessionId: randomUUID(), runId: randomUUID(), executionGeneration: 4 };
  const assertActive = jest.fn(async () => {});
  return { run, assertActive, billing: createRequirementAssistantBilling(run, assertActive), eventId: randomUUID() };
}
beforeEach(() => { jest.clearAllMocks(); rpc.mockResolvedValue({ data: { success: true, state: 'reserved' }, error: null }); });

test('reserves owned requirement credits before dispatch and settles actual cost once without generic site charge', async () => {
  const f = fixture();
  await f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 1000, maxOutputTokens: 4096 });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['reserve_agent_requirement_credits', 'dispatch_harness_model_reservation']);
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_requirement_id: f.run.requirementId,
    p_run_id: f.run.runId, p_generation: 4, p_session_id: f.run.sessionId, p_event_id: f.eventId });
  f.assertActive.mockRejectedValue(new Error('User paused after paid inference'));
  await f.billing.settle({ eventId: f.eventId, usage: { cost: 0.025 }, generationId: 'synthetic-generation', model: 'test/model' });
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: 0.025 }));
  expect(rpc.mock.calls.some(call => call[0] === 'bill_openrouter_generation')).toBe(false);
});

test('ledger transport retries keep event identity; a provider is never invoked by accounting', async () => {
  const f = fixture();
  rpc.mockRejectedValueOnce(new Error('Synthetic transport unavailable'));
  await f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 1024 });
  expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
});

test('rejected admission refunds, uncertain accepted cost stops', async () => {
  const f = fixture();
  await f.billing.failed({ eventId: f.eventId, error: { status: 403 } });
  expect(rpc).toHaveBeenLastCalledWith('cancel_harness_model_reservation', expect.objectContaining({ p_reason: 'admission_rejected' }));
  await expect(f.billing.failed({ eventId: f.eventId, error: new Error('Unknown transport result') }))
    .rejects.toMatchObject({ name: 'OpenRouterBillingError' });
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: null }));
});

test('lost ownership after reservation cancels before inference', async () => {
  const f = fixture();
  f.assertActive.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Owner changed'));
  await expect(f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 1024 })).rejects.toThrow('Owner changed');
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['reserve_agent_requirement_credits', 'cancel_harness_model_reservation']);
});

test('account credit rejection still prevents dispatch', async () => {
  const f = fixture();
  rpc.mockImplementation(async name => ({ data: name === 'reserve_agent_requirement_credits'
    ? { success: false, state: 'insufficient_credits' } : { success: true }, error: null }));
  await expect(f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 4096 }))
    .rejects.toMatchObject({ name: 'OpenRouterBillingError' });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['reserve_agent_requirement_credits', 'cancel_harness_model_reservation']);
});

test('only explicit reserve shortage is typed and stops before dispatch without retrying', async () => {
  const f = fixture();
  rpc.mockResolvedValueOnce({ data: { success: false, error: 'Insufficient credits' }, error: null });
  const error = await f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 4096 }).catch(error => error);
  expect(error).toBeInstanceOf(RequirementCreditsExhaustedError);
  expect(error).toBeInstanceOf(OpenRouterBillingError);
  expect(error.name).toBe('OpenRouterBillingError');
  expect(error.requiredCredits).toBe(rpc.mock.calls[0][1].p_amount);
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['reserve_agent_requirement_credits', 'cancel_harness_model_reservation']);
});

test.each([0, -1, NaN, Infinity])('invalid rejected reservation amount %s remains reconciliation', amount => {
  try {
    new RequirementCreditsExhaustedError(amount);
    throw new Error('Expected invalid admission evidence to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenRouterBillingError);
    expect(error).not.toBeInstanceOf(RequirementCreditsExhaustedError);
  }
});

test.each([
  { data: { success: false, error: 'insufficient credits' }, error: null },
  { data: { success: false, error: 'Insufficient credits ' }, error: null },
  { data: { success: false, state: 'insufficient_credits' }, error: null },
  { data: { error: 'Insufficient credits' }, error: null },
  { data: null, error: { message: 'Insufficient credits' } },
  { data: { success: false, error: 'Insufficient credits' }, error: { message: 'RPC unavailable' } },
  { data: null, error: null },
])('ambiguous reserve response stays reconciliation: %j', async response => {
  const f = fixture();
  rpc.mockResolvedValue(response);
  const error = await f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 4096 }).catch(error => error);
  expect(error).toBeInstanceOf(OpenRouterBillingError);
  expect(error).not.toBeInstanceOf(RequirementCreditsExhaustedError);
  expect(rpc.mock.calls.some(call => call[0] === 'dispatch_harness_model_reservation')).toBe(false);
});

test('thrown RPC shortage text is not proof of account exhaustion', async () => {
  const f = fixture();
  rpc.mockRejectedValue(new Error('Insufficient credits'));
  const error = await f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 4096 }).catch(error => error);
  expect(error).toBeInstanceOf(OpenRouterBillingError);
  expect(error).not.toBeInstanceOf(RequirementCreditsExhaustedError);
});

test.each(['dispatch_harness_model_reservation', 'settle_harness_model_reservation', 'cancel_harness_model_reservation'])(
  '%s shortage response is still reconciliation', async name => {
    const f = fixture();
    rpc.mockImplementation(async rpcName => ({ data: rpcName === name
      ? { success: false, error: 'Insufficient credits' } : { success: true, state: 'reserved' }, error: null }));
    const operation = name === 'dispatch_harness_model_reservation'
      ? f.billing.beforeDispatch({ eventId: f.eventId, inputBytes: 100, maxOutputTokens: 4096 })
      : name === 'settle_harness_model_reservation'
      ? f.billing.settle({ eventId: f.eventId, usage: { cost: 0.01 } })
      : f.billing.failed({ eventId: f.eventId, error: { status: 402 } });
    const error = await operation.catch(error => error);
    expect(error).toBeInstanceOf(OpenRouterBillingError);
    expect(error).not.toBeInstanceOf(RequirementCreditsExhaustedError);
  });