import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';

const UpdateInstancePlanSchema = z.object({
  plan_id: z.string().uuid('Invalid plan_id'),
  instance_id: z.string().uuid('Invalid instance_id').optional(), // Added for execute_step in protocol
  site_id: z.string().uuid('Site ID is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  plan_type: z.enum(['objective', 'task']).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled', 'paused', 'in_progress']).optional(),
  steps: z.array(z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().int().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
    type: z.string().optional(),
    instructions: z.string().optional(),
    expected_output: z.string().optional(),
    actual_output: z.string().optional().nullable(),
    started_at: z.string().datetime().optional().nullable(),
    completed_at: z.string().datetime().optional().nullable(),
    duration_seconds: z.number().optional().nullable(),
    retry_count: z.number().int().optional(),
    error_message: z.string().optional().nullable(),
    artifacts: z.array(z.any()).optional().nullable(),
  })).optional(),
  progress_percentage: z.number().min(0).max(100).optional(),
});

/**
 * Core function to update an instance plan
 */
export async function updateInstancePlanCore(params: any) {
  const validatedData = UpdateInstancePlanSchema.parse(params);
  const { plan_id, site_id, instance_id, ...updates } = validatedData;

  // Verificar que el plan existe y pertenece al sitio
  const { data: existingPlan, error: fetchError } = await supabaseAdmin
    .from('instance_plans')
    .select('site_id, steps') // Select steps as well
    .eq('id', plan_id)
    .single();

  if (fetchError || !existingPlan) {
    throw new Error('Plan not found');
  }

  if (existingPlan.site_id !== site_id) {
    throw new Error('No tienes permiso para actualizar este plan');
  }

  if (Object.keys(updates).length === 0 && !updates.steps) {
    return { success: true, message: 'No updates provided' };
  }

  const updateData: any = { ...updates, updated_at: new Date().toISOString() };
  
  if (updates.steps) {
    const currentSteps = existingPlan.steps || [];
    const updatedSteps = currentSteps.map((currentStep: any) => {
      const incomingStep = updates.steps.find((s: any) => s.id === currentStep.id);
      return incomingStep ? { ...currentStep, ...incomingStep, updated_at: new Date().toISOString() } : currentStep;
    });

    // Add new steps that might be in updates.steps but not in currentSteps
    updates.steps.forEach((incomingStep: any) => {
      if (!currentSteps.some((currentStep: any) => currentStep.id === incomingStep.id)) {
        updatedSteps.push({ ...incomingStep, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
    });

    updateData.steps = updatedSteps;
    updateData.steps_total = updatedSteps.length;
    
    const completedSteps = updatedSteps.filter((step: any) => step.status === 'completed').length;
    updateData.steps_completed = completedSteps;
    updateData.progress_percentage = updatedSteps.length > 0 ? (completedSteps / updatedSteps.length) * 100 : 0;
  }

  const { data: updatedPlan, error } = await supabaseAdmin
    .from('instance_plans')
    .update(updateData)
    .eq('id', plan_id)
    .select()
    .single();

  if (error) {
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
