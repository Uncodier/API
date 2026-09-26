import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createWorkflowPlanResultCapture } from './plan-result';
import { buildWorkflowStepPrompt } from './step-prompt';
import { workflowStepRequiresBrowser } from './browser';
import { shouldRunWorkflowStep, workflowRelationPrompt } from './relation-routing';
import { parseWorkflowExpectedOutputContract } from './result-shape';
import { loadBoundChannelMessageRun, type ChannelMessageRunStatus } from './channel-message';
import { boundedChannelModelTurn, ChannelModelTurnError } from './bounded-channel-model';
import { channelStepRetryContext, channelStepRetryCount, recordChannelStepFailure } from './bounded-channel-retry';

export { boundedChannelModelTurn } from './bounded-channel-model';
const CLAIM_LEASE_SECONDS = 240;

type Step = Record<string, any>;

async function persistPlan(id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabaseAdmin.from('instance_plans').update({
    ...patch, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'in_progress').select('id').maybeSingle();
  if (error || !data) throw new Error('Channel message plan update lost its claim');
}

async function claim(id: string): Promise<string | null> {
  const token = randomUUID();
  const { data, error } = await supabaseAdmin.rpc('claim_workflow_run_execution', {
    p_run_plan_id: id, p_claim_token: token, p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (error) throw error;
  if (data?.state === 'busy') return null;
  if (data?.state !== 'claimed') throw new Error('Invalid workflow execution claim');
  return token;
}

async function renew(id: string, token: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('renew_workflow_run_execution_claim', {
    p_run_plan_id: id, p_claim_token: token, p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (error || data !== true) throw new Error('Channel message execution claim was lost');
}

async function finish(id: string, token: string, status: 'pending' | 'completed' | 'failed', message?: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('finish_workflow_run_execution', {
    p_run_plan_id: id, p_claim_token: token, p_status: status, p_error_message: message || null,
  });
  if (error || data !== true) throw new Error('Failed to finalize channel message claim');
}

/** At most one model turn per request, with durable pre-call step marking. */
export async function advanceBoundedChannelMessageRun(input: {
  siteId: string; messageId: string; runPlanId: string;
}): Promise<ChannelMessageRunStatus | 'forbidden'> {
  const bound = await loadBoundChannelMessageRun(input);
  if (!bound) return 'forbidden';
  if (bound.run.status === 'completed' && bound.plan.status === 'completed') return 'completed';
  if (['failed', 'cancelled'].includes(bound.run.status) || ['failed', 'cancelled'].includes(bound.plan.status)) return 'failed';
  const token = await claim(input.runPlanId);
  if (!token) return 'already_running';
  let claimOwned = true;
  try {
    // The snapshot obtained before claim may be stale after another worker
    // completed. Always re-read the canonical state after acquiring the lease.
    const current = await loadBoundChannelMessageRun(input);
    if (!current) throw new Error('Channel message run no longer matches its trigger');
    const { plan } = current;
    if (current.run.status === 'completed' || current.run.status === 'failed' ||
      current.run.status === 'cancelled') {
      // An expired claim cannot be reacquired after a terminal run; only a
      // pending or in_progress run can enter this branch.
      throw new Error('Channel message run changed status during claim');
    }
    const steps: Step[] = Array.isArray(plan.steps) ? plan.steps : [];
    steps.sort((a, b) => (a.order || 0) - (b.order || 0));
    // A terminal plan with an expired claim may have committed its plan state
    // before the worker died during the claim RPC. Reconcile without a model call.
    if (plan.status === 'completed' || plan.status === 'failed') {
      await finish(input.runPlanId, token, plan.status);
      claimOwned = false;
      return plan.status;
    }
    if (plan.status === 'pending') {
      const { data, error } = await supabaseAdmin.from('instance_plans').update({
        status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', input.runPlanId).eq('status', 'pending').select('id').maybeSingle();
      if (error || !data) throw new Error('Channel message plan was already started');
    } else if (plan.status !== 'in_progress') {
      throw new Error('Channel message plan has invalid status');
    }

    // An in_progress step implies an interrupted/expired call; never invoke
    // the provider again, even if the previous response may not have persisted.
    let finalStatus: 'pending' | 'completed' | 'failed' = 'pending';
    let hardFailure = false;
    const interrupted = steps.find((step) => step.status === 'in_progress');
    const next = steps.find((step) => step.status === 'pending' && shouldRunWorkflowStep(step, steps));
    if (interrupted) {
      interrupted.status = 'failed';
      interrupted.error_message = 'Previous model turn ended without a durable result';
      interrupted.completed_at = new Date().toISOString();
      finalStatus = 'failed';
      hardFailure = true;
    } else if (next) {
      if (!shouldRunWorkflowStep(next, steps)) {
        next.status = 'cancelled';
        next.completed_at = new Date().toISOString();
      } else if (workflowStepRequiresBrowser(next) || next.requires_sandbox || next.metadata?.requires_sandbox) {
        next.status = 'failed';
        next.error_message = 'Sandbox/browser execution is forbidden for channel message guidance';
        next.completed_at = new Date().toISOString();
        finalStatus = 'failed';
        hardFailure = true;
      } else {
        next.status = 'in_progress';
        next.started_at = new Date().toISOString();
        next.completed_at = null;
        await renew(input.runPlanId, token);
        await persistPlan(input.runPlanId, { steps });
        try {
          const triggerPayload = plan.metadata.trigger_payload || {};
          const previousOutputs: Record<string, unknown> = {};
          for (const previous of steps) {
            if (previous === next) break;
            previousOutputs[String(previous.order)] = {
              output: previous.result?.data ?? previous.actual_output ?? null,
              summary: previous.result?.summary || previous.actual_output || '',
              status: previous.status, title: previous.title,
            };
            previousOutputs[`step_${previous.order}`] = previous.result?.data ?? previous.actual_output ?? null;
          }
          next.expected_output = parseWorkflowExpectedOutputContract(next.expected_output, next).suggestion || next.expected_output;
          const capture = createWorkflowPlanResultCapture(next, { requireToolExecution: false,
            requiresBrowser: false, requiredToolExecutions: [] });
          const prompt = buildWorkflowStepPrompt({ plan, step: next, dryRun: false,
            triggerPayload, previousOutputs,
            instanceId: plan.instance_id, siteId: plan.site_id,
            retryContext: channelStepRetryContext(next, triggerPayload, previousOutputs),
            preResponseOnly: true, relationPrompt: workflowRelationPrompt(next, steps) });
          const result = await boundedChannelModelTurn({ prompt, capture,
            billing: { siteId: plan.site_id, instanceId: plan.instance_id, runPlanId: plan.id,
              stepId: next.id, messageId: input.messageId, attempt: channelStepRetryCount(next) + 1 },
            beforeProvider: () => renew(input.runPlanId, token),
            userContent: `[CHANNEL GUIDANCE — NO SENDS] Execute step ${next.order}: ${next.title}. ` +
              (channelStepRetryCount(next) ? `This is retry ${next.retry_count}; follow the recovery plan if provided.`
                : next.instructions || '') });
          next.result = { ...result, turns: 1 };
          next.actual_output = Object.keys(result.data).length ? JSON.stringify(result.data) : result.summary;
          if (result.status === 'failed') {
            recordChannelStepFailure(next, result.error?.message || result.summary, result.error?.retryable !== false);
          } else {
            next.status = result.status === 'skipped' ? 'cancelled' : 'completed';
            next.error_message = null;
            next.completed_at = new Date().toISOString();
          }
        } catch (error) {
          const knownError = error instanceof ChannelModelTurnError;
          recordChannelStepFailure(next, error instanceof Error ? error.message : 'Model turn failed',
            knownError && error.retryable);
          hardFailure = !knownError || error.terminalRun;
        }
      }
    }
    const failed = steps.filter((step) => step.status === 'failed');
    const unhandledFailure = failed.some((step) => !step.metadata?.node_id || !steps.some((candidate) =>
      candidate.metadata?.parent_node_id === step.metadata.node_id && shouldRunWorkflowStep(candidate, steps)));
    if (hardFailure || unhandledFailure) finalStatus = 'failed';
    else if (steps.some((step) => step.status === 'pending' && shouldRunWorkflowStep(step, steps))) {
      finalStatus = 'pending';
    } else {
      for (const step of steps) {
        if (step.status === 'pending') {
          step.status = 'cancelled';
          step.completed_at = new Date().toISOString();
        }
      }
      finalStatus = 'completed';
    }
    if (finalStatus !== 'pending') {
      for (const step of steps) {
        if (step.status === 'pending') {
          step.status = 'cancelled';
          step.completed_at = new Date().toISOString();
        }
      }
    }
    await renew(input.runPlanId, token);
    await persistPlan(input.runPlanId, {
      steps, steps_completed: steps.filter((step) => step.status === 'completed').length,
      progress_percentage: steps.length ? Math.round(100 * steps.filter((step) => step.status === 'completed').length / steps.length) : 100,
      ...(finalStatus !== 'pending' ? { status: finalStatus, completed_at: new Date().toISOString() } : {}),
    });
    await finish(input.runPlanId, token, finalStatus);
    claimOwned = false;
    return finalStatus === 'pending' ? 'in_progress' : finalStatus;
  } catch (error) {
    // Fail closed: a partially completed turn must never be silently replayed.
    if (claimOwned) {
      try {
        await renew(input.runPlanId, token);
        await persistPlan(input.runPlanId, { status: 'failed', completed_at: new Date().toISOString() });
        await finish(input.runPlanId, token, 'failed', error instanceof Error ? error.message.slice(0, 500) : 'Run failed');
      } catch (finishError) {
        console.error('[ChannelMessageWorkflow] Unable to finalize failed run:', finishError);
      }
    }
    throw error;
  }
}