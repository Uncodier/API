import { supabaseAdmin } from '@/lib/database/supabase-client';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';
import { formatPlanSteps, addSessionSaveSteps, calculateEstimatedDuration } from '@/lib/helpers/robot-planning-core';
import { admitAssistantRouting } from '@/app/api/robots/instance/assistant/execution-routing';
import { pinPlanRouting } from '@/lib/services/workflow-robot/plan-routing';

// Instance Act Specific Context (builds on the shared planning core)
// Helper function to save complete plan with proper structure
export async function saveCompletePlan(
  instanceId: string,
  planData: any,
  planningCommandUuid: string | null,
  activity: string,
  planDecisionAction: string
): Promise<{ planId: string | null; success: boolean }> {
  try {
    // STEP 1: Complete all in-progress plans FIRST before any other operation
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ STEP 1: Completing existing plans for instance: ${instanceId}`);
    const completionResult = await completeInProgressPlans(instanceId, 'Superseded by a new plan');

    if (!completionResult.success) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Warning: Some plans failed to complete:`, completionResult.errors);
      // Continue anyway but log the warning
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Successfully completed ${completionResult.completedCount} existing plan(s)`);
    }

    // STEP 2: Get instance information
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ STEP 2: Getting instance data for plan creation`);
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id, user_id')
      .eq('id', instanceId)
      .single();

    if (instanceError || !instance) {
      console.error('Error getting instance data for plan creation:', instanceError);
      return { planId: null, success: false };
    }

    // STEP 3: Format plan steps
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ STEP 3: Formatting plan steps`);
    let planSteps = formatPlanSteps(planData);

    // Agregar pasos de guardado de sesión usando el core unificado
    planSteps = addSessionSaveSteps(planSteps);

    const stepsTotal = planSteps.length;

    // STEP 4: Create new plan in database
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ STEP 4: Creating new plan in database`);
    const routing = await admitAssistantRouting(instance.site_id);
    const { data: newPlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        title: `Plan regenerado para actividad: ${activity}`,
        description: `Plan ${planDecisionAction} generado automáticamente`,
        plan_type: 'objective',
        status: 'blocked',
        instance_id: instanceId,
        site_id: instance.site_id,
        user_id: instance.user_id,
      })
      .select()
      .single();

    if (planError) {
      console.error('Error creating new plan:', planError);
      return { planId: null, success: false };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ New plan created with ID: ${newPlan.id}`);

    await pinPlanRouting(newPlan.id, instance.site_id, routing);

    // STEP 5: Update plan with detailed information
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ STEP 5: Updating plan with detailed information`);
    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'pending',
        command_id: planningCommandUuid,
        title: planData.title || `Plan regenerado para actividad: ${activity}`,
        description: planData.description || `Plan ${planDecisionAction} generado automáticamente`,
        steps: planSteps,
        success_criteria: planData.success_metrics || planData.success_criteria || [],
        steps_total: stepsTotal,
        steps_completed: 0,
        progress_percentage: 0,
        estimated_duration_minutes: calculateEstimatedDuration(planData.estimated_timeline || planData.estimated_duration_minutes),
        priority: typeof planData.priority_level === 'string' ? 5 : (planData.priority_level || planData.priority || 5),
      })
      .eq('id', newPlan.id);

    if (updateError) {
      console.error('Error updating plan with results:', updateError);
      return { planId: null, success: false };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Complete plan saved successfully with ID: ${newPlan.id}`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 📊 Summary: Completed ${completionResult.completedCount} old plan(s), created 1 new plan`);
    return { planId: newPlan.id, success: true };

  } catch (error) {
    console.error('Error saving complete plan:', error);
    return { planId: null, success: false };
  }
}
