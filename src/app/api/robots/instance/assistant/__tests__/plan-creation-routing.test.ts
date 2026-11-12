import { randomUUID } from 'node:crypto';
const mockPin = jest.fn();
const mockAdmit = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const siteId = randomUUID();
const instanceId = randomUUID();
const planId = randomUUID();
jest.mock('@/app/api/robots/instance/assistant/execution-routing', () => ({ admitAssistantRouting: (...args: unknown[]) => mockAdmit(...args) }));
jest.mock('@/lib/services/workflow-robot/plan-routing', () => ({ pinPlanRouting: (...args: unknown[]) => mockPin(...args) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (table: string) => {
  const query: any = { select: () => query, eq: () => query,
    single: async () => ({ data: table === 'remote_instances' ? { site_id: siteId } : { id: planId, instance_id: instanceId } }),
    insert: (data: unknown) => { mockInsert(data); return query; },
    update: (data: unknown) => { mockUpdate(data); return { eq: async () => ({ error: null }) }; } };
  return query;
} } }));
jest.mock('@/lib/services/requirement-backlog', () => ({ resolveBacklogContextForInstance: async () => ({ requirementId: null }) }));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({ completeInProgressPlans: async () => ({ errors: [] }) }));
jest.mock('@/app/api/agents/tools/instance_plan/requirement-plan-lock', () => ({
  assertRequirementPlanUpdateAllowed: async () => {}, shouldProtectRequirementPlanCreation: () => false,
}));
import { createInstancePlanCore } from '@/app/api/agents/tools/instance_plan/create/core';

const routing = { payer: 'customer', siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const input = { instance_id: instanceId, site_id: siteId, user_id: randomUUID(), title: 'Delegated work', steps: [] };
beforeEach(() => { jest.clearAllMocks(); mockAdmit.mockResolvedValue(routing); mockPin.mockResolvedValue(undefined); });

it('pins host routing before a delegated customer plan becomes runnable, ignoring request flags', async () => {
  await createInstancePlanCore({ ...input, executionRouting: { payer: 'platform', siteId } });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  expect(mockPin).toHaveBeenCalledWith(planId, siteId, routing);
  expect(mockPin.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
  expect(mockUpdate).toHaveBeenCalledWith({ status: 'pending' });
});

it('leaves a plan non-runnable if durable routing publication fails', async () => {
  mockPin.mockRejectedValue(new Error('routing publication failed'));
  await expect(createInstancePlanCore(input)).rejects.toThrow('routing publication failed');
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  expect(mockUpdate).not.toHaveBeenCalled();
});