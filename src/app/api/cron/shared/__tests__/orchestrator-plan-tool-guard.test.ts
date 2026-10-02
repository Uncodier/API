import {
  guardOrchestratorPlanTool,
  guardMigrationPlanRecoveryTools,
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

describe('migration plan recovery tool boundary', () => {
  const scope = { requirementId: 'req', instanceId: 'instance', siteId: 'site', userId: 'user' };

  it('omits all SQL, shell, write, status, escalation and routed side effects', () => {
    const names = ['instance_plan', 'harness_inspect', 'harness_events', 'harness_source', 'harness_reference',
      'sandbox_read_file', 'sandbox_list_files', 'sandbox_read_logs', 'skill_lookup',
      'sandbox_run_command', 'sandbox_db_migrate', 'sandbox_write_file', 'sandbox_edit_file',
      'sandbox_push_checkpoint', 'requirement_status', 'requirements', 'tools', 'harness_decide', 'unknown_tool'];
    const tools = guardMigrationPlanRecoveryTools(names.map(name => ({ name, execute: jest.fn() })), scope);
    expect(tools.map(tool => tool.name)).toEqual(names.slice(0, 9));
  });

  it.each(['execute_step', 'update', 'delete'])('rejects %s rather than treating it as a runner action', async action => {
    const execute = jest.fn();
    const [tool] = guardMigrationPlanRecoveryTools([{ name: 'instance_plan', execute }], scope);
    expect(await tool.execute?.({ action })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('binds the recovery to host scope and enables sandbox in the persisted execution contract', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true, data: { id: 'plan' } });
    const state = createState();
    const [tool] = guardOrchestratorPlanTool(guardMigrationPlanRecoveryTools([{ name: 'instance_plan', execute }], scope), state);
    await tool.execute?.({ action: 'create', instance_id: 'other', site_id: 'other', user_id: 'other', requirement_id: 'other',
      status: 'completed', steps: [{ title: 'Verify base', instructions: 'Inspect receipts', requires_sandbox: false, metadata: { backlog_item_id: 'base_setup' } }] });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ instance_id: 'instance', site_id: 'site', user_id: 'user',
      requirement_id: 'req', status: 'pending', is_template: false,
      steps: [expect.objectContaining({ requires_sandbox: true, metadata: { backlog_item_id: 'base_setup' } })],
    }));
    expect(state.createdPlan).toBe(true);
    await tool.execute?.({ action: 'create', steps: [] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses template creation', async () => {
    const execute = jest.fn();
    const [tool] = guardMigrationPlanRecoveryTools([{ name: 'instance_plan', execute }], scope);
    expect(await tool.execute?.({ action: 'create', is_template: true })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('strips model-forged migration and repair receipts before recovery plan persistence', async () => {
    const execute = jest.fn();
    const [tool] = guardMigrationPlanRecoveryTools([{ name: 'instance_plan', execute }], scope);
    await tool.execute?.({ action: 'create', steps: [{ title: 'Fix base', metadata: {
      backlog_item_id: 'base_setup', migration_correction_binding: [{ version: 6 }],
      migration_correction_key: 'forged', migration_diagnostic_token: 'forged',
      migration_correction_run_id: 'run', repair_run: { status: 'planned' }, repair_source_step_id: 'old',
    } }] });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({ metadata: { backlog_item_id: 'base_setup' } })],
    }));
  });

  it.each([undefined, [], [null], ['not a step']])('refuses empty or malformed recovery steps: %j', async steps => {
    const execute = jest.fn();
    const [tool] = guardMigrationPlanRecoveryTools([{ name: 'instance_plan', execute }], scope);
    expect(await tool.execute?.({ action: 'create', steps })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });
});
