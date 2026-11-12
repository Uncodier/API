const from = jest.fn();
const pin = jest.fn();
const getPin = jest.fn();
const admit = jest.fn();
const events: string[] = [];
const site = 'site';
const ref = { payer: 'customer', siteId: site, connectionId: 'connection', policyVersion: 1, credentialVersion: 2 };
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.mock('@/lib/services/workflow-robot/plan-routing', () => ({ pinPlanRouting: pin, getPlanRouting: getPin }));
jest.mock('@/app/api/robots/instance/assistant/execution-routing', () => ({ admitAssistantRouting: admit }));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({ completeInProgressPlans: async () => ({ success: true, completedCount: 0 }), replacePlan: async () => {} }));
jest.mock('@/lib/helpers/robot-planning-core', () => ({ formatPlanSteps: () => [], addSessionSaveSteps: () => [], calculateEstimatedDuration: () => 1 }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {} }));
import { createNewPlanForInstance } from '@/lib/services/robot-plan-execution/plan-manager';
import { addActivityToPlan } from '@/lib/services/robot-instance/robot-plan-service';
import { saveCompletePlan } from '@/app/api/robots/instance/act/save-plan';
beforeEach(() => {
  jest.clearAllMocks(); events.length = 0;
  getPin.mockResolvedValue(ref); admit.mockResolvedValue(ref);
  pin.mockImplementation(async () => { events.push('pin'); });
  from.mockImplementation((table: string) => {
    let inserting = false;
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      insert: (data: any) => { inserting = true; events.push(`insert:${data.status}`); return q; },
      update: (data: any) => { events.push(`update:${data.status ?? 'steps'}`); return q; },
      single: async () => ({ data: table === 'remote_instances' ? { site_id: site, user_id: 'user' }
        : inserting ? { id: 'new-plan', steps: [], site_id: site } : null, error: null }),
      then: (resolve: any) => resolve({ error: null }),
    }; return q;
  });
});
const writers = [
  ['replacement', () => createNewPlanForInstance('instance', 'parent', { steps: [] }, { site_id: site })],
  ['activity', () => addActivityToPlan('instance', 'task', 'answer', { site_id: site }, 'pending')],
  ['act', () => saveCompletePlan('instance', {}, null, 'task', 'create')],
] as const;
it.each(writers)('%s pins before publishing runnable state', async (_name, run) => {
  await run();
  expect(events[0]).toBe('insert:blocked');
  expect(events[1]).toBe('pin');
  expect(events.slice(2).some(event => /update:(active|pending|in_progress)/.test(event))).toBe(true);
  expect(pin).toHaveBeenCalledWith('new-plan', site, ref);
});
it.each(writers)('%s stays blocked on private pin failure', async (_name, run) => {
  pin.mockRejectedValueOnce(new Error('offline'));
  await run();
  expect(events).toEqual(['insert:blocked']);
});
it('replacement inherits immutable parent routing, never current selection', async () => {
  await writers[0][1]();
  expect(getPin).toHaveBeenCalledWith('parent', site);
  expect(admit).not.toHaveBeenCalled();
});