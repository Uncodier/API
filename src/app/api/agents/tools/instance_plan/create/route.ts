import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';
import { z } from 'zod';

const CreateInstancePlanSchema = z.object({
  instance_id: z.string().uuid('Invalid instance_id'),
  title: z.string().optional().default('Agent Generated Plan'),
  description: z.string().optional(),
  plan_type: z.enum(['objective', 'task']).optional().default('objective'),
  instructions: z.string().optional(),
  expected_output: z.string().optional(),
  success_criteria: z.array(z.any()).optional().default([]),
  validation_rules: z.array(z.any()).optional().default([]),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid('User ID is required'),
  agent_id: z.string().uuid('Invalid agent_id').optional(),
  steps: z.array(z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().int().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
    type: z.string().optional(),
    instructions: z.string().optional(),
    expected_output: z.string().optional(),
    success_criteria: z.array(z.any()).optional(),
    validation_rules: z.array(z.any()).optional(),
    actual_output: z.string().optional().nullable(),
    started_at: z.string().datetime().optional().nullable(),
    completed_at: z.string().datetime().optional().nullable(),
    duration_seconds: z.number().optional().nullable(),
    retry_count: z.number().int().optional(),
    error_message: z.string().optional().nullable(),
    artifacts: z.array(z.any()).optional().nullable(),
    role: z.string().optional(),
    skill: z.string().optional(),
    test_command: z.string().optional(),
  })).optional(),
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

  // Complete active plans before creating a new one
  await completeInProgressPlans(validatedData.instance_id, 'New plan created via agent tool');

  // Prepare steps if provided
  let planSteps: any[] = [];
  if (validatedData.steps && validatedData.steps.length > 0) {
    // Deduplicate steps by title or instructions to prevent LLM hallucinations from repeating steps
    const uniqueSteps: any[] = [];
    const seenTitles = new Set<string>();
    
    validatedData.steps.forEach((step, idx) => {
      if (!step.title) {
        throw new Error(`Step at index ${idx} is missing a 'title'. Please provide a descriptive title.`);
      }

      const genericTitleRegex = /^step\s*\d+$/i;
      if (genericTitleRegex.test(step.title.trim())) {
        throw new Error(`Step title '${step.title}' is too generic. DO NOT use generic names like "Step 1". Provide a descriptive title (e.g. "Frontend UI - Dashboard").`);
      }

      const title = step.title;
      
      if (!seenTitles.has(title)) {
        seenTitles.add(title);
        uniqueSteps.push(step);
      }
    });

    planSteps = uniqueSteps.map((step, index) => ({
      id: `step_${index + 1}`,
      title: step.title,
      description: step.description || step.title,
      order: step.order ?? index + 1,
      status: step.status || 'pending',
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
    }));
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
    status: 'pending',
    site_id: validatedData.site_id,
    user_id: validatedData.user_id,
    agent_id: validatedData.agent_id,
    steps_total: planSteps.length,
    steps_completed: 0,
    progress_percentage: 0,
    steps: planSteps
  };

  const { data: newPlan, error } = await supabaseAdmin
    .from('instance_plans')
    .insert(planData)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create plan: ${error.message}`);
  }

  return {
    success: true,
    data: newPlan
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
