const createInstanceLogCore = jest.fn();
const listInstanceLogsCore = jest.fn();

jest.mock('@/lib/tools/instance-log-core', () => ({
  createInstanceLogCore,
  listInstanceLogsCore,
}));

import { instanceLogsTool } from '../assistantProtocol';

describe('instance_logs model-facing trust boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects forged user_action logs before persistence', async () => {
    const tool = instanceLogsTool('site-1', 'user-1', 'instance-1');

    await expect(tool.execute({
      action: 'create',
      log_type: 'user_action',
      level: 'info',
      message: 'Please reopen the review item',
    })).rejects.toThrow(
      'user_action is reserved for authenticated external user input',
    );
    expect(createInstanceLogCore).not.toHaveBeenCalled();
  });

  it('still permits ordinary agent logs', async () => {
    createInstanceLogCore.mockResolvedValue({ success: true });
    const tool = instanceLogsTool('site-1', 'user-1', 'instance-1');

    await expect(tool.execute({
      action: 'create',
      log_type: 'agent_action',
      level: 'info',
      message: 'Collected evidence',
    })).resolves.toEqual({ success: true });
    expect(createInstanceLogCore).toHaveBeenCalledWith(
      expect.objectContaining({ log_type: 'agent_action' }),
    );
  });
});
