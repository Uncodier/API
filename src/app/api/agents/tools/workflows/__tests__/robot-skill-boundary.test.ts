import { jest } from '@jest/globals';
import { BusinessWorkflowService } from '@/lib/services/workflow/business-workflow-service';
import { workflowsTool } from '../assistantProtocol';

describe('internal workflows tool robot skill boundary', () => {
  const execute = jest.fn<(...args: any[]) => Promise<unknown>>();
  const startPayload = { site_id: 'site-a', activity: 'robot', message: 'hello', context: '{}' };
  const promptPayload = { instance_id: 'instance-a', site_id: 'site-a', message: 'hello', step_status: 'in_progress', context: '{}' };

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue({ success: true });
    jest.spyOn(BusinessWorkflowService.prototype as any, 'initializeClient')
      .mockResolvedValue({ workflow: { execute } });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['startRobot', startPayload, 'startRobotWorkflow'],
    ['promptRobot', promptPayload, 'promptRobotWorkflow'],
  ])('rejects required skills in %s before contacting Temporal', async (action, payload, _workflowName) => {
    const result = await workflowsTool('site-a').execute({ action: action as 'startRobot' | 'promptRobot',
      payload: { ...payload, skill_mode: 'required', skill_slugs: ['writer'] } });
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_SKILL_SELECTION' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['startRobot', startPayload, 'startRobotWorkflow'],
    ['promptRobot', promptPayload, 'promptRobotWorkflow'],
  ])('rejects invalid or nonempty skill selections from %s', async (action, payload, _workflowName) => {
    for (const selection of [
      { skill_mode: 'auto', skill_slugs: ['writer'] },
      { skill_mode: 'unexpected' },
      { skill_slugs: 'writer' },
    ]) {
      const result = await workflowsTool('site-a').execute({ action: action as 'startRobot' | 'promptRobot', payload: { ...payload, ...selection } });
      expect(result).toMatchObject({ success: false, error: { code: 'INVALID_SKILL_SELECTION' } });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['startRobot', startPayload, 'startRobotWorkflow'],
    ['promptRobot', promptPayload, 'promptRobotWorkflow'],
  ])('whitelists the %s workflow arguments even for internal calls', async (action, payload, workflowName) => {
    const result = await workflowsTool('site-a', 'user-a').execute({
      action: action as 'startRobot' | 'promptRobot',
      payload: { ...payload, skill_mode: 'auto', skill_slugs: [], unexpected: 'not for Temporal' },
    });
    expect(result).toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith(workflowName, expect.objectContaining({
      args: [action === 'startRobot' ? { ...payload, user_id: 'user-a' } : payload],
    }));
  });
});