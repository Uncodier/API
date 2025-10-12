import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeUnifiedRobotActivityPlanning, formatPlanSteps, addSessionSaveSteps, calculateEstimatedDuration } from '@/lib/helpers/robot-planning-core';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';

// ------------------------------------------------------------------------------------
// Growth Plan Specific Context (extends the core planning with previous plan context)
// ------------------------------------------------------------------------------------
// This function now adds Growth Plan specific context to the shared planning core
async function buildGrowthPlanContext(
  site_id: string,
  activity: string,
  previousSessions: any[]
): Promise<string> {
  // Build growth plan specific context that will be added to the shared core
  const sessionsSummary = previousSessions && previousSessions.length > 0
    ? `\n📈 GROWTH PLAN SESSION CONTEXT:\nLa planificación de growth considera ${previousSessions.length} sesiones de autenticación previas disponibles para optimizar la ejecución.\n`
    : '\n📈 GROWTH PLAN SESSION CONTEXT:\nEste es un plan inicial de growth sin sesiones previas. El plan se enfocará en actividades que no requieren autenticación o establecerán nuevas sesiones.\n';
  
  return sessionsSummary;
}

// ------------------------------------------------------------------------------------
// POST /api/agents/growth/robot/plan
// Genera un plan de actividades para la "activity" recibida considerando
// sesiones de autenticación previas y creando un comando para la ejecución.
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 min – ejecuta comando completo

const CreatePlanSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  user_id: z.string().uuid('user_id debe ser un UUID válido'),
  instance_id: z.string().uuid('instance_id debe ser un UUID válido'),
  activity: z.string().min(3, 'activity es requerido'),
});

export async function POST(request: NextRequest) {
  try {
    // 1. Validar y parsear body -------------------------------------------------------
    const rawBody = await request.json();
    const { site_id, user_id, instance_id, activity } = CreatePlanSchema.parse(rawBody);

    // 2. Recuperar sesiones de autenticación previas ---------------------------------
    const { data: previousSessions, error: sessionsError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', site_id)
      .eq('is_valid', true);

    if (sessionsError) {
      console.error('Error fetching previous sessions:', sessionsError);
    }

    // 3. Encontrar el agente robot apropiado ------------------------------------------
    const robotAgent = await findGrowthRobotAgent(site_id);
    
    if (!robotAgent) {
      return NextResponse.json(
        { error: 'No se encontró un agente robot apropiado para este sitio' },
        { status: 404 },
      );
    }

    console.log(`🤖 Robot agent encontrado: ${robotAgent.agentId}`);

    // 4. Complete all in-progress plans before creating a new one -------------------
    await completeInProgressPlans(instance_id);

    // 5. Registrar un registro base en instance_plans --------------------------------
    const { data: newPlan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        title: `Plan simple para actividad: ${activity}`,
        description: 'Plan simple y enfocado generado automáticamente para ejecución en 1-2 horas máximo',
        plan_type: 'objective',
        status: 'pending',
        instance_id,
        site_id,
        user_id,
      })
      .select()
      .single();

    if (planError) {
      console.error('Error inserting plan:', planError);
      return NextResponse.json({ error: 'Error al registrar el plan' }, { status: 500 });
    }

    // 6. Obtener contexto específico para el tipo de actividad con contexto de growth plan ------------------------
    console.log(`🎯 OBTENIENDO: Contexto específico para actividad: ${activity}`);
    
    const growthPlanContext = await buildGrowthPlanContext(site_id, activity, previousSessions || []);
    
    // 6. Manejo especial para Free Agent y Ask vs otras actividades ------------------------
    let planData;
    let planningCommandUuid = null;
    
    // Check for free agent variations more thoroughly to prevent unwanted command execution
    const normalizedActivity = activity.toLowerCase().trim().replace(/[\s-_]+/g, '');
    const isFreeAgent = normalizedActivity === 'freeagent' || 
                       activity.toLowerCase().trim() === 'free agent' || 
                       activity.toLowerCase().trim() === 'free-agent';
    const isAsk = activity.toLowerCase().trim() === 'ask';
    
    if (isFreeAgent) {
      console.log(`🆓 FREE AGENT MODE: Creando plan básico sin ejecutar comando robot`);
      
      // Crear plan básico para Free Agent sin ejecutar comando
      planData = {
        title: "Plan Free Agent - Abrir DuckDuckGo",
        description: "Plan simple para abrir únicamente DuckDuckGo",
        phases: [
          {
            phase_name: "Abrir DuckDuckGo",
            description: "Abrir DuckDuckGo en el navegador",
            timeline: "5 minutos",
            success_criteria: [
              "DuckDuckGo abierto exitosamente",
              "Elementos de la página completamente visibles o centrados en pantalla"
            ],
            steps: [
              {
                title: "Abrir DuckDuckGo",
                platform: "DuckDuckGo",
                description: "Ir a duckduckgo.com y asegurar que todos los elementos (buscador, botones, contenido) estén completamente visibles en pantalla o centrados para mejorar la usabilidad",
                step_number: 1,
                automation_level: "automated",
                estimated_duration: "3 minutos",
                estimated_duration_minutes: 3,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              }
            ]
          }
        ],
        activity_type: "free-agent",
        error_handling: [
          "Si DuckDuckGo no carga, intentar recargar la página",
          "Si hay problemas de conectividad, verificar la conexión a internet"
        ],
        priority_level: "medium",
        success_metrics: [
          "DuckDuckGo abierto exitosamente",
          "Elementos de la página completamente visibles o centrados en pantalla"
        ],
        estimated_timeline: "5 minutos",
        browser_requirements: [
          "Chrome o Firefox browser",
          "Conexión estable a internet"
        ],
        execution_objectives: [
          "Abrir DuckDuckGo",
          "Asegurar visibilidad completa de elementos en pantalla para mejor usabilidad"
        ],
        required_integrations: [
          "none"
        ]
      };
      
    } else if (isAsk) {
      console.log(`🗣️ ASK MODE: Creando plan de 3 pasos sin ejecutar comando robot`);
      // Crear plan de 3 pasos para Ask sin ejecutar comando
      planData = {
        title: "Ask - Quick Q&A",
        description: "Three-step plan: request info, respond, validate. No command execution.",
        phases: [
          {
            phase_name: "Q&A",
            description: "Collect question context, provide answer, and validate",
            timeline: "30 minutes",
            success_criteria: [
              "All needed info requested or confirmed available",
              "Concise, direct answer provided",
              "Answer validated with source or internal consistency"
            ],
            steps: [
              {
                title: "Request all pertinent information",
                description: "Ask for missing context, constraints, and desired depth to answer the question effectively",
                step_number: 1,
                automation_level: "automated",
                estimated_duration: "3 minutes",
                estimated_duration_minutes: 3,
                required_authentication: "none",
                expected_response_type: "user_attention_required",
                human_intervention_reason: "Needs user context/clarifications"
              },
              {
                title: "Provide the answer",
                description: "Draft a concise answer (1–3 sentences) based on available context and reputable sources if needed",
                step_number: 2,
                automation_level: "automated",
                estimated_duration: "4 minutes",
                estimated_duration_minutes: 4,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              },
              {
                title: "Validate the answer",
                description: "Validate correctness and include the source or rationale; adjust if inconsistencies are found",
                step_number: 3,
                automation_level: "automated",
                estimated_duration: "3 minutes",
                estimated_duration_minutes: 3,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              }
            ]
          }
        ],
        activity_type: "ask",
        estimated_timeline: "30 minutes",
        success_metrics: [
          "Clarity and completeness of the answer",
          "Source or validation provided"
        ]
      };
      // No command id for Ask simple plan
      planningCommandUuid = null;
    } else {
      console.log(`🤖 INICIANDO: Ejecutando planificación de actividad con Robot usando core unificado...`);
      
      const { activityPlanResults, planningCommandUuid: commandUuid } = await executeUnifiedRobotActivityPlanning(
        site_id,
        robotAgent.agentId,
        robotAgent.userId,
        activity,
        previousSessions || [],
        undefined, // No user context in growth plan route
        growthPlanContext // Previous plan context from growth plan
      );

      planningCommandUuid = commandUuid;

      if (!activityPlanResults || activityPlanResults.length === 0) {
        console.log(`❌ FALLO: Robot activity planning falló - actualizando plan como fallido`);
        
        // Actualizar el plan como fallido
        await supabaseAdmin
          .from('instance_plans')
          .update({
            status: 'failed',
            command_id: planningCommandUuid,
          })
          .eq('id', newPlan.id);

        return NextResponse.json(
          { 
            error: 'No se pudo generar el plan de actividad con el robot',
            instance_plan_id: newPlan.id,
          },
          { status: 500 },
        );
      }

      console.log(`✅ COMPLETADO: Planificación de actividad completada con ${activityPlanResults.length} plan(s)`);
      console.log(`🔑 Planning Command UUID: ${planningCommandUuid}`);
      
      planData = activityPlanResults[0]; // Tomar el primer plan generado
    }

    // 8. Actualizar el plan con los resultados usando el core unificado ----------------------------------------
    
    // Formatear steps usando el core unificado
    let planSteps = formatPlanSteps(planData);
    
    // Agregar pasos de guardado de sesión usando el core unificado
    planSteps = addSessionSaveSteps(planSteps);

    const stepsTotal = planSteps.length;

    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'pending',
        command_id: planningCommandUuid,
        title: planData.title || `Plan simple para actividad: ${activity}`,
        description: planData.description || 'Plan simple y enfocado generado automáticamente para ejecución en 1-2 horas máximo',
        steps: planSteps, // Guardar steps en el nuevo formato
        success_criteria: planData.success_metrics || planData.success_criteria || [],
        steps_total: stepsTotal,
        steps_completed: 0,
        progress_percentage: 0,
        estimated_duration_minutes: calculateEstimatedDuration(planData.estimated_timeline || planData.estimated_duration_minutes),
        priority: typeof planData.priority_level === 'string' ? 5 : (planData.priority_level || planData.priority || 5),
      })
      .eq('id', newPlan.id);

    if (updateError) {
      console.error('Error updating plan:', updateError);
      return NextResponse.json({ error: 'Error al actualizar el plan con los resultados' }, { status: 500 });
    }

    console.log(`🎉 PROCESO COMPLETO: Plan guardado exitosamente`);

    return NextResponse.json(
      {
        instance_plan_id: newPlan.id,
        command_id: planningCommandUuid,
        message: 'Plan creado y ejecutado correctamente',
        plan_data: planData,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robot/plan:', err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}