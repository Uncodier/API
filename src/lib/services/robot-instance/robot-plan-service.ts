import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService } from '@/lib/services/workflow-service';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';

/**
 * Función auxiliar para agregar actividad al plan del robot
 */
export async function addActivityToPlan(
  instance_id: string, 
  userMessage: string, 
  agentResponse: string, 
  instance: any,
  stepStatus: 'completed' | 'failed' | 'in_progress' | 'pending' = 'pending'
): Promise<{ isPlanCompleted: boolean; planId: string | null }> {
  try {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Adding activity to robot plan...`);
    
    // 1. Buscar el plan activo más reciente para esta instancia
    const { data: activePlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instance_id)
      .in('status', ['active', 'pending', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (planError && planError.code !== 'PGRST116') {
      console.error('Error fetching active plan:', planError);
      return { isPlanCompleted: false, planId: null };
    }

    // 2. Si no hay plan activo, crear uno nuevo
    let currentPlan = activePlan;
    if (!activePlan) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No active plan found, creating new plan...`);
      
      // Complete all in-progress plans before creating a new one
      await completeInProgressPlans(instance_id);
      
      const { data: newPlan, error: createError } = await supabaseAdmin
        .from('instance_plans')
        .insert({
          instance_id: instance_id,
          title: 'Robot Activity Log',
          description: 'Automatically generated plan to track robot activities',
          plan_type: 'task',
          status: 'in_progress',
          site_id: instance.site_id,
          user_id: instance.user_id,
          agent_id: instance.agent_id,
          command_id: instance.command_id,
          steps_total: 1,
          steps_completed: 0,
          progress_percentage: 0,
          steps: []
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating new plan:', createError);
        return { isPlanCompleted: false, planId: null };
      }
      
      currentPlan = newPlan;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Created new plan with ID: ${newPlan.id}`);
    }

    // 3. Agregar nuevo step inmediatamente después del último step in_progress/completed
    const currentSteps = currentPlan.steps || [];

    // Encontrar la posición donde insertar el nuevo step
    let insertPosition = 0;
    for (let i = 0; i < currentSteps.length; i++) {
      if (['completed', 'failed', 'in_progress'].includes(currentSteps[i].status)) {
        insertPosition = i + 1;
      } else {
        break; // Parar en el primer step pendiente
      }
    }

    // Crear nuevo step
    const newStepOrder = insertPosition + 1;
    const newStep = {
      id: `activity_${Date.now()}`,
      title: `Activity: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`,
      description: userMessage,
      status: stepStatus,
      order: newStepOrder,
      type: 'individual_activity',
      instructions: userMessage,
      expected_output: 'Execute the requested action',
      actual_output: agentResponse,
      started_at: new Date().toISOString(),
      completed_at: stepStatus === 'completed' ? new Date().toISOString() : null,
      duration_seconds: null,
      retry_count: 0,
      error_message: null,
      artifacts: []
    };

    // Insertar el step en la posición correcta
    const updatedSteps = [
      ...currentSteps.slice(0, insertPosition),
      newStep,
      ...currentSteps.slice(insertPosition).map((step: any) => ({
        ...step,
        order: step.order + 1 // Actualizar orden de steps posteriores
      }))
    ];

    // 4. Calcular métricas actualizadas
    const totalSteps = updatedSteps.length;
    const completedSteps = updatedSteps.filter((step: any) => step.status === 'completed').length;
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100);

    // 5. Actualizar el plan
    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        steps: updatedSteps,
        steps_total: totalSteps,
        steps_completed: completedSteps,
        progress_percentage: progressPercentage,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentPlan.id);

    if (updateError) {
      console.error('Error updating plan with new activity:', updateError);
      return { isPlanCompleted: false, planId: currentPlan.id };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Activity added to plan as step ${newStepOrder} (position ${insertPosition}) with status "${stepStatus}": "${newStep.title}"`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan progress: ${progressPercentage}% (${completedSteps}/${totalSteps} steps)`);

    // 6. Verificar si el plan está completado (progreso 100% - solo steps completed)
    const isPlanCompleted = progressPercentage === 100 && completedSteps > 0;
    
    if (isPlanCompleted) {
      // Marcar el plan como completado
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', currentPlan.id);
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🎉 Plan ${currentPlan.id} marked as COMPLETED!`);
    }

    return { isPlanCompleted, planId: currentPlan.id };

  } catch (error) {
    console.error('Error adding activity to plan:', error);
    return { isPlanCompleted: false, planId: null };
  }
}

/**
 * Ejecuta el workflow de robot cuando un plan se completa
 */
export async function executeRobotWorkflowOnCompletion(
  site_id: string,
  activity: string,
  user_id: string | undefined,
  instance_id: string,
  instance: any,
  planResult: { isPlanCompleted: boolean; planId: string | null }
): Promise<any> {
  if (!planResult?.isPlanCompleted) {
    return null;
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🚀 Plan completed! Executing robotWorkflow...`);
  
  try {
    const workflowService = WorkflowService.getInstance();
    
    const workflowExecutionResult = await workflowService.executeWorkflow('robotWorkflow', {
      site_id,
      activity,
      user_id,
      instance_id
    }, {
      priority: 'high',
      async: false,
      workflowId: `robot-workflow-${instance_id}-${Date.now()}`
    });
    
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Robot workflow executed successfully:`, workflowExecutionResult);
    
    // Log del workflow ejecutado
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'workflow_execution',
      level: 'info',
      message: `Robot workflow executed after plan completion`,
      details: {
        workflow_result: workflowExecutionResult,
        plan_id: planResult.planId,
        triggered_by: 'plan_completion'
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });
    
    return workflowExecutionResult;
    
  } catch (workflowError) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ Error executing robot workflow:`, workflowError);
    
    // Log del error del workflow
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'error',
      level: 'error',
      message: `Error executing robot workflow after plan completion: ${workflowError instanceof Error ? workflowError.message : 'Unknown error'}`,
      details: {
        error: workflowError instanceof Error ? workflowError.message : workflowError,
        plan_id: planResult.planId,
        triggered_by: 'plan_completion'
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });
    
    throw workflowError;
  }
}
