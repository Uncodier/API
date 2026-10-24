import { randomUUID } from 'node:crypto';
import type { RequirementRun } from '../requirement-types';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.mock('./retired/model', () => ({ createHarnessModel: jest.fn() }));
import { createBilledHarnessModel, createRequirementModel } from './retired/requirement-model';
const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), sessionId: randomUUID(), runId: 'cycle', executionGeneration: 2 };
const input = () => ({ system: 'Agent', messages: [], tools: [], maxOutputTokens: 1000, signal: new AbortController().signal });
beforeEach(() => {
  jest.resetAllMocks();
  rpc.mockImplementation(async name => ({ data: { success: true, state: name.startsWith('reserve') ? 'reserved' : 'settled' }, error: null }));
});

it('reserves paid work before dispatch and fails closed on insufficient credits', async () => {
  const respond = jest.fn(); rpc.mockResolvedValue({ data: { success: false }, error: null });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('billing_unavailable_or_exhausted');
  expect(respond).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('reserve_agent_requirement_credits', expect.objectContaining({ p_session_id: run.sessionId, p_generation: 2, p_amount: expect.any(Number) }));
});
it('checks ownership again after credit reservation so a pause prevents paid dispatch', async () => {
  const assertActive = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('paused'));
  const respond = jest.fn();
  await expect(createRequirementModel(run, assertActive, { respond }).respond(input())).rejects.toThrow('paused');
  expect(respond).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith('cancel_harness_model_reservation', expect.objectContaining({ p_reason: 'predispatch' }));
});
it.each([401, 402, 403])('marks provider admission %s as operator work rather than an endless product repair loop', async status => {
  const respond = jest.fn().mockRejectedValue({ status });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('provider_admission_requires_operator');
  expect(respond).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenLastCalledWith('cancel_harness_model_reservation', expect.objectContaining({ p_reason: 'admission_rejected' }));
});

it.each([0, 0.000000009, 0.4])('settles authoritative usage.cost=%s without token-based charge', async cost => {
  const reply = { message: { role: 'assistant' as const, content: 'done' }, finishReason: 'stop' as const,
    usage: { inputTokens: 4, outputTokens: 1, cost }, generationId: 'synthetic-generation', model: 'test/model' };
  const respond = jest.fn(async () => {
    expect(rpc).toHaveBeenLastCalledWith('dispatch_harness_model_reservation', expect.any(Object));
    return reply;
  });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).resolves.toBe(reply);
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: cost,
    p_generation_id: reply.generationId, p_model: reply.model }));
});

it('settles accepted but malformed output with usage even when ownership paused after inference', async () => {
  const active = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('paused'));
  const error = Object.assign(new Error('Malformed choice'), { usage: { inputTokens: 1, outputTokens: 2, cost: 0.2 }, generationId: 'bad-choice', model: 'test/model' });
  await expect(createRequirementModel(run, active, { respond: jest.fn().mockRejectedValue(error) }).respond(input())).rejects.toBe(error);
  expect(active).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: 0.2, p_generation_id: 'bad-choice' }));
});

it.each([undefined, -1, NaN, Infinity, '0.2'])('keeps invalid/missing cost %s pending rather than estimating or refunding', async cost => {
  rpc.mockImplementation(async name => ({ data: { success: name !== 'settle_harness_model_reservation', state: 'reserved' }, error: null }));
  const respond = jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'work' }, finishReason: 'stop',
    usage: { inputTokens: 5000, outputTokens: 3000, cost }, generationId: 'unknown-cost' });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('reconciliation pending');
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: null, p_generation_id: 'unknown-cost' }));
  expect(rpc.mock.calls.some(([name]) => name === 'cancel_harness_model_reservation')).toBe(false);
});

it('keeps timeout outcomes pending and never retries inference', async () => {
  rpc.mockImplementation(async name => ({ data: { success: name !== 'settle_harness_model_reservation', state: 'reserved' }, error: null }));
  const respond = jest.fn().mockRejectedValue(new Error('Transport timeout'));
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('reconciliation pending');
  expect(respond).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: null }));
});

it('retries lost settlement/reserve responses with the same event without replaying provider', async () => {
  const counts: Record<string, number> = {};
  rpc.mockImplementation(async name => {
    counts[name] = (counts[name] || 0) + 1;
    if (counts[name] === 1 && (name.startsWith('reserve') || name.startsWith('settle'))) throw new Error('Response lost after commit');
    return { data: { success: true, state: name.startsWith('reserve') ? 'reserved' : 'settled' }, error: null };
  });
  const respond = jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, cost: 0 } });
  await createRequirementModel(run, async () => {}, { respond }).respond(input());
  const reserves = rpc.mock.calls.filter(([name]) => name.startsWith('reserve'));
  const settles = rpc.mock.calls.filter(([name]) => name.startsWith('settle'));
  expect(reserves[0]).toEqual(reserves[1]); expect(settles[0]).toEqual(settles[1]);
  expect(reserves[0][1].p_event_id).toBe(settles[0][1].p_event_id);
  expect(respond).toHaveBeenCalledTimes(1);
});

it('bills standalone generic harness with host-only session/site/owner and the same reserve flow', async () => {
  const owner = randomUUID();
  const respond = jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 1, cost: 0.005 } });
  await createBilledHarnessModel({ sessionId: run.sessionId, siteId: run.siteId, owner }, async () => {}, { respond }).respond(input());
  expect(rpc).toHaveBeenNthCalledWith(1, 'reserve_harness_model_credits', expect.objectContaining({ p_owner: owner, p_site_id: run.siteId, p_session_id: run.sessionId }));
  expect(rpc).toHaveBeenLastCalledWith('settle_harness_model_reservation', expect.objectContaining({ p_cost: 0.005 }));
});