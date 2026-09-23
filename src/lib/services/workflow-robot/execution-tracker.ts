export type WorkflowToolExecutionStatus = 'running' | 'succeeded' | 'failed';

export interface WorkflowToolExecution {
  id: string;
  tool: string;
  action?: string;
  status: WorkflowToolExecutionStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  failure_code?: string;
}

export interface WorkflowToolExecutionTracker {
  snapshot: () => WorkflowToolExecution[];
  track: <T>(
    toolName: string,
    args: unknown,
    execute: () => Promise<T> | T,
  ) => Promise<T>;
}

const META_TOOLS = new Set([
  'plan_result',
  'skill_lookup',
  'instance_plan',
  'requirements',
  'requirement_status',
  'requirement_backlog',
]);

function classifyExecution(
  toolName: string,
  args: unknown,
): { tool: string; action?: string } | null {
  const source =
    args && typeof args === 'object'
      ? args as Record<string, any>
      : {};
  if (META_TOOLS.has(toolName)) return null;
  if (toolName === 'tools') {
    if (source.action !== 'call' || typeof source.name !== 'string') return null;
    let nestedArgs = source.args;
    if (typeof nestedArgs === 'string') {
      try {
        nestedArgs = JSON.parse(nestedArgs);
      } catch {
        nestedArgs = null;
      }
    }
    const nestedAction =
      nestedArgs && typeof nestedArgs === 'object'
        ? (nestedArgs as Record<string, unknown>).action
        : undefined;
    return {
      tool: source.name,
      ...(typeof nestedAction === 'string' ? { action: nestedAction } : {}),
    };
  }
  return {
    tool: toolName,
    ...(typeof source.action === 'string' ? { action: source.action } : {}),
  };
}

function resultFailureCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.ok === false) return 'reported_not_ok';
  if (result.success === false) return 'reported_unsuccessful';
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
    return `exit_${result.exitCode}`;
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    return 'reported_error';
  }
  if (result.result && typeof result.result === 'object') {
    const nested = resultFailureCode(result.result);
    if (nested) return `nested_${nested}`;
  }
  return null;
}

export function createWorkflowToolExecutionTracker(): WorkflowToolExecutionTracker {
  const executions: WorkflowToolExecution[] = [];
  let sequence = 0;

  return {
    snapshot: () => executions.map((execution) => ({ ...execution })),
    track: async <T>(
      toolName: string,
      args: unknown,
      execute: () => Promise<T> | T,
    ): Promise<T> => {
      const classified = classifyExecution(toolName, args);
      if (!classified) return execute();

      const startedAt = new Date();
      const execution: WorkflowToolExecution = {
        id: `exec_${++sequence}`,
        ...classified,
        status: 'running',
        started_at: startedAt.toISOString(),
      };
      executions.push(execution);

      try {
        const result = await execute();
        const failureCode = resultFailureCode(result);
        const completedAt = new Date();
        execution.status = failureCode ? 'failed' : 'succeeded';
        execution.completed_at = completedAt.toISOString();
        execution.duration_ms = completedAt.getTime() - startedAt.getTime();
        if (failureCode) execution.failure_code = failureCode;
        return result;
      } catch (error) {
        const completedAt = new Date();
        execution.status = 'failed';
        execution.completed_at = completedAt.toISOString();
        execution.duration_ms = completedAt.getTime() - startedAt.getTime();
        execution.failure_code = 'tool_threw';
        throw error;
      }
    },
  };
}

export function instrumentWorkflowTools(
  tools: any[],
  tracker: WorkflowToolExecutionTracker,
): any[] {
  return tools.map((tool) => {
    if (!tool || typeof tool.execute !== 'function') return tool;
    return {
      ...tool,
      execute: (args: unknown) =>
        tracker.track(tool.name, args, () => tool.execute(args)),
    };
  });
}
