import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';
import { resolveBacklogContextForInstance } from '@/lib/services/requirement-backlog';
import {
  activeRequirementPlanError,
  getBlockingActivePlans,
  shouldProtectRequirementPlanCreation,
} from '../requirement-plan-lock';
import { z } from 'zod';
import {
  assertCompatiblePlanStepAssignment,
  assertKnownPlanStepSkill,
  assertResearchStepAllowedForPhase,
  isResearchPlanStep,
  normalizePlanStepContract,
} from '@/lib/services/instance-plan-step-contract';
import { SkillsService } from '@/lib/services/skills-service';

const parseIfString = (val: any) => typeof val === 'string' ? (() => { try { return JSON.parse(val); } catch { return val; } })() : val;

const ValidationTargetSchema = z.object({
  kind: z.enum(['page', 'api']),
  path: z.string().startsWith('/'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  expected_statuses: z.array(z.number().int().min(100).max(599)).optional(),
  payload: z.unknown().optional(),
  auth_required: z.boolean().optional(),
});

const CreateInstancePlanSchema = z.object({
  instance_id: z.string().uuid('Invalid instance_id'),
  title: z.string().optional().default('Agent Generated Plan'),
  description: z.string().optional(),
  plan_type: z.enum(['objective', 'task']).optional().default('objective'),
  instructions: z.string().optional(),
  expected_output: z.string().optional(),
  success_criteria: z.preprocess(parseIfString, z.array(z.any())).optional().default([]),
  validation_rules: z.preprocess(parseIfString, z.array(z.any())).optional().default([]),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid('User ID is required'),
  requirement_id: z.string().uuid('Invalid requirement_id').optional(),
  agent_id: z.string().uuid('Invalid agent_id').optional(),
  steps: z.preprocess(parseIfString, z.array(z.preprocess(parseIfString, z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().int().optional(),
    status: z.literal('pending').optional(),
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
    validation_targets: z.preprocess(
      parseIfString,
      z.array(ValidationTargetSchema),
    ).optional(),
    /** Free-form metadata. The orchestrator MUST set
     * `metadata.backlog_item_id` so the post-gate Judge can attribute the
     * step to a backlog item. When missing, the server auto-binds it to
     * the unique `in_progress` item of the requirement (if any). */
    metadata: z.preprocess(parseIfString, z.record(z.any())).optional(),
    backlog_item_id: z.string().optional(),
  })))).optional(),
  is_template: z.boolean().optional().default(false),
  triggers: z.preprocess(parseIfString, z.array(z.any())).optional().default([]),
});

/**
 * Core function to create an instance plan
 */
export async function createInstancePlanCore(params: any) {
  const validatedData = CreateInstancePlanSchema.parse(params);

  // Verificar que la instancia existe y pertenece al sitio
  console.log(`[CreateInstancePlan] Verifying instance: "${validatedData.instance_id}" for site: "${validatedData.site_id}"`);
    
  // Check in remote_instances first
  let instanceResult = await supabaseAdmin
    .from('remote_instances')
    .select('site_id')
    .eq('id', validatedData.instance_id)
    .single();

  // Fallback to robot_instances if not found
  if (instanceResult.error || !instanceResult.data) {
     console.log(`[CreateInstancePlan] Not found in remote_instances, checking robot_instances...`);
     instanceResult = await supabaseAdmin
      .from('robot_instances')
      .select('site_id')
      .eq('id', validatedData.instance_id)
      .single();
  }

  const { data: instance, error: instanceError } = instanceResult;

  if (instanceError) {
    console.error(`[CreateInstancePlan] Error verifying instance: ${instanceError?.message}`, instanceError);
  } else {
    console.log(`[CreateInstancePlan] Instance found:`, instance);
  }

  if (!instance) {
    console.error(`[CreateInstancePlan] Instance not found (data is null/undefined): ${validatedData.instance_id}`);
  }

  if (instanceError || !instance) {
    throw new Error(`Instance not found: ${instanceError?.message || 'No data returned'} (ID: ${validatedData.instance_id})`);
  }

  if (instance.site_id !== validatedData.site_id) {
    throw new Error('La instancia no pertenece a este sitio');
  }

  const fallbackBacklogCtx = await resolveBacklogContextForInstance(
    validatedData.instance_id,
  );
  const effectiveRequirementId =
    validatedData.requirement_id ||
    (!validatedData.is_template
      ? fallbackBacklogCtx.requirementId || undefined
      : undefined);
  const protectRequirementPlan = shouldProtectRequirementPlanCreation({
    requirementId: effectiveRequirementId,
    isTemplate: validatedData.is_template,
  });
  if (protectRequirementPlan) {
    const [activePlan] = await getBlockingActivePlans({
      instanceId: validatedData.instance_id,
      requirementId: validatedData.requirement_id,
    });
    if (activePlan) {
      throw activeRequirementPlanError(effectiveRequirementId!, activePlan);
    }
  }

  // Prepare steps if provided
  let planSteps: any[] = [];
  
  // Anti-loop Guard: Reject empty plans if there is still outstanding work
  const fallbackMatchesRequirement =
    !effectiveRequirementId ||
    fallbackBacklogCtx.requirementId === effectiveRequirementId;
  const fallbackBacklogItemId = fallbackMatchesRequirement
    ? fallbackBacklogCtx.inProgressItemId
    : null;
  if (
    effectiveRequirementId &&
    fallbackBacklogCtx.requirementId &&
    !fallbackMatchesRequirement
  ) {
    console.warn(
      `[CreateInstancePlan] Ignoring cross-requirement backlog fallback ` +
        `${fallbackBacklogCtx.requirementId}; expected ${effectiveRequirementId}`,
    );
  }
  
  if (!validatedData.steps || validatedData.steps.length === 0) {
    const backlogRequirementId =
      effectiveRequirementId || fallbackBacklogCtx.requirementId;
    if (backlogRequirementId) {
      const { hasOutstandingWork } = await import('@/lib/services/requirement-backlog');
      const { loadRequirement, toBacklog } = await import('@/lib/services/requirement-backlog-store');
      const req = await loadRequirement(backlogRequirementId);
      if (req) {
        // We do a cheap check for pending work
        const b = toBacklog(req.backlog, 'default');
        const hasPending = hasOutstandingWork(b.items);
        if (hasPending) {
           throw new Error(
             `Empty plans are not allowed while there is outstanding backlog work. ` +
             `Provide steps as a proper JSON array. The array-serialization issue is fixed; if a step fails to serialize, retry with a smaller array or simpler structure. Do NOT create placeholder or empty plans.`
           );
        }
      }
    }
  }

  if (validatedData.steps && validatedData.steps.length > 0) {
    // Deduplicate steps by title or instructions to prevent LLM hallucinations from repeating steps
    const uniqueSteps: any[] = [];
    const contractSources = new Map<any, any>();
    const seenTitles = new Set<string>();
    
    validatedData.steps.forEach((step, idx) => {
      if (!step.title) {
        console.error(`[CreateInstancePlan] Step ${idx} missing title. Raw step:`, JSON.stringify(step));
        throw new Error(`Step at index ${idx} is missing a 'title'. Please provide a descriptive title. Raw step keys provided: ${Object.keys(step).join(', ')}`);
      }

      const genericTitleRegex = /^step\s*\d+$/i;
      if (genericTitleRegex.test(step.title.trim())) {
        throw new Error(`Step title '${step.title}' is too generic. DO NOT use generic names like "Step 1". Provide a descriptive title (e.g. "Frontend UI - Dashboard").`);
      }

      const title = step.title;
      
      if (!seenTitles.has(title)) {
        seenTitles.add(title);
        const normalized = normalizePlanStepContract(step);
        uniqueSteps.push(normalized);
        contractSources.set(normalized, step);
      }
    });

    if (effectiveRequirementId && !validatedData.is_template) {
      for (const step of uniqueSteps) {
        assertCompatiblePlanStepAssignment(step);
        assertKnownPlanStepSkill(
          step,
          (skill) => !!SkillsService.getSkillBySlugOrName(skill),
        );
      }
    }

    if (
      effectiveRequirementId &&
      uniqueSteps.some(isResearchPlanStep)
    ) {
      const { loadRequirement, toBacklog } = await import(
        '@/lib/services/requirement-backlog-store'
      );
      const requirement = await loadRequirement(effectiveRequirementId);
      const backlog = requirement
        ? toBacklog(requirement.backlog, 'default')
        : null;
      for (const step of uniqueSteps) {
        const stepBacklogItemId =
          step.backlog_item_id ||
          step.metadata?.backlog_item_id ||
          fallbackBacklogItemId;
        const activeItem = backlog?.items.find(
          (item: any) => item.id === stepBacklogItemId,
        );
        assertResearchStepAllowedForPhase(
          step,
          activeItem?.phase_id,
          contractSources.get(step),
        );
      }
    }

    // Auto-bind `metadata.backlog_item_id` for steps that didn't carry one.
    // The post-gate Judge skips items it can't link to a step, which used to
    // leave items eternally `in_progress`. Resolving the unique in-progress
    // item once per plan (cheap) covers the common WIP=1 case.
    if (fallbackBacklogItemId) {
      console.log(`[CreateInstancePlan] Auto-bind candidate: backlog_item_id=${fallbackBacklogItemId} (req=${fallbackBacklogCtx.requirementId})`);
    }

    planSteps = uniqueSteps.map((step, index) => {
      const explicitItemId =
        (step as any).backlog_item_id ||
        (step as any).metadata?.backlog_item_id ||
        null;
      const resolvedItemId = explicitItemId || fallbackBacklogItemId || null;
      const stepMetadata = {
        ...((step as any).metadata ?? {}),
        ...(resolvedItemId ? { backlog_item_id: resolvedItemId } : {}),
        ...(step.protected_routes?.length
          ? { protected_routes: step.protected_routes }
          : {}),
        ...(step.validation_targets?.length
          ? { validation_targets: step.validation_targets }
          : {}),
      };
      if (!explicitItemId && resolvedItemId) {
        console.log(`[CreateInstancePlan] step #${index + 1} "${step.title}" auto-bound to backlog_item_id=${resolvedItemId}`);
      } else if (!resolvedItemId) {
        console.warn(`[CreateInstancePlan] step #${index + 1} "${step.title}" has NO backlog_item_id (orchestrator omitted it and no unique in_progress item to bind). A requirement final gate will reject completion until the item is bound.`);
      }
      return {
        id: `step_${index + 1}`,
        title: step.title,
        description: step.description || step.title,
        order: step.order ?? index + 1,
        status: 'pending',
        type: step.type || 'task',
        instructions: step.instructions || step.description || step.title,
        expected_output: step.expected_output || '',
        success_criteria: step.success_criteria || [],
        validation_rules: step.validation_rules || [],
        actual_output: null,
        started_at: null,
        completed_at: null,
        retry_count: 0,
        error_message: null,
        artifacts: [],
        role: step.role || null,
        skill: step.skill || null,
        test_command: step.test_command || null,
        metadata: stepMetadata,
      };
    });
  }

  const planData = {
    instance_id: validatedData.instance_id,
    title: validatedData.title,
    description: validatedData.description || 'Plan created by agent',
    plan_type: validatedData.plan_type,
    instructions: validatedData.instructions,
    expected_output: validatedData.expected_output,
    success_criteria: validatedData.success_criteria,
    validation_rules: validatedData.validation_rules,
    status: validatedData.is_template ? 'blocked' : 'pending',
    site_id: validatedData.site_id,
    user_id: validatedData.user_id,
    agent_id: validatedData.agent_id,
    steps_total: planSteps.length,
    steps_completed: 0,
    progress_percentage: 0,
    steps: planSteps,
    metadata: {
      ...(validatedData.is_template ? { workflow_template: true } : {}),
      ...(effectiveRequirementId
        ? { requirement_id: effectiveRequirementId }
        : {}),
    },
  };

  const { data: newPlan, error } = await supabaseAdmin
    .from('instance_plans')
    .insert(planData)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create plan: ${error.message}`);
  }

  // Requirement-bound plans never replace active work. Re-check after insert
  // to catch a concurrent create and remove this unstarted conflicting row.
  // Generic instance plans retain their historical replacement semantics:
  // insert the replacement first, then close only older rows.
  let supersededPlanErrors: string[] = [];
  if (protectRequirementPlan) {
    const contenders = await getBlockingActivePlans({
      instanceId: validatedData.instance_id,
      requirementId: validatedData.requirement_id,
    });
    const winningPlan = contenders[0];
    if (winningPlan && winningPlan.id !== newPlan.id) {
      const { error: cleanupError } = await supabaseAdmin
        .from('instance_plans')
        .delete()
        .eq('id', newPlan.id);
      if (cleanupError) {
        console.error(
          `[CreateInstancePlan] Failed to remove conflicting new plan ${newPlan.id}:`,
          cleanupError,
        );
      }
      throw activeRequirementPlanError(
        effectiveRequirementId!,
        winningPlan,
      );
    }
  } else if (!validatedData.is_template) {
    const closure = await completeInProgressPlans(
      validatedData.instance_id,
      `Superseded by plan ${newPlan.id}`,
      {
        excludePlanId: newPlan.id,
        createdBefore: newPlan.created_at,
      },
    );
    supersededPlanErrors = closure.errors;
    if (!closure.success) {
      console.warn(
        `[CreateInstancePlan] New plan ${newPlan.id} was created, but some older plans could not be closed:`,
        closure.errors,
      );
    }
  }

  // Si es un template y tiene triggers, insertarlos
  if (validatedData.is_template && validatedData.triggers && validatedData.triggers.length > 0) {
    const triggersToInsert = validatedData.triggers.map((t: any) => ({
      instance_id: validatedData.instance_id,
      template_plan_id: newPlan.id,
      kind: t.kind,
      config: t,
      enabled: true,
      site_id: validatedData.site_id,
      user_id: validatedData.user_id
    }));
    
    const { error: triggerError } = await supabaseAdmin
      .from('workflow_triggers')
      .insert(triggersToInsert);
      
    if (triggerError) {
      console.error(`[CreateInstancePlan] Error creating triggers for template ${newPlan.id}:`, triggerError);
      // Fallamos toda la creación para que el agente sepa que los triggers no se crearon.
      // Primero limpiamos el plan que se insertó incompleto.
      await supabaseAdmin.from('instance_plans').delete().eq('id', newPlan.id);
      throw new Error(`Failed to create workflow triggers: ${triggerError.message}`);
    }
  }

  return {
    success: true,
    data: newPlan,
    ...(supersededPlanErrors.length > 0
      ? { warnings: { superseded_plans: supersededPlanErrors } }
      : {}),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstancePlanCore(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[CreateInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    const status = errorMessage === 'Instance not found' ? 404 : (errorMessage === 'La instancia no pertenece a este sitio' ? 403 : 500);
    return NextResponse.json({ success: false, error: errorMessage }, { status });
  }
}
