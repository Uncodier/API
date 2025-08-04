import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeRobotActivityPlanning } from '@/lib/helpers/campaign-commands';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';

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
        title: `Plan para actividad: ${activity}`,
        description: 'Plan generado automáticamente para la actividad solicitada',
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

    // 5. Ejecutar el comando de planificación -----------------------------------------
    console.log(`🤖 INICIANDO: Ejecutando planificación de actividad con Robot...`);
    
    const { activityPlanResults, planningCommandUuid } = await executeRobotActivityPlanning(
      site_id,
      robotAgent.agentId,
      robotAgent.userId,
      activity,
      previousSessions || []
    );

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

    // 6. Actualizar el plan con los resultados ----------------------------------------
    const planData = activityPlanResults[0]; // Tomar el primer plan generado
    
    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        status: 'completed',
        command_id: planningCommandUuid,
        title: planData.title || `Plan para actividad: ${activity}`,
        description: planData.description || 'Plan generado automáticamente para la actividad solicitada',
        results: planData, // Guardar todo el plan generado
        success_criteria: planData.success_metrics || planData.success_criteria || [],
        estimated_duration_minutes: (() => {
          // Intentar extraer números del timeline o duration
          const timelineValue = planData.estimated_timeline || planData.estimated_duration_minutes;
          if (typeof timelineValue === 'number') return timelineValue;
          if (typeof timelineValue === 'string') {
            // Buscar números en el string y convertir
            const match = timelineValue.match(/(\d+)/);
            if (match) {
              const num = parseInt(match[1]);
              // Convertir semanas a minutos si encuentra "week" en el string
              if (timelineValue.toLowerCase().includes('week')) {
                return num * 7 * 24 * 60; // semanas a minutos
              }
              // Convertir días a minutos si encuentra "day"
              if (timelineValue.toLowerCase().includes('day')) {
                return num * 24 * 60; // días a minutos
              }
              // Si no especifica unidad, asumir que son minutos
              return num;
            }
          }
          return null; // Si no se puede parsear, dejar como null
        })(),
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