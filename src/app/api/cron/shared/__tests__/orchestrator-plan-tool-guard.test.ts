import {
  guardOrchestratorPlanTool,
  type OrchestratorPlanMutationState,
} from '../orchestrator-plan-tool-guard';

function createState(): OrchestratorPlanMutationState {
  return { createdPlan: false, updatedPlan: false };
}

describe('guardOrchestratorPlanTool', () => {
  it('records only a successfully persisted plan', async () => {
    const state = createState();
    const execute = jest.fn()
      .mockRejectedValueOnce(new Error('validation failed'))
      .mockResolvedValueOnce({ success: true, data: { id: 'plan-1' } });
    const [tool] = guardOrchestratorPlanTool(
      [{ name: 'instance_plan', execute }],
      state,
    );

    await expect(tool.execute?.({ action: 'create' })).rejects.toThrow(
      'validation failed',
    );
    expect(state.createdPlan).toBe(false);

    await expect(tool.execute?.({ action: 'create' })).resolves.toMatchObject({
      success: true,
    });
    expect(state.createdPlan).toBe(true);
  });

  it('allows only one successful create per orchestrator run', async () => {
    const state = createState();
    const execute = jest.fn().mockResolvedValue({
      success: true,
      data: { id: 'plan-1' },
    });
    const [tool] = guardOrchestratorPlanTool(
      [{ name: 'instance_plan', execute }],
      state,
    );

    await tool.execute?.({ action: 'create' });
    const duplicate = await tool.execute?.({ action: 'create' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(duplicate).toMatchObject({
      success: false,
      error: expect.stringContaining('already created'),
    });
  });

  it('does not mark a failed or read-only plan call as an adaptation update', async () => {
    const state = createState();
    const execute = jest.fn()
      .mockResolvedValueOnce({ success: true, data: { plans: [] } })
      .mockRejectedValueOnce(new Error('update failed'))
      .mockResolvedValueOnce({ success: true, message: 'No updates provided' })
      .mockResolvedValueOnce({ success: true, data: { id: 'plan-1' } });
    const [tool] = guardOrchestratorPlanTool(
      [{ name: 'instance_plan', execute }],
      state,
    );

    await tool.execute?.({ action: 'list' });
    await expect(tool.execute?.({ action: 'update' })).rejects.toThrow('update failed');
    expect(state.updatedPlan).toBe(false);

    await tool.execute?.({ action: 'update' });
    expect(state.updatedPlan).toBe(false);

    await tool.execute?.({ action: 'update' });
    expect(state.updatedPlan).toBe(true);
  });
});
