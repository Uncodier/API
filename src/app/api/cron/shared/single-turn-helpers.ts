import type { Sandbox } from '@vercel/sandbox';
import {
  deriveCategoriesFailed,
  formatIterationSignals,
  type GateFailureCategory,
} from './step-iteration-signals';
import type { FlowGateResult } from './gates/types';
import {
  ACTION_LOOP_BLOCKED_ACTION_MARKER,
  buildToolActionKey,
} from './loop-detectors';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { normalizeStepValidationTargets } from './step-probe-policy';

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

/**
 * Hashes product files without mutating the worktree. Administrative mirrors
 * are deliberately excluded so progress/evidence-only edits cannot reset the
 * no-progress circuit.
 */
export async function captureWorkspaceProgressFingerprint(
  sandbox: Sandbox,
): Promise<string | undefined> {
  try {
    const result = await sandbox.runCommand('sh', [
      '-c',
      [
        `cd "${WORK_DIR}"`,
        '{',
        'git ls-files --cached --others --exclude-standard | sort -u | while IFS= read -r file; do',
        '  case "$file" in',
        '    progress.md|evidence/*|.qa/*|qa_results.json|test_results.json|feature_list.json|requirement.spec.md|DECISIONS.md|README.md|AGENTS.md|.instructions) continue ;;',
        '  esac',
        '  printf "%s " "$file"',
        '  git hash-object "$file" 2>/dev/null || true',
        'done',
        '} | git hash-object --stdin',
      ].join('\n'),
    ]);
    const fingerprint = (await result.stdout().catch(() => '')).trim();
    return result.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(fingerprint)
      ? fingerprint
      : undefined;
  } catch (error: unknown) {
    console.warn(
      '[SingleTurn] Could not capture workspace progress fingerprint:',
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

export function isTransientGateFailure(
  gate: Pick<
    FlowGateResult,
    'ok' | 'error' | 'infrastructureFailure' | 'sandboxUnavailable'
  >,
): boolean {
  if (gate.ok) return false;
  return (
    gate.infrastructureFailure === true ||
    gate.sandboxUnavailable === true ||
    isSandboxGoneError(gate.error)
  );
}

type AssistantToolResult = {
  toolName?: unknown;
  result?: unknown;
  cleanedResult?: unknown;
  isError?: unknown;
};

function explicitToolFailurePayload(
  toolResult: AssistantToolResult,
): unknown {
  const payload = toolResult.cleanedResult ?? toolResult.result;
  if (toolResult.isError === true) return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const status = Number(record.status ?? record.statusCode);
  if (
    record.success === false ||
    record.failed === true ||
    record.error != null ||
    status === 404 ||
    status === 410
  ) {
    return record.error ?? payload;
  }
  return undefined;
}

function isSandboxGoneFailurePayload(payload: unknown): boolean {
  if (typeof payload === 'string') return isSandboxGoneError(payload);
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (isSandboxGoneError({
    message: typeof record.message === 'string' ? record.message : undefined,
    status: typeof record.status === 'number' ? record.status : undefined,
    statusCode:
      typeof record.statusCode === 'number' ? record.statusCode : undefined,
  })) {
    return true;
  }
  try {
    return isSandboxGoneError(JSON.stringify(payload));
  } catch {
    return false;
  }
}

export function hasSandboxGoneToolFailure(result: {
  steps?: Array<{ toolResults?: AssistantToolResult[] }>;
}): boolean {
  return (result.steps || []).some((step) =>
    (step.toolResults || []).some((toolResult) => {
      const toolName =
        typeof toolResult.toolName === 'string' ? toolResult.toolName : '';
      if (!toolName.startsWith('sandbox_')) return false;
      const failure = explicitToolFailurePayload(toolResult);
      return failure !== undefined && isSandboxGoneFailurePayload(failure);
    }),
  );
}

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

export function getDeclaredValidationTargets(step: {
  validation_targets?: unknown;
  metadata?: { validation_targets?: unknown };
}) {
  const targets = normalizeStepValidationTargets(
    step.validation_targets ?? step.metadata?.validation_targets,
  );
  return targets.length ? targets : undefined;
}

export function getDeclaredTestCommand(step: {
  test_command?: unknown;
  validation_rules?: unknown;
}): string | undefined {
  if (
    typeof step.test_command === 'string' &&
    step.test_command.trim().length > 0
  ) {
    return step.test_command.trim();
  }
  if (!Array.isArray(step.validation_rules)) return undefined;
  for (const rule of step.validation_rules) {
    if (typeof rule !== 'string') continue;
    const explicit = rule.match(
      /`((?:npm|pnpm|yarn|bun|npx)\s+[^`]*(?:test|jest|vitest)[^`]*)`/i,
    );
    if (explicit?.[1]) return explicit[1].trim();
  }
  return undefined;
}

export function withActionLoopGuard<
  T extends { name?: string; execute?: (args: Record<string, unknown>) => Promise<unknown> },
>(tools: T[], historyText: string): T[] {
  const markerIndex = historyText.lastIndexOf(
    ACTION_LOOP_BLOCKED_ACTION_MARKER,
  );
  if (markerIndex < 0) return tools;
  const blockedAction = historyText
    .slice(markerIndex + ACTION_LOOP_BLOCKED_ACTION_MARKER.length)
    .split('\n', 1)[0]
    .trim();
  if (!blockedAction) return tools;

  return tools.map((tool) => {
    if (!tool.name || typeof tool.execute !== 'function') return tool;
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        if (
          tool.name === 'instance_plan' &&
          args.action === 'execute_step'
        ) {
          return original(args);
        }
        if (buildToolActionKey(tool.name!, args) !== blockedAction) {
          return original(args);
        }
        return {
          success: false,
          blocked: true,
          error:
            'Action loop guard blocked this unchanged tool call after three repetitions. Change the arguments or use a different tool.',
        };
      },
    };
  });
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
