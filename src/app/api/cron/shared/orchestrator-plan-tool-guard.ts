export type OrchestratorPlanMutationState = {
  createdPlan: boolean;
  updatedPlan: boolean;
};

type AssistantTool = {
  name?: string;
  execute?: (args: any) => Promise<any>;
  [key: string]: any;
};

/** Missing migration plans need planning, not another unrestricted SQL writer. */
export function guardMigrationPlanRecoveryTools(
  tools: AssistantTool[],
  scope: { requirementId: string; instanceId: string; siteId: string; userId: string },
): AssistantTool[] {
  const readers = new Set(['sandbox_read_file', 'sandbox_list_files', 'sandbox_read_logs',
    'harness_inspect', 'harness_events', 'harness_reference', 'harness_source', 'skill_lookup']);
  // In particular omit the tools router: its closure still owns the full catalog.
  return tools.filter(tool => readers.has(tool.name || '') || tool.name === 'instance_plan').map(tool => {
    if (tool.name !== 'instance_plan' || typeof tool.execute !== 'function') return tool;
    const execute = tool.execute;
    return { ...tool, execute: async (args: any) => {
      if (!['list', 'create'].includes(args?.action) || args?.is_template === true) {
        return { success: false, error: 'Migration plan recovery permits only listing or creating a requirement-bound execution plan.' };
      }
      if (args.action === 'create' && (!Array.isArray(args.steps) || !args.steps.length ||
        args.steps.some((step: any) => !step || typeof step !== 'object' || Array.isArray(step)))) {
        return { success: false, error: 'Migration plan recovery requires at least one executable sandbox step.' };
      }
      return execute({ ...args, instance_id: scope.instanceId, site_id: scope.siteId,
        user_id: scope.userId, requirement_id: scope.requirementId, is_template: false,
        ...(args.action === 'create' ? { status: 'pending', steps: args.steps.map((step: any) => {
          // Assignment receipts belong to the host, not to model-authored plans.
          const metadata = step.metadata && typeof step.metadata === 'object' && !Array.isArray(step.metadata)
            ? Object.fromEntries(Object.entries(step.metadata).filter(([key]) => !/^(migration_|repair_)/.test(key))) : {};
          return { ...step, metadata, requires_sandbox: true };
        }) } : {}) });
    } };
  });
}

export function guardOrchestratorPlanTool(
  tools: AssistantTool[],
  state: OrchestratorPlanMutationState,
): AssistantTool[] {
  return tools.map((tool) => {
    if (tool.name !== 'instance_plan' || typeof tool.execute !== 'function') {
      return tool;
    }

    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args: any) => {
        const action = args?.action;
        if (action === 'create' && state.createdPlan) {
          return {
            success: false,
            error:
              'An instance plan was already created successfully in this orchestrator run. Continue with the existing plan.',
          };
        }

        const result = await execute(args);
        if (action === 'create' && result?.success === true && result?.data?.id) {
          state.createdPlan = true;
        } else if (
          action === 'update' &&
          result?.success === true &&
          result?.data?.id
        ) {
          state.updatedPlan = true;
        }
        return result;
      },
    };
  });
}
