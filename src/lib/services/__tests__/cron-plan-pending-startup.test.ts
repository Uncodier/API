import { getPlanExecutionGateStep, selectPlanStepsForExecution } from '@/app/api/cron/shared/cron-execute-steps-phase-helpers';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import { emptyBacklog, type BacklogItem } from '../requirement-backlog-types';
import { BacklogWriteConflictError } from '../requirement-backlog-store';

jest.mock('@vercel/sandbox', () => ({}));
jest.mock('workflow', () => ({}));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({ cancelPlanStepsForBacklogItem: jest.fn() }));
jest.mock('../instance-plan-infrastructure-state', () => ({
  InfrastructureStateDatabaseError: class extends Error {},
  updatePlanStepStatusAtomically: jest.fn(),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn(),
  },
}));
jest.mock('../requirement-backlog-store', () => {
  const actual = jest.requireActual('../requirement-backlog-store');
  return { ...actual, loadRequirement: jest.fn(), writeBacklogCas: jest.fn() };
});

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadRequirement, writeBacklogCas } from '../requirement-backlog-store';

const read = (supabaseAdmin as unknown as { maybeSingle: jest.Mock }).maybeSingle;
const load = loadRequirement as jest.Mock;
const write = writeBacklogCas as jest.Mock;
const cancel = cancelPlanStepsForBacklogItem as jest.Mock;
let requirement: any;
let plan: any;

function item(id = 'item-1', patch: Partial<BacklogItem> = {}): BacklogItem {
  return { id, title: id, kind: 'doc', phase_id: 'base', acceptance: ['Document exists'],
    status: 'pending', attempts: 0, scope_level: 'full', ...patch };
}

function prepare(items = [item(), item('item-2')]) {
  requirement = { id: 'requirement-1', status: 'in-progress', type: 'develop', metadata: {},
    backlog_revision: 1, backlog: { ...emptyBacklog('base'), items } };
  plan = { status: 'in_progress', metadata: { requirement_id: requirement.id },
    steps: [1, 2, 3, 4, 5].map(order => ({ id: `step_${order}`, order, status: 'pending',
      metadata: { backlog_item_id: 'item-1' } })) };
  read.mockImplementation(async () => ({ data: structuredClone(plan) }));
  // The gate loads the backlog separately from the plan.
  (supabaseAdmin.from as unknown as jest.Mock).mockImplementation((table: string) => {
    read.mockImplementation(async () => ({ data: structuredClone(table === 'instance_plans' ? plan : requirement) }));
    return supabaseAdmin;
  });
  load.mockImplementation(async () => structuredClone(requirement));
  write.mockImplementation(async (_id, backlog, revision) => {
    if (revision !== requirement.backlog_revision) throw new BacklogWriteConflictError(requirement.id);
    requirement.backlog = structuredClone(backlog);
    return ++requirement.backlog_revision;
  });
}

const gate = () => getPlanExecutionGateStep('plan-1', 'step_1', 'requirement-1');

describe('executor admission of an all-pending plan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    write.mockReset();
    cancel.mockResolvedValue({ errors: [] });
    prepare();
  });

  it('starts the bound item when all five steps and every backlog item are pending', async () => {
    expect(selectPlanStepsForExecution(plan.steps)[0].id).toBe('step_1');
    await expect(gate()).resolves.toMatchObject({ runnable: true });
    expect(requirement.backlog.items.map((entry: BacklogItem) => entry.status)).toEqual(['in_progress', 'pending']);
    expect(requirement.backlog.items[0].attempts).toBe(0);
    expect(plan.steps.every((step: any) => step.status === 'pending')).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    await expect(gate()).resolves.toMatchObject({ runnable: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('admits a legacy plan using the explicit requirement context', async () => {
    plan.metadata = {};
    plan.status = 'pending';
    await expect(gate()).resolves.toEqual({ runnable: true, dbStatus: 'pending' });
    expect(requirement.backlog.items[0].status).toBe('in_progress');
  });

  it('selects the bound item, not an unrelated item earlier in backlog order', async () => {
    prepare([item('item-2'), item()]);
    await expect(gate()).resolves.toMatchObject({ runnable: true });
    expect(requirement.backlog.items.map((entry: BacklogItem) => entry.status)).toEqual(['pending', 'in_progress']);
  });

  it.each(['in_progress', 'critic_review', 'judge_review'] as const)('waits intact while another item is %s', async status => {
    requirement.backlog.items[1].status = status;
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['pending', 'missing'])('waits intact for a %s dependency', async dependency => {
    requirement.backlog.items[0].depends_on = [dependency === 'pending' ? 'item-2' : 'missing'];
    await expect(gate()).resolves.toMatchObject({ runnable: false, reason: 'backlog_item_blocked' });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('admits after dependencies are done without spending an attempt', async () => {
    requirement.backlog.items[0].depends_on = ['item-2'];
    requirement.backlog.items[0].attempts = 1;
    requirement.backlog.items[1].status = 'done';
    await expect(gate()).resolves.toMatchObject({ runnable: true });
    expect(requirement.backlog.items[0].attempts).toBe(1);
  });

  it.each(['core', 'ornamental'] as const)('does not bypass the %s product budget', async tier => {
    requirement.backlog.items[0].tier = tier;
    requirement.backlog.items[0].attempts = 10000;
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['paused', 'blocked', 'completed', 'canceled'])('does not activate work for a %s requirement', async status => {
    requirement.status = status;
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves a requirement execution hold', async () => {
    requirement.metadata.execution_hold = { kind: 'migration_platform_review' };
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { review_quarantine: { active: true } },
    { plan_cancellation_pending: { reason: 'Review', requested_at: '2026-10-01T00:00:00Z' } },
    { blocked_by: [{ blocker_id: 'hold', category: 'user_decision', reason: 'Wait', resolution_actor: 'user' }] },
  ])('retains protected pending-item rejection (%j)', async patch => {
    Object.assign(requirement.backlog.items[0], patch);
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { infrastructure_circuit_open: true },
    { infra_retry_count: 100 },
    { infra_retry_after: '2999-01-01T00:00:00Z' },
  ])('does not activate a pending item during an infrastructure hold (%j)', async patch => {
    Object.assign(plan.steps[0], patch);
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('re-evaluates WIP when another writer wins the backlog CAS', async () => {
    write.mockImplementationOnce(async () => {
      requirement.backlog.items[1].status = 'in_progress';
      requirement.backlog_revision++;
      throw new BacklogWriteConflictError(requirement.id);
    });
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(requirement.backlog.items[0].status).toBe('pending');
    expect(write).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('admits only once when a concurrent writer starts the same item', async () => {
    write.mockImplementationOnce(async () => {
      requirement.backlog.items[0].status = 'in_progress';
      requirement.backlog_revision++;
      throw new BacklogWriteConflictError(requirement.id);
    });
    await expect(gate()).resolves.toMatchObject({ runnable: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rechecks quarantine on CAS retry rather than admitting a newly protected item', async () => {
    write.mockImplementationOnce(async () => {
      requirement.backlog.items[0].review_quarantine = { active: true };
      requirement.backlog_revision++;
      throw new BacklogWriteConflictError(requirement.id);
    });
    await expect(gate()).resolves.toMatchObject({ runnable: false, reason: 'backlog_item_quarantined' });
    expect(requirement.backlog.items[0].status).toBe('pending');
    expect(write).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['paused', 'cancelled'])('stops if the plan becomes %s during admission', async status => {
    const persist = write.getMockImplementation()!;
    write.mockImplementationOnce(async (...args) => {
      const revision = await persist(...args);
      plan.status = status;
      return revision;
    });
    await expect(gate()).resolves.toEqual({ runnable: false, reason: status });
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['paused', 'cancelled', 'completed'])('does not activate an initially %s plan', async status => {
    plan.status = status;
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(write).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('does not activate work when the expected step is not next in execution order', async () => {
    await expect(getPlanExecutionGateStep('plan-1', 'step_2', 'requirement-1'))
      .resolves.toEqual({ runnable: false, reason: 'step_changed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rechecks a new requirement pause when the backlog CAS conflicts', async () => {
    write.mockImplementationOnce(async () => {
      requirement.status = 'paused';
      requirement.backlog_revision++;
      throw new BacklogWriteConflictError(requirement.id);
    });
    await expect(gate()).resolves.toMatchObject({ runnable: false });
    expect(requirement.backlog.items[0].status).toBe('pending');
    expect(write).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    { infrastructure_generation: 1 },
    { metadata: { backlog_item_id: 'item-2' } },
  ])('stops if the selected step changes during admission (%j)', async patch => {
    const persist = write.getMockImplementation()!;
    write.mockImplementationOnce(async (...args) => {
      const revision = await persist(...args);
      Object.assign(plan.steps[0], patch);
      return revision;
    });
    await expect(gate()).resolves.toEqual({ runnable: false, reason: 'step_changed' });
  });

  it('rejects a plan explicitly owned by another requirement before admission', async () => {
    plan.metadata.requirement_id = 'other-requirement';
    await expect(gate()).rejects.toThrow('does not belong');
    expect(write).not.toHaveBeenCalled();
  });

  it('propagates persistence failures without admitting or cancelling work', async () => {
    write.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(gate()).rejects.toThrow('Database unavailable');
    expect(requirement.backlog.items[0].status).toBe('pending');
    expect(cancel).not.toHaveBeenCalled();
  });
});