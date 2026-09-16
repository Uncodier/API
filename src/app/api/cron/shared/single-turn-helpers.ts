import type { Sandbox } from '@vercel/sandbox';
import {
  deriveCategoriesFailed,
  formatIterationSignals,
  type GateFailureCategory,
} from './step-iteration-signals';
import type { FlowGateResult } from './gates/types';

const WORK_DIR = '/vercel/sandbox';

export async function captureInteractionBaseline(
  sandbox: Sandbox,
  persistedStep: any,
): Promise<string | undefined> {
  const existing = persistedStep.metadata?.interaction_audit_baseline_sha;
  if (typeof existing === 'string' && /^[0-9a-f]{40,64}$/i.test(existing)) return existing;
  try {
    const head = await sandbox.runCommand('git', [
      '-C',
      WORK_DIR,
      'rev-parse',
      'HEAD',
    ]);
    const sha = (await head.stdout().catch(() => '')).trim();
    return head.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
  } catch (error: unknown) {
    console.warn(
      '[SingleTurn] Could not capture interaction audit baseline:',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export function buildGateErrorFeedback(params: {
  gate: FlowGateResult;
  step: any;
  persistedStep: any;
}): { excerpt: string; raw: string; categories: GateFailureCategory[] } {
  const raw = params.gate.error || params.gate.reason || '';
  const categories = params.gate.richSignals
    ? deriveCategoriesFailed(params.gate.richSignals as any)
    : [];
  if (params.gate.ok || !params.gate.richSignals) {
    return { excerpt: raw, raw, categories };
  }
  return {
    raw,
    categories,
    excerpt: formatIterationSignals({
      ...(params.gate.richSignals as any),
      attempt: (params.persistedStep.retry_count || 0) + 1,
      max_attempts: 2,
      step: {
        order: params.step.order,
        title: params.step.title,
        expected_output: params.step.expected_output,
      },
      categories_failed: categories,
      top_level_error: raw,
    }),
  };
}

type StepCompletionResult = {
  steps?: Array<{
    toolCalls?: Array<{
      toolName?: string;
      args?: Record<string, unknown>;
    }>;
  }>;
};

export type StepTerminalRequest = {
  status: 'completed' | 'failed';
  output?: string;
};

export function getDeclaredProtectedRoutes(step: {
  protected_routes?: unknown;
  metadata?: { protected_routes?: unknown };
}): string[] | undefined {
  const declared = step.protected_routes ?? step.metadata?.protected_routes;
  if (!Array.isArray(declared)) return undefined;
  const routes = declared.filter(
    (route: unknown): route is string => typeof route === 'string',
  );
  return routes.length ? routes : undefined;
}

/**
 * Treat the executor's legacy `instance_plan.execute_step(completed)` call as
 * a request to run the gate. The cron runner remains the only component that
 * may persist the terminal step status.
 */
export function getStepTerminalRequest(
  result: StepCompletionResult,
  expected: { planId: string; stepId: string },
): StepTerminalRequest | null {
  for (const executionStep of result.steps || []) {
    for (const toolCall of executionStep.toolCalls || []) {
      if (toolCall.toolName !== 'instance_plan') continue;
      const args = toolCall.args || {};
      if (args.action !== 'execute_step') continue;
      if (args.step_status !== 'completed' && args.step_status !== 'failed') continue;
      if (typeof args.plan_id === 'string' && args.plan_id !== expected.planId) continue;
      if (typeof args.step_id === 'string' && args.step_id !== expected.stepId) continue;
      return {
        status: args.step_status,
        output: typeof args.step_output === 'string' ? args.step_output : undefined,
      };
    }
  }
  return null;
}

export function hasStepCompletionRequest(
  result: StepCompletionResult,
  expected: { planId: string; stepId: string },
): boolean {
  return getStepTerminalRequest(result, expected)?.status === 'completed';
}

/** Cron runner owns step status; model-side execute_step is a completion signal. */
export function withExecuteStepNoop<
  T extends { name?: string; execute?: (args: Record<string, unknown>) => Promise<unknown> },
>(tools: T[]): T[] {
  return tools.map((tool) => {
    if (tool?.name !== 'instance_plan' || typeof tool.execute !== 'function') return tool;
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) =>
        args?.action === 'execute_step'
          ? {
              success: true,
              noop: true,
              terminal_requested: args?.step_status === 'completed' || args?.step_status === 'failed',
              completion_requested: args?.step_status === 'completed',
              requested_status: args?.step_status,
              message: 'Terminal request recorded. The cron runner owns status changes and gate execution.',
            }
          : original(args),
    };
  });
}
