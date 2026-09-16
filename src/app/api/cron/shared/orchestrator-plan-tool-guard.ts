export type OrchestratorPlanMutationState = {
  createdPlan: boolean;
  updatedPlan: boolean;
};

type AssistantTool = {
  name?: string;
  execute?: (args: any) => Promise<any>;
  [key: string]: any;
};

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
