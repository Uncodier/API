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

/** Cron runner owns step status; model-side execute_step is a documented no-op. */
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
              message: 'execute_step is owned by the cron runner; step status was not changed.',
            }
          : original(args),
    };
  });
}
