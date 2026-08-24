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

  return `⚠️ WORKFLOW MODE: You are executing ONE predefined workflow step. Do NOT create or update instance_plan or requirements. Do NOT plan new work. Execute this step using MCP tools (tool_lookup) and report the result in plain text.

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

${params.dryRun ? 'DRY RUN: Do not mutate CRM/data or send messages. Read and simulate only.\n' : ''}
${params.step.requires_sandbox || params.step.metadata?.requires_sandbox
    ? 'This step has requires_sandbox=true. sandbox_* tools are available. Do not call sandbox_* on steps without this flag.'
    : 'This step has NO sandbox. Do not call sandbox_* tools.'}
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

        const userContent = isRetry
          ? `Execute step ${step.order}: ${step.title}. This is retry ${step.retry_count}; follow the recovery plan if provided.`
          : `Execute step ${step.order}: ${step.title}. ${step.instructions}`;

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
