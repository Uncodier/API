import { randomUUID } from 'node:crypto';
import type { RequirementRun } from '../requirement-types';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.mock('../model', () => ({ createHarnessModel: jest.fn() }));
import { createRequirementModel } from '../requirement-model';
const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), sessionId: randomUUID(), runId: 'cycle', executionGeneration: 2 };
const input = () => ({ system: 'Agent', messages: [], tools: [], maxOutputTokens: 1000, signal: new AbortController().signal });
beforeEach(() => jest.resetAllMocks());

it('reserves paid work before dispatch and fails closed on insufficient credits', async () => {
  const respond = jest.fn(); rpc.mockResolvedValue({ data: { success: false }, error: null });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('billing_unavailable_or_exhausted');
  expect(respond).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('reserve_agent_requirement_credits', expect.objectContaining({ p_session_id: run.sessionId, p_generation: 2, p_amount: expect.any(Number) }));
});
it('checks ownership again after credit reservation so a pause prevents paid dispatch', async () => {
  const assertActive = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('paused'));
  const respond = jest.fn(); rpc.mockResolvedValue({ data: { success: true }, error: null });
  await expect(createRequirementModel(run, assertActive, { respond }).respond(input())).rejects.toThrow('paused');
  expect(respond).not.toHaveBeenCalled();
});
it.each([401, 402, 403])('marks provider admission %s as operator work rather than an endless product repair loop', async status => {
  rpc.mockResolvedValue({ data: { success: true }, error: null });
  const respond = jest.fn().mockRejectedValue({ status });
  await expect(createRequirementModel(run, async () => {}, { respond }).respond(input())).rejects.toThrow('provider_admission_requires_operator');
  expect(respond).toHaveBeenCalledTimes(1);
});