import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { processAssistantTurn } from '@/app/api/robots/instance/assistant/assistant-turn';
import { prepareAssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { fetchStepLogHistoryText } from '@/app/api/cron/shared/step-history-builder';
import { SkillsService } from '@/lib/services/skills-service';
import { ensureWorkflowSandbox, stopWorkflowSandbox } from './sandbox-workspace';
import {
  buildWorkflowRetryContext,
  canRetryStep,
  interpolateWorkflowText,
  formatWorkflowValidationPrompt,
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

function buildWorkflowStepPrompt(params: {
  plan: any;
  step: any;
  dryRun: boolean;
  triggerPayload: Record<string, unknown>;
  previousOutputs: Record<string, unknown>;
  instanceId: string;
  siteId: string;
  retryContext?: string;
  sandboxTools?: any[];
  sandboxEnvironmentKeys?: string[];
  browserReady?: boolean;
}): string {
  const skillName = params.step.skill || 'makinari-rol-workflow-step';
  const matched = SkillsService.getSkillBySlugOrName(skillName);
  const skillBlock = matched
    ? `\n\n--- SKILL: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`
    : '';
  const ctx = {
    trigger: params.triggerPayload,
    steps: params.previousOutputs,
  };
  const mcpHints = (params.step.metadata?.mcp_actions || [])
    .map((a: {
      tool: string;
      action?: string;
      args?: Record<string, unknown>;
      hint?: string;
    }) => {
      const rawArgs = a.args && Object.keys(a.args).length > 0
        ? interpolateWorkflowText(JSON.stringify(a.args), ctx)
        : '';
      return `- ${a.tool}${a.action ? ` action=${a.action}` : ''}${
        rawArgs ? ` args=${rawArgs}` : ''
      }${a.hint ? `: ${a.hint}` : ''}`;
    })
    .join('\n');

  const instructions = interpolateWorkflowText(params.step.instructions || '', ctx);
  const expected = interpolateWorkflowText(params.step.expected_output || '', ctx);
  const validationBlock = formatWorkflowValidationPrompt(params.step, (text) =>
    interpolateWorkflowText(text, ctx),
  );
  const browserDomains = Array.isArray(params.step.browser_allowed_domains)
    ? params.step.browser_allowed_domains
    : params.step.metadata?.browser_allowed_domains || [];

  const sandboxInstruction = params.step.requires_sandbox || params.step.metadata?.requires_sandbox
    ? `This step has requires_sandbox=true. sandbox_* tools are available. Do not call sandbox_* on steps without this flag.${
        params.sandboxTools && params.sandboxTools.length > 0
          ? `\nAvailable sandbox tools for this step:\n${params.sandboxTools.map((t: any) => `- ${t.name}`).join('\n')}`
          : ''
      }${
        params.browserReady
          ? '\nBrowser navigation is pre-provisioned. Use sandbox_browser directly; do not install agent-browser or Chrome.'
          : ''
      }${
        params.sandboxEnvironmentKeys?.length
          ? `\nAvailable credential names: ${params.sandboxEnvironmentKeys.join(', ')}. Values are not present in process.env. Use value_env only on trusted domains: ${browserDomains.join(', ') || '(none configured)'}.`
          : '\nNo custom workflow environment variables are configured.'
      }`
    : 'This step has NO sandbox. Do not call sandbox_* tools.';

  const executionModeBlock = params.dryRun
    ? `EXECUTION MODE: DRY RUN (test)
This is a simulation. Read with tools if needed, but do NOT persist CRM/data writes or send messages. Simulate those side effects and include "execution_mode": "dry_run" in plan_result.data.`
    : `EXECUTION MODE: LIVE (real)
This is a real production run, not a test. Call tools via tools and apply real side effects when the step instructions require them (CRM writes, notifications, messages). Do NOT simulate, mock, skip tools, or treat this as a dry run.`;

  const toolInstruction = params.dryRun
    ? 'Use tools for reads. For writes/sends, describe the simulated outcome instead of executing them.'
    : 'You MUST call tools to fulfill the step. Do not only describe what you would do and never fabricate tool results.';

  return `⚠️ WORKFLOW MODE: You are executing ONE predefined workflow step. Do NOT create or update instance_plan or requirements. Do NOT plan new work.

${executionModeBlock}

${toolInstruction}

Instance ID: ${params.instanceId}
Site ID: ${params.siteId}
Plan ID: ${params.plan.id}
Step: ${params.step.order} — ${params.step.title}

Instructions:
${instructions}

Expected output:
${expected || 'A concise factual result that satisfies the step.'}
${validationBlock}
${mcpHints ? `Suggested MCP actions:\n${mcpHints}\n` : ''}
Trigger payload:
${JSON.stringify(params.triggerPayload || {}, null, 2)}

Previous step outputs:
${JSON.stringify(params.previousOutputs || {}, null, 2)}

${sandboxInstruction}
${skillBlock}${params.retryContext || ''}

MANDATORY TERMINAL PROTOCOL:
- Your step is not complete until you call the direct \`plan_result\` tool.
- Submit factual structured data, evidence, and a pass/fail entry for every declared criterion and validation rule.
- If a required capability or external dependency is unavailable, call \`plan_result\` with status="failed" and a concrete error. Never report invented data.
- Plain text is not a completion signal and will be rejected by the runner.`;
}

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
): Promise<{ result: WorkflowPlanResult; lastText: string; turns: number }> {
  let messages: any[] = [{ role: 'user', content: userContent }];
  let lastText = '';
  let turns = 0;
  try {
    while (turns < MAX_WORKFLOW_STEP_TURNS) {
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
  };
  previousOutputs[`step_${step.order}`] = output;
}

export async function runWorkflowPlan(runPlanId: string): Promise<{
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
      if (step.status === 'completed' || step.status === 'cancelled') {
        recordPreviousStepOutput(previousOutputs, step);
        if (step.status === 'completed') completed++;
        continue;
      }
      if (!await renewWorkflowRunExecutionClaim(runPlanId, claimed.token)) {
        throw new Error('Workflow run claim was lost before step execution');
      }

      const maxRetries = resolveMaxRetries(step.max_retries);
      if (step.status === 'failed' && !canRetryStep(step.retry_count || 0, maxRetries)) {
        anyFailed = true;
        break;
      }

      const needsBrowser = workflowStepRequiresBrowser(step);
      const needsSandbox = Boolean(
        needsBrowser ||
        step.requires_sandbox ||
        step.metadata?.requires_sandbox,
      );
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
          requireToolExecution: step.type !== 'condition',
          requiresBrowser: needsBrowser,
          requiredToolExecutions: step.metadata?.mcp_actions || [],
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

        const modeLabel = dryRun ? 'DRY RUN' : 'LIVE';
        const userContent = isRetry
          ? `[${modeLabel}] Execute step ${step.order}: ${step.title}. This is retry ${step.retry_count}; follow the recovery plan if provided.`
          : `[${modeLabel}] Execute step ${step.order}: ${step.title}. ${step.instructions}`;

        if (!await renewWorkflowRunExecutionClaim(runPlanId, claimed.token)) {
          throw new Error('Workflow run claim was lost during step execution');
        }
        try {
          const execution = await runStepTurns(context, userContent, resultCapture);
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
            anyFailed = true;
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
