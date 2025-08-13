import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeUnifiedRobotActivityPlanning, formatPlanSteps, addSessionSaveSteps, calculateEstimatedDuration } from '@/lib/helpers/robot-planning-core';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';

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

    // 4. Registrar un registro base en instance_plans --------------------------------
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

    // 5. Obtener contexto específico para el tipo de actividad con contexto de growth plan ------------------------
    console.log(`🎯 OBTENIENDO: Contexto específico para actividad: ${activity}`);
    
    const growthPlanContext = await buildGrowthPlanContext(site_id, activity, previousSessions || []);
    
    // 6. Manejo especial para Free Agent vs otras actividades ------------------------
    let planData;
    let planningCommandUuid = null;
    
    // Check for free agent variations more thoroughly to prevent unwanted command execution
    const normalizedActivity = activity.toLowerCase().trim().replace(/[\s-_]+/g, '');
    const isFreeAgent = normalizedActivity === 'freeagent' || 
                       activity.toLowerCase().trim() === 'free agent' || 
                       activity.toLowerCase().trim() === 'free-agent';
    
    if (isFreeAgent) {
      console.log(`🆓 FREE AGENT MODE: Creando plan básico sin ejecutar comando robot`);
      
      // Crear plan básico para Free Agent sin ejecutar comando
      planData = {
        title: "Plan básico Free Agent - Navegación DuckDuckGo",
        description: "Plan simple para navegación básica en DuckDuckGo sin requerir autenticación",
        phases: [
          {
            phase_name: "Navegación Web Básica",
            description: "Fase enfocada en navegación básica web sin autenticación",
            timeline: "30-45 minutos",
            success_criteria: [
              "Navegador abierto exitosamente",
              "DuckDuckGo accesible",
              "Búsqueda realizada sin errores",
              "Resultados obtenidos"
            ],
            steps: [
              {
                title: "Abrir navegador web",
                platform: "Browser",
                description: "Iniciar el navegador y verificar conectividad",
                step_number: 1,
                automation_level: "automated",
                estimated_duration: "2 minutos",
                estimated_duration_minutes: 2,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              },
              {
                title: "Navegar a DuckDuckGo",
                platform: "DuckDuckGo",
                description: "Ir a duckduckgo.com para realizar búsquedas",
                step_number: 2,
                automation_level: "automated",
                estimated_duration: "2 minutos",
                estimated_duration_minutes: 2,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              },
              {
                title: "Realizar búsqueda básica",
                platform: "DuckDuckGo",
                description: "Hacer una búsqueda simple relacionada con el negocio",
                step_number: 3,
                automation_level: "automated",
                estimated_duration: "3 minutos",
                estimated_duration_minutes: 3,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              },
              {
                title: "Revisar resultados",
                platform: "DuckDuckGo",
                description: "Examinar los primeros resultados de búsqueda",
                step_number: 4,
                automation_level: "automated",
                estimated_duration: "4 minutos",
                estimated_duration_minutes: 4,
                required_authentication: "none",
                expected_response_type: "step_completed",
                human_intervention_reason: null
              },
              {
                title: "Completar navegación",
                platform: "Browser",
                description: "Finalizar la sesión de navegación",
                step_number: 5,
                automation_level: "automated",
                estimated_duration: "2 minutos",
                estimated_duration_minutes: 2,
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
          "Si la búsqueda no funciona, verificar conectividad a internet",
          "Si los resultados no aparecen, probar con términos de búsqueda alternativos"
        ],
        priority_level: "medium",
        success_metrics: [
          "Navegador abierto exitosamente",
          "DuckDuckGo accesible",
          "Búsqueda realizada sin errores",
          "Resultados obtenidos"
        ],
        estimated_timeline: "45 minutos",
        browser_requirements: [
          "Chrome o Firefox browser",
          "Conexión estable a internet"
        ],
        execution_objectives: [
          "Validar conectividad web básica",
          "Realizar búsqueda simple sin autenticación",
          "Documentar resultados encontrados"
        ],
        required_integrations: [
          "none"
        ]
      };
      
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

    // 7. Actualizar el plan con los resultados usando el core unificado ----------------------------------------
    
    // Formatear steps usando el core unificado
    let planSteps = formatPlanSteps(planData);
    
    // Agregar pasos de guardado de sesión usando el core unificado
    planSteps = addSessionSaveSteps(planSteps);

    const stepsTotal = planSteps.length;

    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'completed',
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