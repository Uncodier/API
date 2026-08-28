import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { prepareAssistantContext, processAssistantTurn } from '@/app/api/robots/instance/assistant/steps';
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
}): string {
  const skillName = params.step.skill || 'makinari-rol-workflow-step';
  const matched = SkillsService.getSkillBySlugOrName(skillName);
  const skillBlock = matched
    ? `\n\n--- SKILL: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`
    : '';
  const mcpHints = (params.step.metadata?.mcp_actions || [])
    .map((a: { tool: string; action?: string; hint?: string }) =>
      `- ${a.tool}${a.action ? ` action=${a.action}` : ''}${a.hint ? `: ${a.hint}` : ''}`)
    .join('\n');

  const ctx = {
    trigger: params.triggerPayload,
    steps: params.previousOutputs,
  };
  const instructions = interpolateWorkflowText(params.step.instructions || '', ctx);
  const expected = interpolateWorkflowText(params.step.expected_output || '', ctx);
  const validationBlock = formatWorkflowValidationPrompt(params.step, (text) =>
    interpolateWorkflowText(text, ctx),
  );

  const sandboxInstruction = params.step.requires_sandbox || params.step.metadata?.requires_sandbox
    ? `This step has requires_sandbox=true. sandbox_* tools are available. Do not call sandbox_* on steps without this flag.${
        params.sandboxTools && params.sandboxTools.length > 0
          ? `\nAvailable sandbox tools for this step:\n${params.sandboxTools.map((t: any) => `- ${t.name}`).join('\n')}`
          : ''
      }`
    : 'This step has NO sandbox. Do not call sandbox_* tools.';

  const executionModeBlock = params.dryRun
    ? `EXECUTION MODE: DRY RUN (test)
This is a simulation. Read with tools if needed, but do NOT persist CRM/data writes or send messages. Simulate those side effects. Prefix the final text with [DRY RUN]. If you return JSON, include "execution_mode": "dry_run".`
    : `EXECUTION MODE: LIVE (real)
This is a real production run, not a test. Call tools via tools and apply real side effects when the step instructions require them (CRM writes, notifications, messages). Do NOT simulate, mock, skip tools, or treat this as a dry run.`;

  const toolInstruction = params.dryRun
    ? 'Use tools for reads. For writes/sends, describe the simulated outcome instead of executing them.'
    : 'You MUST call tools via tools to fulfill the step. Do not only describe what you would do. After tools succeed, report the factual result in plain text.';

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
${skillBlock}${params.retryContext || ''}`;
}

async function runStepTurns(context: any, userContent: string): Promise<string> {
  let messages: any[] = [{ role: 'user', content: userContent }];
  let isDone = false;
  let lastText = '';
  let turns = 0;
  try {
    while (!isDone && turns < 10) {
      turns++;
      const result = await processAssistantTurn(context, messages);
      messages = result.messages;
      isDone = result.isDone;
      lastText = result.text || lastText;
    }
    return lastText;
  } catch (err: any) {
    if (err && typeof err === 'object') err.lastText = lastText;
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

  const dryRun = Boolean((plan.metadata as any)?.dry_run);
  const triggerPayload = ((plan.metadata as any)?.trigger_payload || {}) as Record<string, unknown>;
  const steps = Array.isArray(plan.steps) ? [...plan.steps] : [];
  steps.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));

  await supabaseAdmin
    .from('instance_plans')
    .update({ status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', runPlanId);
  await supabaseAdmin
    .from('workflow_runs')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('run_plan_id', runPlanId);

  const previousOutputs: Record<string, unknown> = {};
  let sandboxId: string | null = null;
  let sandboxTools: unknown[] = [];
  let anyFailed = false;
  let completed = 0;

  try {
    for (const step of steps) {
      if (step.status === 'completed' || step.status === 'cancelled') continue;

      const maxRetries = resolveMaxRetries(step.max_retries);
      if (step.status === 'failed' && !canRetryStep(step.retry_count || 0, maxRetries)) {
        anyFailed = true;
        break;
      }

      const needsSandbox = Boolean(step.requires_sandbox || step.metadata?.requires_sandbox);
      if (needsSandbox && !sandboxId) {
        const ensured = await ensureWorkflowSandbox({
          templatePlanId: plan.parent_plan_id,
          title: plan.title,
        });
        sandboxId = ensured.sandboxId;
        sandboxTools = ensured.tools;
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
        });

        const context = await prepareAssistantContext(
          plan.instance_id,
          `Execute step ${step.order}: ${step.title}`,
          plan.site_id,
          plan.user_id,
          needsSandbox ? sandboxTools : [],
          false,
          systemPrompt,
        );
        context.executionOptions.plan_id = plan.id;
        context.executionOptions.step_id = step.id;

        const modeLabel = dryRun ? 'DRY RUN' : 'LIVE';
        const userContent = isRetry
          ? `[${modeLabel}] Execute step ${step.order}: ${step.title}. This is retry ${step.retry_count}; follow the recovery plan if provided.`
          : `[${modeLabel}] Execute step ${step.order}: ${step.title}. ${step.instructions}`;

        try {
          const lastText = await runStepTurns(context, userContent);
          const isCondition = step.type === 'condition';
          const verdict = lastText.toLowerCase();
          const skipped = isCondition && (verdict.includes('skip') || verdict.includes('"pass": false'));

          await persistStepPatch(plan, {
            id: step.id,
            status: skipped ? 'cancelled' : 'completed',
            actual_output: lastText,
            completed_at: new Date().toISOString(),
            error_message: null,
          });
          previousOutputs[String(step.order)] = { output: lastText, title: step.title };
          previousOutputs[`step_${step.order}`] = lastText;
          if (!skipped) completed++;
          stepSucceeded = true;
        } catch (err: any) {
          const nextCount = (step.retry_count || 0) + 1;
          const errorMessage = err?.message || String(err);
          const lastText = typeof err?.lastText === 'string' ? err.lastText : (step.actual_output || '');
          step.retry_count = nextCount;
          step.error_message = errorMessage;
          step.actual_output = lastText || step.actual_output;
          await persistStepPatch(plan, {
            id: step.id,
            status: 'failed',
            error_message: errorMessage,
            retry_count: nextCount,
            actual_output: step.actual_output,
            completed_at: new Date().toISOString(),
          });
          if (!canRetryStep(nextCount, maxRetries)) {
            anyFailed = true;
            break;
          }
        }
      }

      if (anyFailed) break;
    }
  } finally {
    if (sandboxId) {
      await stopWorkflowSandbox(sandboxId);
    }
  }

  const finalStatus = anyFailed ? 'failed' : 'completed';
  await supabaseAdmin.from('instance_plans').update({
    status: finalStatus,
    completed_at: new Date().toISOString(),
    steps_completed: completed,
    progress_percentage: steps.length ? Math.round((completed / steps.length) * 100) : 100,
    updated_at: new Date().toISOString(),
  }).eq('id', runPlanId);
  await supabaseAdmin.from('workflow_runs').update({
    status: finalStatus,
    updated_at: new Date().toISOString(),
  }).eq('run_plan_id', runPlanId);

  return { run_plan_id: runPlanId, status: finalStatus, steps_completed: completed };
}
