import { updateInstancePlanCore } from '../update/route';
import { createInstancePlanCore } from '../create/route';
import { instancePlanTool } from '../assistantProtocol';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const workflowQuery: Record<string, jest.Mock> = {};
workflowQuery.select = jest.fn(() => workflowQuery);
workflowQuery.eq = jest.fn(() => workflowQuery);
workflowQuery.contains = jest.fn(() => workflowQuery);
workflowQuery.limit = jest.fn(() => workflowQuery);
workflowQuery.maybeSingle = jest.fn(async () => ({ data: null, error: null }));
const from = jest.fn(() => workflowQuery);

jest.mock('../update/route', () => ({
  updateInstancePlanCore: jest.fn(),
}));
jest.mock('../get/route', () => ({
  getInstancePlansCore: jest.fn(),
}));
jest.mock('../create/route', () => ({
  createInstancePlanCore: jest.fn(),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
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
    } as any)).rejects.toThrow('plan terminal transitions are runner-owned');
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
});
