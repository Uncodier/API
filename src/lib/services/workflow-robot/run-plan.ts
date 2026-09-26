import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { processAssistantTurn } from '@/app/api/robots/instance/assistant/assistant-turn';
import { prepareAssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { fetchStepLogHistoryText } from '@/app/api/cron/shared/step-history-builder';
import { ensureWorkflowSandbox, stopWorkflowSandbox } from './sandbox-workspace';
import {
  buildWorkflowRetryContext,
  canRetryStep,
  interpolateWorkflowText,
  resolveMaxRetries,
} from './retry';
import {
  claimWorkflowRunExecution,
  finishWorkflowRunExecution,
  renewWorkflowRunExecutionClaim,
} from './execution-claim';
import {
  createWorkflowPlanResultCapture,
  type WorkflowPlanResult,
  type WorkflowPlanResultCapture,
} from './plan-result';
import { workflowStepRequiresBrowser } from './browser';
import { createWorkflowToolExecutionTracker } from './execution-tracker';
import { workflowStepStringList } from './step-config';
import { parseWorkflowExpectedOutputContract } from './result-shape';
import { shouldRunWorkflowStep, workflowRelationPrompt } from './relation-routing';
import { buildWorkflowStepPrompt } from './step-prompt';

const MAX_WORKFLOW_STEP_TURNS = 10;
class WorkflowStepResultError extends Error {
  readonly lastText: string;
  readonly planResult?: WorkflowPlanResult;

  constructor(message: string, lastText: string, planResult?: WorkflowPlanResult) {
    super(message);
    this.name = 'WorkflowStepResultError';
    this.lastText = lastText;
    this.planResult = planResult;
  }
}

async function runStepTurns(
  context: any,
  userContent: string,
  capture: WorkflowPlanResultCapture,
  deadline?: number,
): Promise<{ result: WorkflowPlanResult; lastText: string; turns: number }> {
  let messages: any[] = [{ role: 'user', content: userContent }];
  let lastText = '';
  let turns = 0;
  try {
    while (turns < MAX_WORKFLOW_STEP_TURNS) {
      if (deadline && Date.now() >= deadline) {
        throw new Error('Pre-response workflow time budget exceeded');
      }
      turns++;
      const turn = await processAssistantTurn(context, messages);
      messages = turn.messages;
      lastText = turn.text || lastText;
      const submitted = capture.getResult();
      if (submitted) {
        return { result: submitted, lastText, turns };
      }
      if (turn.isDone) {
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              'The step has no accepted plan_result. Call plan_result now with the factual terminal status and structured evidence.',
          },
        ];
      }
    }
    throw new WorkflowStepResultError(
      `Workflow step exhausted ${MAX_WORKFLOW_STEP_TURNS} turns without an accepted plan_result.`,
      lastText,
    );
  } catch (err: any) {
    if (err && typeof err === 'object' && !('lastText' in err)) {
      err.lastText = lastText;
    }
    throw err;
  }
}

async function persistStepPatch(plan: any, patch: Record<string, unknown>) {
  await updateInstancePlanCore({
    plan_id: plan.id,
    instance_id: plan.instance_id,
    site_id: plan.site_id,
    status: 'in_progress',
    steps: [patch],
  });
}

function parseLegacyStepOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recordPreviousStepOutput(
  previousOutputs: Record<string, unknown>,
  step: Record<string, any>,
): void {
  const result =
    step.result && typeof step.result === 'object'
      ? step.result as Record<string, any>
      : null;
  const output = result?.data ?? parseLegacyStepOutput(step.actual_output);
  previousOutputs[String(step.order)] = {
    output,
    summary: result?.summary || step.actual_output || '',
    status: result?.status || step.status,
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    title: step.title,
    ...(step.error_message ? { error: step.error_message } : {}),
  };
  previousOutputs[`step_${step.order}`] = output;
}

export async function runWorkflowPlan(runPlanId: string, options?: { deadline?: number }): Promise<{
  run_plan_id: string;
  status: string;
  steps_completed: number;
}> {
  const { data: plan, error } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('id', runPlanId)
    .single();
  if (error || !plan) throw new Error('Run plan not found');
  if (!(plan.metadata as any)?.workflow_run) {
    throw new Error('Plan is not a workflow run');
  }

  const claimed = await claimWorkflowRunExecution(runPlanId);
  if (!claimed) {
    return {
      run_plan_id: runPlanId,
      status: 'already_running',
      steps_completed: plan.steps_completed || 0,
    };
  }

  const dryRun = Boolean((plan.metadata as any)?.dry_run);
  const preResponseOnly = (plan.metadata as any)?.pre_response_only === true;
  const triggerPayload = ((plan.metadata as any)?.trigger_payload || {}) as Record<string, unknown>;
  const steps = Array.isArray(plan.steps) ? [...plan.steps] : [];
  steps.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));

  const previousOutputs: Record<string, unknown> = {};
  let sandboxId: string | null = null;
  let sandboxTools: unknown[] = [];
  let sandboxEnvironmentKeys: string[] = [];
  let browserReady = false;
  let anyFailed = false;
  let completed = 0;

  try {
    const { error: startError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'in_progress',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', runPlanId);
    if (startError) {
      throw new Error(`Failed to mark workflow plan in progress: ${startError.message}`);
    }

    for (const step of steps) {
      if (options?.deadline && Date.now() >= options.deadline) {
        throw new Error('Pre-response workflow time budget exceeded');
      }
      if (step.status === 'completed' || step.status === 'cancelled') {
        recordPreviousStepOutput(previousOutputs, step);
        if (step.status === 'completed') completed++;
        continue;
      }
      if (!shouldRunWorkflowStep(step, steps)) {
        await persistStepPatch(plan, { id: step.id, status: 'cancelled', completed_at: new Date().toISOString() });
        step.status = 'cancelled';
        continue;
      }
      if (!await renewWorkflowRunExecutionClaim(runPlanId, claimed.token)) {
        throw new Error('Workflow run claim was lost before step execution');
      }

      const maxRetries = resolveMaxRetries(step.max_retries);
      if (step.status === 'failed' && !canRetryStep(step.retry_count || 0, maxRetries)) {
        recordPreviousStepOutput(previousOutputs, step);
        if (!steps.some((candidate) => candidate.metadata?.parent_node_id === step.metadata?.node_id &&
          shouldRunWorkflowStep(candidate, steps))) {
          anyFailed = true;
          break;
        }
        continue;
      }

      const needsBrowser = workflowStepRequiresBrowser(step);
      const needsSandbox = Boolean(
        needsBrowser ||
        step.requires_sandbox ||
        step.metadata?.requires_sandbox,
      );
      if (preResponseOnly && needsSandbox) {
        // Sandbox and browser tools can make outbound requests and send messages.
        // Never provision them for a customer pre-response run.
        throw new Error('Sandbox/browser steps cannot run before a customer response');
      }
      const browserAllowedDomains = workflowStepStringList(step, 'browser_allowed_domains');
      const browserSecretNames = workflowStepStringList(step, 'browser_secret_names');
      if (needsSandbox) {
        const ensured = await ensureWorkflowSandbox({
          runPlanId: plan.id,
          title: plan.title,
          requiresBrowser: needsBrowser,
          browserAllowedDomains,
          browserSecretNames,
          instanceId: plan.instance_id,
          siteId: plan.site_id,
        });
        sandboxId = ensured.sandboxId;
        sandboxTools = ensured.tools;
        sandboxEnvironmentKeys = ensured.environmentKeys;
        browserReady = ensured.browserReady;
      }

      let stepSucceeded = false;
      while (!stepSucceeded) {
        await persistStepPatch(plan, {
          id: step.id,
          status: 'in_progress',
          started_at: step.started_at || new Date().toISOString(),
        });

        const isRetry = (step.retry_count || 0) > 0;
        let retryContext = '';
        if (isRetry) {
          const interpCtx = { trigger: triggerPayload, steps: previousOutputs };
          const recoveryRaw = typeof step.recovery_plan === 'string' ? step.recovery_plan : '';
          const historyText = await fetchStepLogHistoryText(plan.instance_id, plan.id, step.id);
          retryContext = buildWorkflowRetryContext({
            errorMessage: step.error_message || 'Unknown error',
            retryCount: step.retry_count || 0,
            maxRetries,
            lastOutput: step.actual_output,
            step: { id: step.id, order: step.order, title: step.title },
            triggerSnippet: JSON.stringify(triggerPayload || {}, null, 2),
            historyText,
            recoveryPlan: recoveryRaw
              ? interpolateWorkflowText(recoveryRaw, interpCtx)
              : '',
          });
        }

        const executionTracker = createWorkflowToolExecutionTracker();
        step.expected_output = parseWorkflowExpectedOutputContract(step.expected_output, step).suggestion || step.expected_output;
        const resultCapture = createWorkflowPlanResultCapture(step, {
          executionTracker,
          requireToolExecution: !preResponseOnly && step.type !== 'condition',
          requiresBrowser: needsBrowser,
          requiredToolExecutions: preResponseOnly ? [] : step.metadata?.mcp_actions || [],
        });
        const systemPrompt = buildWorkflowStepPrompt({
          plan,
          step,
          dryRun,
          triggerPayload,
          previousOutputs,
          instanceId: plan.instance_id,
          siteId: plan.site_id,
          retryContext,
          sandboxTools: needsSandbox ? sandboxTools : undefined,
          sandboxEnvironmentKeys: needsSandbox ? sandboxEnvironmentKeys : undefined,
          browserReady: needsBrowser && browserReady,
          preResponseOnly,
          relationPrompt: workflowRelationPrompt(step, steps),
        });

        const context = await prepareAssistantContext(
          plan.instance_id,
          `Execute step ${step.order}: ${step.title}`,
          plan.site_id,
          plan.user_id,
          [
            ...(needsSandbox ? sandboxTools : []),
            resultCapture.tool,
          ],
          false,
          systemPrompt,
        );
        context.executionOptions.plan_id = plan.id;
        context.executionOptions.step_id = step.id;
        context.toolExecutionTracker = executionTracker;
        context.preResponseOnly = preResponseOnly;

        const modeLabel = preResponseOnly ? 'CHANNEL PRE-RESPONSE — NO SENDS' : dryRun ? 'DRY RUN' : 'LIVE';
        const userContent = isRetry
          ? `[${modeLabel}] Execute step ${step.order}: ${step.title}. This is retry ${step.retry_count}; follow the recovery plan if provided.`
          : `[${modeLabel}] Execute step ${step.order}: ${step.title}. ${step.instructions}`;

        if (!await renewWorkflowRunExecutionClaim(runPlanId, claimed.token)) {
          throw new Error('Workflow run claim was lost during step execution');
        }
        try {
          const execution = await runStepTurns(context, userContent, resultCapture, options?.deadline);
          const reported = execution.result;
          if (reported.status === 'failed') {
            throw new WorkflowStepResultError(
              reported.error?.message || reported.summary,
              execution.lastText,
              reported,
            );
          }
          const skipped = reported.status === 'skipped';
          const structuredResult = {
            ...reported,
            turns: execution.turns,
          };
          const actualOutput = Object.keys(reported.data).length > 0
            ? JSON.stringify(reported.data)
            : reported.summary;

          await persistStepPatch(plan, {
            id: step.id,
            status: skipped ? 'cancelled' : 'completed',
            actual_output: actualOutput,
            result: structuredResult,
            completed_at: new Date().toISOString(),
            error_message: null,
          });
          step.status = skipped ? 'cancelled' : 'completed';
          step.error_message = null;
          recordPreviousStepOutput(previousOutputs, {
            ...step,
            status: skipped ? 'cancelled' : 'completed',
            actual_output: actualOutput,
            result: structuredResult,
          });
          if (!skipped) completed++;
          stepSucceeded = true;
        } catch (err: any) {
          const nextCount = (step.retry_count || 0) + 1;
          const errorMessage = err?.message || String(err);
          const planResult =
            err instanceof WorkflowStepResultError ? err.planResult : undefined;
          const lastText =
            (typeof err?.lastText === 'string' && err.lastText.trim()
              ? err.lastText
              : planResult?.summary) ||
            step.actual_output ||
            '';
          step.retry_count = nextCount;
          step.error_message = errorMessage;
          step.actual_output = lastText || step.actual_output;
          await persistStepPatch(plan, {
            id: step.id,
            status: 'failed',
            error_message: errorMessage,
            retry_count: nextCount,
            actual_output: step.actual_output,
            ...(planResult ? { result: planResult } : {}),
            completed_at: new Date().toISOString(),
          });
          if (
            planResult?.error?.retryable === false ||
            !canRetryStep(nextCount, maxRetries)
          ) {
            step.status = 'failed';
            step.result = planResult || null;
            recordPreviousStepOutput(previousOutputs, step);
            // Only continue if a downstream failure branch handles this step.
            // Existing linear workflows still stop immediately on exhausted retries.
            if (!steps.some((candidate) => candidate.metadata?.parent_node_id === step.metadata?.node_id &&
              shouldRunWorkflowStep(candidate, steps))) {
              anyFailed = true;
            }
            break;
          }
        }
      }

      if (anyFailed) break;
    }

    const finalStatus = anyFailed ? 'failed' : 'completed';
    if (!await renewWorkflowRunExecutionClaim(runPlanId, claimed.token)) {
      throw new Error('Workflow run claim was lost before finalization');
    }
    const { error: finalPlanError } = await supabaseAdmin.from('instance_plans').update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      steps_completed: completed,
      progress_percentage: steps.length ? Math.round((completed / steps.length) * 100) : 100,
      updated_at: new Date().toISOString(),
    }).eq('id', runPlanId);
    if (finalPlanError) {
      throw new Error(`Failed to finalize workflow plan: ${finalPlanError.message}`);
    }
    const finalized = await finishWorkflowRunExecution(
      runPlanId,
      claimed.token,
      finalStatus,
    );
    if (!finalized) {
      throw new Error('Workflow run claim was lost before finalization');
    }

    return { run_plan_id: runPlanId, status: finalStatus, steps_completed: completed };
  } catch (error) {
    const released = await finishWorkflowRunExecution(
      runPlanId,
      claimed.token,
      'pending',
      error instanceof Error ? error.message : String(error),
    ).catch(() => false);
    if (released) {
      await supabaseAdmin
        .from('instance_plans')
        .update({
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', runPlanId);
    }
    throw error;
  } finally {
    if (sandboxId) {
      await stopWorkflowSandbox(sandboxId);
    }
  }
}
