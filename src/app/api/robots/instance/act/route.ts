import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { addActivityToPlan, executeRobotWorkflowOnCompletion } from '@/lib/services/robot-instance/robot-plan-service';



// ------------------------------------------------------------------------------------
// POST /api/robots/instance/act
// Actualiza el plan de una instancia y ejecuta workflow si es necesario
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  message: z.string().min(1, 'message es requerido'),
  step_status: z.enum(['completed', 'failed', 'in_progress', 'pending']).default('pending'),
  site_id: z.string().min(1).optional(),
  activity: z.string().min(1).optional(),
  user_id: z.string().uuid().optional(),
});



export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  
  try {
    const rawBody = await request.json();
    const { site_id: providedSiteId, activity: providedActivity, instance_id: parsedInstanceId, user_id: providedUserId, message, step_status } = ActSchema.parse(rawBody);
    instance_id = parsedInstanceId;

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Processing plan update for instance: ${instance_id}`);

    // 1. Obtener la instancia
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // 2. Usar valores de la instancia si no se proporcionan en el request
    const site_id = providedSiteId || instance.site_id;
    const activity = providedActivity || 'robot_activity';
    const user_id = providedUserId || instance.user_id;

    // 3. Buscar el plan más reciente para esta instancia (activo o no)
    const { data: latestPlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instance_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Separar entre plan activo y plan completed/failed
    const activePlan = latestPlan && ['active', 'pending', 'in_progress'].includes(latestPlan.status) ? latestPlan : null;
    const completedPlan = latestPlan && ['completed', 'failed'].includes(latestPlan.status) ? latestPlan : null;

    // 4. Registrar la acción del usuario
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: message,
              details: { 
        user_message: message,
        step_status: step_status,
        plan_id: activePlan?.id || completedPlan?.id || null,
        plan_status: activePlan?.status || completedPlan?.status || null
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });

    let workflowExecutionResult = null;
    let planResult = null;

    if (activePlan) {
      // Caso A) Plan está activo - actualizar step del plan
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan ${activePlan.id} is active, updating step...`);
      
      planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan updated. Completed: ${planResult?.isPlanCompleted}`);

      // Si el plan se completó con esta acción, ejecutar workflow
      if (planResult?.isPlanCompleted) {
        try {
          workflowExecutionResult = await executeRobotWorkflowOnCompletion(
            site_id,
            activity,
            user_id,
            instance_id,
            instance,
            planResult
          );
        } catch (workflowError) {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ Workflow execution failed:`, workflowError);
        }
      }

    } else {
      // Caso B) No hay plan activo - puede ser que no exista o esté completed/failed
      if (completedPlan) {
        // Si hay un plan completed/failed, ejecutar workflow y luego actualizar el plan
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found ${completedPlan.status} plan ${completedPlan.id}, executing workflow for completed/failed plan...`);
        
        try {
          workflowExecutionResult = await executeRobotWorkflowOnCompletion(
            site_id,
            activity,
            user_id,
            instance_id,
            instance,
            { isPlanCompleted: true, planId: completedPlan.id }
          );
        } catch (workflowError) {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ Workflow execution failed:`, workflowError);
        }
        
        // Actualizar el plan después del workflow
        planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
        
      } else {
        // No hay plan en absoluto - ejecutar workflow y luego crear nuevo plan
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ No plan found, executing workflow and creating new plan...`);
        
        try {
          workflowExecutionResult = await executeRobotWorkflowOnCompletion(
            site_id,
            activity,
            user_id,
            instance_id,
            instance,
            { isPlanCompleted: true, planId: null }
          );
        } catch (workflowError) {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ Workflow execution failed:`, workflowError);
        }
        
        // Crear nuevo plan después del workflow
        planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
      }
    }

    return NextResponse.json({ 
      data: {
        message: 'Plan actualizado exitosamente',
        action_registered: true,
        step_status: step_status,
        plan_was_active: !!activePlan,
        plan_was_completed: !!completedPlan,
        plan_existed_completed_failed: !!completedPlan,
        plan_updated: planResult ? true : false,
        plan_completed: planResult?.isPlanCompleted || false,
        plan_id: planResult?.planId || activePlan?.id || completedPlan?.id || null,
        workflow_executed: workflowExecutionResult !== null,
        workflow_result: workflowExecutionResult
      }
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error en POST /robots/instance/act:', err);
    
    // Guardar el error como log si tenemos instance_id
    if (instance_id) {
      try {
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'error',
          level: 'error',
          message: `Error actualizando plan: ${err.message}`,
          details: { error: err.message, stack: err.stack },
          instance_id: instance_id,
        });
      } catch (logError) {
        console.error('Error guardando log de error:', logError);
      }
    }

    return NextResponse.json({ 
      data: {
        error: err.message,
        message: 'Plan update failed',
        action_registered: false,
        plan_updated: false,
        plan_completed: false,
        plan_id: null,
        workflow_executed: false,
        workflow_result: null
      }
    }, { status: 500 });
  }
}