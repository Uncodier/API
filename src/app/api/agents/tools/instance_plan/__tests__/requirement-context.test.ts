import { updateInstancePlanCore } from '../update/core';
import { createInstancePlanCore } from '../create/core';
import { instancePlanTool } from '../assistantProtocol';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requirementStepExecutionBlock } from '@/lib/services/requirement-execution-visibility';
jest.mock('@/lib/services/requirement-execution-visibility', () => ({ requirementStepExecutionBlock: jest.fn() }));

const workflowQuery: Record<string, jest.Mock> = {};
workflowQuery.select = jest.fn(() => workflowQuery);
workflowQuery.eq = jest.fn(() => workflowQuery);
workflowQuery.contains = jest.fn(() => workflowQuery);
workflowQuery.limit = jest.fn(() => workflowQuery);
workflowQuery.maybeSingle = jest.fn(async () => ({ data: null, error: null }));
const from = jest.fn(() => workflowQuery);

jest.mock('../update/core', () => ({
  updateInstancePlanCore: jest.fn(),
}));
jest.mock('../get/core', () => ({
  getInstancePlansCore: jest.fn(),
}));
jest.mock('../create/core', () => ({
  createInstancePlanCore: jest.fn(),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

const mockedUpdateInstancePlanCore =
  updateInstancePlanCore as jest.MockedFunction<typeof updateInstancePlanCore>;
const mockedCreateInstancePlanCore =
  createInstancePlanCore as jest.MockedFunction<typeof createInstancePlanCore>;

describe('instance plan requirement context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin as any).from = from;
    mockedUpdateInstancePlanCore.mockResolvedValue({ success: true } as any);
    mockedCreateInstancePlanCore.mockResolvedValue({ success: true } as any);
    (requirementStepExecutionBlock as jest.Mock).mockResolvedValue(null);
  });

  it('binds updates to the captured requirement instead of caller input', async () => {
    const tool = instancePlanTool('site-1', 'instance-1', 'user-1', 'req-1');

    await tool.execute({
      action: 'update',
      instance_id: 'instance-1',
      plan_id: 'plan-1',
      title: 'Updated plan',
      requirement_id: 'req-other',
    } as any);

    expect(mockedUpdateInstancePlanCore).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'plan-1',
        requirement_id: 'req-1',
      }),
    );
  });

  it('binds plan creation to the captured requirement context', async () => {
    const tool = instancePlanTool('site-1', 'instance-1', 'user-1', 'req-1');

    await tool.execute({
      action: 'create',
      instance_id: 'instance-1',
      title: 'Requirement plan',
      requirement_id: 'req-other',
    } as any);

    expect(mockedCreateInstancePlanCore).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: 'instance-1',
        requirement_id: 'req-1',
      }),
    );
  });

  it('preserves generic instance plan creation outside requirements', async () => {
    const tool = instancePlanTool('site-1', 'instance-1', 'user-1');

    await tool.execute({
      action: 'create',
      instance_id: 'instance-1',
      title: 'Generic plan',
    } as any);

    expect(mockedCreateInstancePlanCore).toHaveBeenCalledWith(
      expect.not.objectContaining({ requirement_id: expect.anything() }),
    );
  });

  it('blocks terminal plan updates only in requirement context', async () => {
    const requirementTool = instancePlanTool(
      'site-1',
      'instance-1',
      'user-1',
      'req-1',
    );

    await expect(requirementTool.execute({
      action: 'update',
      instance_id: 'instance-1',
      plan_id: 'plan-1',
      status: 'cancelled',
    } as any)).rejects.toThrow('plan and step execution results are runner-owned');
    expect(mockedUpdateInstancePlanCore).not.toHaveBeenCalled();

    const genericTool = instancePlanTool('site-1', 'instance-1', 'user-1');
    await expect(genericTool.execute({
      action: 'update',
      instance_id: 'instance-1',
      plan_id: 'plan-1',
      status: 'cancelled',
    } as any)).resolves.toEqual({ success: true });
    expect(mockedUpdateInstancePlanCore).toHaveBeenCalledTimes(1);
  });

  it('does not let the interactive assistant bypass requirement step gates', async () => {
    const tool = instancePlanTool(
      'site-1',
      'instance-1',
      'user-1',
      'req-1',
    );

    await expect(tool.execute({
      action: 'execute_step',
      instance_id: 'instance-1',
      plan_id: 'plan-1',
      step_id: 'step-1',
      step_status: 'completed',
      step_output: 'Looks complete.',
    } as any)).resolves.toMatchObject({
      noop: true,
      terminal_requested: true,
      requested_status: 'completed',
    });
    expect(mockedUpdateInstancePlanCore).not.toHaveBeenCalled();
  });

  it('rejects a pretend resume before modifying a step in a held requirement', async () => {
    (requirementStepExecutionBlock as jest.Mock).mockResolvedValue('0016.sql: Technical review required');
    const result = await instancePlanTool('site', 'instance', 'user', 'req').execute({
      action: 'execute_step', plan_id: 'plan', step_id: 'step', step_status: 'in_progress', step_output: 'Resuming',
    } as any);
    expect(result).toMatchObject({ success: false, execution_started: false, code: 'requirement_execution_blocked' });
    expect(mockedUpdateInstancePlanCore).not.toHaveBeenCalled();
    expect(requirementStepExecutionBlock).toHaveBeenCalledWith('req', 'site');
  });
});
