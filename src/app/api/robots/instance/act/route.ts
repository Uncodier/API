import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { addActivityToPlan } from '@/lib/services/robot-instance/robot-plan-service';
import { executeUnifiedRobotActivityPlanning, decidePlanAction, formatPlanSteps, addSessionSaveSteps, calculateEstimatedDuration } from '@/lib/helpers/robot-planning-core';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';

// ------------------------------------------------------------------------------------
// Instance Act Specific Context (builds on the shared planning core)
// ------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------
// Helper function to save complete plan with proper structure
// ------------------------------------------------------------------------------------

async function saveCompletePlan(
  instanceId: string,
  planData: any,
  planningCommandUuid: string | null,
  activity: string,
  planDecisionAction: string
): Promise<{ planId: string | null; success: boolean }> {
  try {
    // Obtener información de la instancia ANTES de crear el plan
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('site_id, user_id')
      .eq('id', instanceId)
      .single();

    if (instanceError || !instance) {
      console.error('Error getting instance data for plan creation:', instanceError);
      return { planId: null, success: false };
    }

    // Formatear steps usando el core unificado
    let planSteps = formatPlanSteps(planData);
    
    // Agregar pasos de guardado de sesión usando el core unificado
    planSteps = addSessionSaveSteps(planSteps);

    const stepsTotal = planSteps.length;

    // Crear nuevo plan en la base de datos siguiendo el patrón de growth/robot/plan
    const { data: newPlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        title: `Plan regenerado para actividad: ${activity}`,
        description: `Plan ${planDecisionAction} generado automáticamente`,
        plan_type: 'objective',
        status: 'pending',
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

    // Actualizar el plan con los resultados siguiendo el patrón de growth/robot/plan
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

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Complete plan saved successfully with ID: ${newPlan.id}`);
    return { planId: newPlan.id, success: true };

  } catch (error) {
    console.error('Error saving complete plan:', error);
    return { planId: null, success: false };
  }
}



// ------------------------------------------------------------------------------------
// POST /api/robots/instance/act
// Actualiza el plan de una instancia de robot
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  message: z.string().min(1, 'message es requerido'),
  step_status: z.enum(['completed', 'failed', 'in_progress', 'pending']).default('pending'),
  site_id: z.string().min(1).optional(),
  activity: z.string().min(1).optional(),
  user_id: z.string().uuid().optional(),
  context: z.union([
    z.string(),
    z.object({}).passthrough() // Permitir objetos y extraer después
  ]).optional().transform((val) => {
    if (!val) return undefined;
    // Si es string, devolverlo tal como está
    if (typeof val === 'string') return val;
    // Si es objeto, intentar extraer el contexto
    if (typeof val === 'object' && val !== null) {
      // Buscar diferentes posibles campos de contexto
      const contextFields = ['context', 'text', 'content', 'message', 'data'];
      for (const field of contextFields) {
        if (field in val && typeof (val as any)[field] === 'string') {
          return (val as any)[field];
        }
      }
      // Si no encuentra un campo de contexto, convertir a string
      return JSON.stringify(val);
    }
    return String(val);
  }), // Contexto específico del usuario
});



export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  
  try {
    const rawBody = await request.json();
    console.log('🔍 Raw body received:', JSON.stringify(rawBody, null, 2));
    const { site_id: providedSiteId, activity: providedActivity, instance_id: parsedInstanceId, user_id: providedUserId, message, step_status, context: userContext } = ActSchema.parse(rawBody);
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

    // 4. Decidir qué acción tomar con el plan usando IA
    const planDecision = await decidePlanAction(latestPlan, message, userContext, site_id, user_id);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ AI Plan decision: ${planDecision.action} - ${planDecision.reason}`);

    // Separar entre plan activo y plan completed/failed para compatibilidad
    const activePlan = latestPlan && ['active', 'pending', 'in_progress'].includes(latestPlan.status) ? latestPlan : null;
    const completedPlan = latestPlan && ['completed', 'failed'].includes(latestPlan.status) ? latestPlan : null;

    // Verificar si el plan activo está realmente completado (todos los steps completados)
    let actuallyCompletedPlan = completedPlan;
    if (activePlan && !actuallyCompletedPlan) {
      const steps = activePlan.steps || [];
      const completedSteps = steps.filter((step: any) => step.status === 'completed');
      const totalSteps = steps.length;
      
      if (totalSteps > 0 && completedSteps.length === totalSteps) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan activo ${activePlan.id} está realmente completado (${completedSteps.length}/${totalSteps} steps), tratándolo como completado`);
        actuallyCompletedPlan = activePlan;
      }
    }

    // 5. Registrar la acción del usuario con información de decisión
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: message,
      details: { 
        user_message: message,
        user_context: userContext,
        step_status: step_status,
        plan_id: activePlan?.id || completedPlan?.id || null,
        plan_status: activePlan?.status || completedPlan?.status || null,
        actually_completed_plan_id: actuallyCompletedPlan?.id || null,
        plan_decision: planDecision
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });


    let planResult = null;
    let newPlanGenerated = false;
    let planModified = false;

    // Implementar lógica basada en la decisión del plan
    if (planDecision.shouldRegeneratePlan) {
      // Caso A) Regenerar o crear nuevo plan
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Regenerating plan based on decision: ${planDecision.action}`);
      
      try {
        // Encontrar el agente robot apropiado
        const robotAgent = await findGrowthRobotAgent(site_id);
        
        if (!robotAgent) {
          throw new Error('No se encontró un agente robot apropiado para este sitio');
        }

        // Construir contexto del plan previo si existe para modificación
        let previousPlanContext = '';
        if (planDecision.action === 'modify_plan' && latestPlan) {
          previousPlanContext = `PLAN ACTUAL A MODIFICAR:\n`;
          previousPlanContext += `Título: ${latestPlan.title}\n`;
          previousPlanContext += `Estado: ${latestPlan.status}\n`;
          if (latestPlan.steps && latestPlan.steps.length > 0) {
            previousPlanContext += `Steps actuales (${latestPlan.steps.length}): \n`;
            latestPlan.steps.forEach((step: any, index: number) => {
              previousPlanContext += `${index + 1}. ${step.title} (${step.status})\n`;
            });
          }
        }

        // Recuperar sesiones de autenticación previas
        const { data: previousSessions } = await supabaseAdmin
          .from('automation_auth_sessions')
          .select('*')
          .eq('site_id', site_id)
          .eq('is_valid', true);

        // Ejecutar planificación usando el core unificado con contexto del usuario y plan previo
        // Usar el mensaje del usuario como la actividad para que el plan sea específico
        const { activityPlanResults, planningCommandUuid } = await executeUnifiedRobotActivityPlanning(
          site_id,
          robotAgent.agentId,
          robotAgent.userId,
          message, // Usar el mensaje del usuario como actividad específica
          previousSessions || [],
          userContext, // User context from instance act route
          previousPlanContext // Previous plan context for modifications
        );

        if (activityPlanResults && activityPlanResults.length > 0) {
          // Generar o actualizar plan con los nuevos resultados
          newPlanGenerated = true;
          planModified = planDecision.action === 'modify_plan';
          
          // Guardar el plan completo con la estructura correcta
          const saveResult = await saveCompletePlan(
            instance_id,
            activityPlanResults[0], // Tomar el primer plan generado
            planningCommandUuid,
            message, // Usar el mensaje del usuario como actividad específica
            planDecision.action
          );
          
          if (saveResult.success) {
            planResult = {
              isPlanCompleted: false,
              planId: saveResult.planId
            };
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ Complete plan saved successfully with ID: ${saveResult.planId}`);
          } else {
            throw new Error('No se pudo guardar el plan completo');
          }
        } else {
          throw new Error('No se pudo generar el nuevo plan');
        }
        
      } catch (planGenerationError) {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ Plan generation failed:`, planGenerationError);
        // Fallback: continuar con el plan existente si es posible
        if (activePlan) {
          planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
        } else {
          throw planGenerationError;
        }
      }
      
    } else if (activePlan) {
      // Caso B) Continuar con el plan activo existente
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Continuing with active plan ${activePlan.id}...`);
      
      // Verificar restricción: solo permitir añadir steps después del step in_progress
      const steps = activePlan.steps || [];
      const inProgressStepIndex = steps.findIndex((step: any) => step.status === 'in_progress');
      
      // Si hay un step in_progress, verificar que solo se añadan steps posteriores
      if (inProgressStepIndex >= 0 && step_status === 'pending') {
        const newStepOrder = steps.length + 1;
        if (newStepOrder <= inProgressStepIndex + 1) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Cannot add step before or at in_progress step position`);
          // En lugar de fallar, añadir el step después del in_progress
        }
      }
      
      planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan updated. Completed: ${planResult?.isPlanCompleted}`);
      
    } else {
      // Caso C) No hay plan activo y no se debe regenerar (caso edge)
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No active plan and no regeneration requested - creating basic plan entry`);
      planResult = await addActivityToPlan(instance_id, message, `Step ${step_status}`, instance, step_status);
    }

    return NextResponse.json({ 
      data: {
        message: 'Plan procesado exitosamente',
        action_registered: true,
        step_status: step_status,
        plan_decision: planDecision,
        plan_was_active: !!activePlan,
        plan_was_completed: !!completedPlan,
        plan_existed_completed_failed: !!completedPlan,
        plan_actually_completed: !!actuallyCompletedPlan,
        plan_updated: planResult ? true : false,
        plan_completed: planResult?.isPlanCompleted || false,
        plan_id: planResult?.planId || activePlan?.id || completedPlan?.id || null,
        new_plan_generated: newPlanGenerated,
        plan_modified: planModified,
        user_context_used: !!userContext
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
        message: 'Plan processing failed',
        action_registered: false,
        plan_decision: null,
        plan_updated: false,
        plan_completed: false,
        plan_id: null,
        new_plan_generated: false,
        plan_modified: false,
        user_context_used: false
      }
    }, { status: 500 });
  }
}