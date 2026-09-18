import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveBacklogContextForInstance } from '@/lib/services/requirement-backlog';
import { summarizePlanSteps } from '@/lib/helpers/plan-status';
import {
  assertCompatiblePlanStepAssignment,
  assertKnownPlanStepSkill,
  assertResearchStepAllowedForPhase,
  normalizePlanStepContract,
} from '@/lib/services/instance-plan-step-contract';
import { assertRequirementPlanUpdateAllowed } from '../requirement-plan-lock';
import { SkillsService } from '@/lib/services/skills-service';
import { z } from 'zod';

const parseIfString = (val: any) => typeof val === 'string' ? (() => { try { return JSON.parse(val); } catch { return val; } })() : val;

const UpdateInstancePlanSchema = z.object({
  plan_id: z.string().uuid('Invalid plan_id'),
  instance_id: z.string().uuid('Invalid instance_id').optional(), // Added for execute_step in protocol
  requirement_id: z.string().uuid('Invalid requirement_id').optional(),
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  plan_type: z.enum(['objective', 'task']).optional(),
  instructions: z.string().optional(),
  expected_output: z.string().optional(),
  success_criteria: z.preprocess(parseIfString, z.array(z.any())).optional(),
  validation_rules: z.preprocess(parseIfString, z.array(z.any())).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled', 'paused', 'in_progress']).optional(),
  steps: z.preprocess(parseIfString, z.array(z.preprocess(parseIfString, z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().int().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
    type: z.string().optional(),
    instructions: z.string().optional(),
    expected_output: z.string().optional(),
    success_criteria: z.preprocess(parseIfString, z.array(z.any())).optional(),
    validation_rules: z.preprocess(parseIfString, z.array(z.any())).optional(),
    actual_output: z.string().optional().nullable(),
    started_at: z.string().datetime().optional().nullable(),
    completed_at: z.string().datetime().optional().nullable(),
    duration_seconds: z.number().optional().nullable(),
    retry_count: z.number().int().optional(),
    error_message: z.string().optional().nullable(),
    artifacts: z.preprocess(parseIfString, z.array(z.any())).optional().nullable(),
    role: z.string().optional(),
    skill: z.string().optional(),
    test_command: z.string().optional(),
    protected_routes: z.preprocess(parseIfString, z.array(z.string())).optional(),
    /** Set when sandbox_push_checkpoint was invoked during cron executor runs */
    checkpoint_tool_invoked_at: z.string().optional().nullable(),
    checkpoint_tool_calls: z.number().int().optional(),
    vercel_preview_url: z.string().optional().nullable(),
    vercel_deploy_state: z.string().optional().nullable(),
    vercel_deploy_checked_at: z.string().optional().nullable(),
    vercel_deploy_detail: z.string().optional().nullable(),
    /** Free-form metadata; `backlog_item_id` links the step to a backlog
     * item so the post-gate Judge can run for it. Auto-bound only when a
     * requirement_id is supplied and matches the instance backlog context. */
    metadata: z.preprocess(parseIfString, z.record(z.any())).optional(),
    backlog_item_id: z.string().optional(),
  })))).optional(),
  progress_percentage: z.number().min(0).max(100).optional(),
});

/**
 * Core function to update an instance plan
 */
export async function updateInstancePlanCore(
  params: any,
  options: { trustedRunner?: boolean } = {},
) {
  const validatedData = UpdateInstancePlanSchema.parse(params);
  const {
    plan_id,
    site_id,
    instance_id,
    requirement_id,
    ...updates
  } = validatedData;

  // Verificar que el plan existe y pertenece al sitio
  const { data: existingPlan, error: fetchError } = await supabaseAdmin
    .from('instance_plans')
    .select('site_id, steps, status, instance_id, metadata, updated_at')
    .eq('id', plan_id)
    .single();

  if (fetchError || !existingPlan) {
    throw new Error('Plan not found');
  }

  if (existingPlan.site_id !== site_id) {
    throw new Error('No tienes permiso para actualizar este plan');
  }
  if (instance_id && instance_id !== existingPlan.instance_id) {
    throw new Error('Plan does not belong to the provided instance');
  }

  if (Object.keys(updates).length === 0 && !updates.steps) {
    return { success: true, message: 'No updates provided' };
  }

  const updateData: any = { ...updates, updated_at: new Date().toISOString() };
  const storedRequirementId =
    typeof existingPlan.metadata?.requirement_id === 'string'
      ? existingPlan.metadata.requirement_id
      : undefined;
  if (
    requirement_id &&
    storedRequirementId &&
    requirement_id !== storedRequirementId
  ) {
    throw new Error(
      `Plan ${plan_id} belongs to requirement ${storedRequirementId}, not ${requirement_id}.`,
    );
  }
  const effectiveInstanceId = existingPlan.instance_id;
  const fallbackCtx =
    !existingPlan.metadata?.workflow_template && effectiveInstanceId
      ? await resolveBacklogContextForInstance(effectiveInstanceId)
      : { requirementId: null, inProgressItemId: null };
  const effectiveRequirementId =
    storedRequirementId ||
    requirement_id ||
    fallbackCtx.requirementId ||
    undefined;
  if (
    requirement_id &&
    fallbackCtx.requirementId &&
    requirement_id !== fallbackCtx.requirementId
  ) {
    throw new Error(
      `Instance ${effectiveInstanceId} is bound to requirement ` +
        `${fallbackCtx.requirementId}, not ${requirement_id}.`,
    );
  }
  if (!options.trustedRunner) {
    assertRequirementPlanUpdateAllowed({
      requirementId: effectiveRequirementId,
      status: updates.status,
      steps: updates.steps,
    });
  }
  if (
    effectiveRequirementId &&
    existingPlan.status === 'completed' &&
    Object.keys(updates).some((key) => key !== 'updated_at')
  ) {
    throw new Error(
      `Requirement ${effectiveRequirementId} plan ${plan_id} is completed and immutable.`,
    );
  }

  if (updates.steps) {
    // Resolve a fallback once per update, but never bind across requirements.
    const fallbackBacklogItemId =
      effectiveRequirementId &&
      fallbackCtx.requirementId === effectiveRequirementId
        ? fallbackCtx.inProgressItemId
        : null;
    if (
      effectiveRequirementId &&
      fallbackCtx.requirementId &&
      fallbackCtx.requirementId !== effectiveRequirementId
    ) {
      console.warn(
        `[UpdateInstancePlan] Ignoring cross-requirement backlog fallback ${fallbackCtx.requirementId}; expected ${effectiveRequirementId}`,
      );
    }

    const backlogPhaseByItemId = new Map<string, string>();
    if (effectiveRequirementId) {
      const { loadRequirement, toBacklog } = await import(
        '@/lib/services/requirement-backlog-store'
      );
      const requirement = await loadRequirement(effectiveRequirementId);
      const backlog = requirement
        ? toBacklog(requirement.backlog, 'default')
        : null;
      for (const item of backlog?.items || []) {
        if (item.id && item.phase_id) {
          backlogPhaseByItemId.set(item.id, item.phase_id);
        }
      }
    }

    const mergeMetadata = (currentStep: any, incomingStep: any): Record<string, any> => {
      const baseMetadata = {
        ...((currentStep && currentStep.metadata) || {}),
        ...((incomingStep && incomingStep.metadata) || {}),
      };
      const explicitItemId =
        (incomingStep && incomingStep.backlog_item_id) ||
        (incomingStep && incomingStep.metadata && incomingStep.metadata.backlog_item_id) ||
        baseMetadata.backlog_item_id ||
        null;
      const resolvedItemId = explicitItemId || fallbackBacklogItemId || null;
      if (!explicitItemId && resolvedItemId) {
        console.log(`[UpdateInstancePlan] step "${incomingStep?.title || currentStep?.title}" auto-bound to backlog_item_id=${resolvedItemId}`);
      }
      if (resolvedItemId) baseMetadata.backlog_item_id = resolvedItemId;
      return baseMetadata;
    };

    // Status downgrade guard. An incoming partial-update can otherwise reset
    // a `completed` step back to `pending`/`in_progress` and trigger
    // re-execution. This bug bit us when:
    //   1. The orchestrator (LLM) re-sends the existing steps array with
    //      `status: 'pending'` because it thinks it's "redeclaring" the plan.
    //   2. The cron's stale-snapshot retry path calls
    //      `updateInstancePlanCore({ status: 'in_progress' })` for a step
    //      that finished in a previous workflow attempt.
    // Rule: once a step is `completed` or `cancelled` it is sticky. Only
    // explicit retry paths that bump `retry_count` are allowed to demote a
    // `failed` step back to `pending`.
    const isTerminalSticky = (s: string | undefined) => s === 'completed' || s === 'cancelled';
    const changesStepDefinition = (step: any): boolean =>
      [
        'title',
        'description',
        'type',
        'instructions',
        'expected_output',
        'success_criteria',
        'validation_rules',
        'role',
        'skill',
        'test_command',
        'metadata',
        'backlog_item_id',
      ].some((key) => Object.prototype.hasOwnProperty.call(step, key));
    const normalizeAndValidateStep = (
      step: any,
      contractSource: any = step,
    ): any => {
      const normalized = normalizePlanStepContract(step);
      if (effectiveRequirementId) {
        assertCompatiblePlanStepAssignment(normalized);
        assertKnownPlanStepSkill(
          normalized,
          (skill) => !!SkillsService.getSkillBySlugOrName(skill),
        );
      }
      const itemId =
        normalized.backlog_item_id ||
        normalized.metadata?.backlog_item_id ||
        fallbackBacklogItemId;
      assertResearchStepAllowedForPhase(
        normalized,
        itemId ? backlogPhaseByItemId.get(itemId) : undefined,
        contractSource,
      );
      return normalized;
    };
    const safeMergeStatus = (currentStep: any, incomingStep: any): {
      status: string | undefined;
      completed_at: string | null | undefined;
      actual_output: string | null | undefined;
      ignored: boolean;
    } => {
      let ignored = false;
      let nextStatus = incomingStep.status !== undefined ? incomingStep.status : currentStep.status;
      let nextCompletedAt =
        incomingStep.completed_at !== undefined ? incomingStep.completed_at : currentStep.completed_at;
      let nextActualOutput =
        incomingStep.actual_output !== undefined ? incomingStep.actual_output : currentStep.actual_output;
      if (
        isTerminalSticky(currentStep.status) &&
        incomingStep.status !== undefined &&
        incomingStep.status !== currentStep.status
      ) {
        ignored = true;
        nextStatus = currentStep.status;
        nextCompletedAt = currentStep.completed_at ?? nextCompletedAt;
        nextActualOutput = currentStep.actual_output ?? nextActualOutput;
        console.warn(
          `[UpdateInstancePlan] Refused to demote step "${currentStep.title || currentStep.id}" from "${currentStep.status}" → "${incomingStep.status}". Sticky terminal status preserved.`,
        );
      }
      return { status: nextStatus, completed_at: nextCompletedAt, actual_output: nextActualOutput, ignored };
    };

    const currentSteps = existingPlan.steps || [];
    const updatedSteps = currentSteps.map((currentStep: any) => {
      const incomingStep = updates.steps!.find((s: any) =>
        (s.id && s.id === currentStep.id) ||
        (s.order !== undefined && s.order === currentStep.order)
      );
      if (!incomingStep) return currentStep;
      const safe = safeMergeStatus(currentStep, incomingStep);
      const mergedStep = {
        ...currentStep,
        ...incomingStep,
        status: safe.status,
        completed_at: safe.completed_at,
        actual_output: safe.actual_output,
        id: currentStep.id,
        metadata: mergeMetadata(currentStep, incomingStep),
        updated_at: new Date().toISOString(),
      };
      return changesStepDefinition(incomingStep)
        ? normalizeAndValidateStep(mergedStep, incomingStep)
        : mergedStep;
    });

    // Add new steps that might be in updates.steps but not in currentSteps
    const seenNewTitles = new Set<string>();

    updates.steps!.forEach((incomingStep: any) => {
      if (!currentSteps.some((currentStep: any) =>
        (incomingStep.id && currentStep.id === incomingStep.id) ||
        (incomingStep.order !== undefined && currentStep.order === incomingStep.order)
      )) {
        if (!incomingStep.title) {
          throw new Error(`A new step being added is missing a 'title'. Please provide a descriptive title.`);
        }

        const genericTitleRegex = /^step\s*\d+$/i;
        if (genericTitleRegex.test(incomingStep.title.trim())) {
          throw new Error(`Step title '${incomingStep.title}' is too generic. DO NOT use generic names like "Step 1". Provide a descriptive title.`);
        }

        // Deduplicate new steps by title to prevent LLM hallucinations
        if (incomingStep.title && !seenNewTitles.has(incomingStep.title)) {
          seenNewTitles.add(incomingStep.title);

          updatedSteps.push(normalizeAndValidateStep({
            ...incomingStep,
            id: incomingStep.id || `step_added_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            status: incomingStep.status || 'pending',
            metadata: mergeMetadata(null, incomingStep),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, incomingStep));
        }
      }
    });

    updateData.steps = updatedSteps;
    updateData.steps_total = updatedSteps.length;
    
    const summary = summarizePlanSteps(updatedSteps);
    updateData.steps_completed = summary.completedCount;
    updateData.progress_percentage = summary.progressPercentage;

    if (updates.status === 'completed' && summary.status !== 'completed') {
      throw new Error('Cannot mark a plan completed while one or more steps are unfinished');
    }

    // Auto-reconcile plan status based on steps (only if not explicitly overridden by updates)
    if (
      !updates.status &&
      existingPlan.status !== 'paused' &&
      (existingPlan.status !== 'cancelled' || summary.hasRunnable)
    ) {
      if (summary.status !== 'in_progress') {
        updateData.status = summary.status;
        updateData.completed_at = new Date().toISOString();
      } else if (
        existingPlan.status === 'cancelled' ||
        existingPlan.status === 'pending'
      ) {
        updateData.status = 'in_progress';
        updateData.completed_at = null;
      }
    }
  } else if (updates.status === 'completed') {
    const summary = summarizePlanSteps((existingPlan.steps as any[]) || []);
    if (summary.status !== 'completed') {
      throw new Error('Cannot mark a plan completed while one or more steps are unfinished');
    }
  }

  const { data: updatedPlan, error } = await supabaseAdmin
    .from('instance_plans')
    .update(updateData)
    .eq('id', plan_id)
    .eq('updated_at', existingPlan.updated_at)
    .select()
    .single();

  if (error) {
    if (
      error.code === 'PGRST116' ||
      /0 rows|no rows/i.test(error.message || '')
    ) {
      throw new Error(
        `Plan ${plan_id} changed concurrently; reload it before updating.`,
      );
    }
    throw new Error(`Failed to update plan: ${error.message}`);
  }

  return {
    success: true,
    data: updatedPlan
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await updateInstancePlanCore(body);
    return NextResponse.json(result);

  } catch (error) {
    console.error('[UpdateInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    const status = errorMessage === 'Plan not found' ? 404 : (errorMessage === 'No tienes permiso para actualizar este plan' ? 403 : 500);
    return NextResponse.json({ success: false, error: errorMessage }, { status });
  }
}
