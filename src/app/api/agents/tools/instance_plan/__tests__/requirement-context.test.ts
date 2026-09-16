import { updateInstancePlanCore } from '../update/route';
import { instancePlanTool } from '../assistantProtocol';

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
  supabaseAdmin: {},
}));

const mockedUpdateInstancePlanCore =
  updateInstancePlanCore as jest.MockedFunction<typeof updateInstancePlanCore>;

describe('instance plan requirement context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUpdateInstancePlanCore.mockResolvedValue({ success: true } as any);
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
});
