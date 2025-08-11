import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { UBUNTU_SYSTEM_PROMPT } from 'scrapybara/prompts';

// Custom system prompt that includes route verification before navigation
const BROWSER_NAVIGATION_SYSTEM_PROMPT = `${UBUNTU_SYSTEM_PROMPT}

CRITICAL INSTRUCTIONS FOR WEB NAVIGATION:

**BEFORE ANY NAVIGATION ACTION, ALWAYS:**
1. Take a screenshot to see the current page and verify browser state
2. Check the current URL using browser navigation tools
3. Mentally note which page/application is currently active
4. Verify you can see browser elements before proceeding

**MANDATORY RULES:**
- NEVER change pages, tabs, or applications without FIRST verifying where you currently are
- ALWAYS report the current URL/route before proceeding with any navigation
- If you detect the browser is not open, open one before continuing
- Maintain awareness of navigation context at all times

**ACTIONS THAT REQUIRE PRIOR VERIFICATION:**
- Opening new tabs or windows
- Navigating to new URLs
- Switching between applications
- Reloading pages
- Using navigation buttons (back, forward)
- Switching between existing tabs

These verifications are CRITICAL to maintain context and avoid getting lost during navigation.`;
import { computerTool } from 'scrapybara/tools';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/act
// Ejecuta una acción en una instancia existente usando client.get() del SDK
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  message: z.string().min(1, 'message es requerido'),
  context: z.union([z.string(), z.object({}).passthrough()]).optional().transform((val) => {
    if (typeof val === 'object' && val !== null) {
      return JSON.stringify(val, null, 2);
    }
    return val;
  }),
});

// Función auxiliar para agregar actividad al plan del robot
async function addActivityToPlan(instance_id: string, userMessage: string, agentResponse: string, instance: any) {
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
      return;
    }

    // 2. Si no hay plan activo, crear uno nuevo
    let currentPlan = activePlan;
    if (!activePlan) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No active plan found, creating new plan...`);
      
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
          results: {
            plan: {
              title: 'Robot Activity Log',
              phases: [{
                title: 'Activities',
                steps: []
              }]
            }
          }
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating new plan:', createError);
        return;
      }
      
      currentPlan = newPlan;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Created new plan with ID: ${newPlan.id}`);
    }

    // 3. Agregar nuevo step al plan
    const currentResults = currentPlan.results || { plan: { title: currentPlan.title, phases: [{ title: 'Activities', steps: [] }] } };
    
    // Asegurar que existe la estructura básica
    if (!currentResults.plan) {
      currentResults.plan = { title: currentPlan.title, phases: [] };
    }
    if (!currentResults.plan.phases || currentResults.plan.phases.length === 0) {
      currentResults.plan.phases = [{ title: 'Activities', steps: [] }];
    }
    
    const activitiesPhase = currentResults.plan.phases[0];
    if (!activitiesPhase.steps) {
      activitiesPhase.steps = [];
    }

    // Crear nuevo step
    const newStepOrder = activitiesPhase.steps.length + 1;
    const newStep = {
      id: `activity_${Date.now()}`,
      title: `Activity: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`,
      description: userMessage,
      status: 'completed',
      order: newStepOrder,
      result: agentResponse,
      completed_at: new Date().toISOString(),
      execution_type: 'individual_activity'
    };

    // Agregar el step
    activitiesPhase.steps.push(newStep);

    // 4. Calcular métricas actualizadas
    const totalSteps = activitiesPhase.steps.length;
    const completedSteps = activitiesPhase.steps.filter((step: any) => step.status === 'completed').length;
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100);

    // 5. Actualizar el plan
    const { error: updateError } = await supabaseAdmin
      .from('instance_plans')
      .update({
        results: currentResults,
        steps_total: totalSteps,
        steps_completed: completedSteps,
        progress_percentage: progressPercentage,
        updated_at: new Date().toISOString(),
        last_executed_at: new Date().toISOString()
      })
      .eq('id', currentPlan.id);

    if (updateError) {
      console.error('Error updating plan with new activity:', updateError);
      return;
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Activity added to plan as step ${newStepOrder}: "${newStep.title}"`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan progress: ${progressPercentage}% (${completedSteps}/${totalSteps} steps)`);

  } catch (error) {
    console.error('Error adding activity to plan:', error);
  }
}

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  
  try {
    const rawBody = await request.json();
    const { instance_id: parsedInstanceId, message, context } = ActSchema.parse(rawBody);
    instance_id = parsedInstanceId;

    // 1. Obtener la instancia ------------------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // 2. Verificar sesiones de autenticación disponibles --------------------------
    const { data: existingSessions, error: sessionsError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', instance.site_id)
      .eq('is_valid', true)
      .order('last_used_at', { ascending: false });

    if (sessionsError) {
      console.error('Error fetching existing sessions:', sessionsError);
    }

    // ⚠️ NUEVA LÓGICA: Verificar si se necesitan sesiones para la acción específica
    const messageRequiresAuth = message && (
      message.toLowerCase().includes('login') ||
      message.toLowerCase().includes('post') ||
      message.toLowerCase().includes('social') ||
      message.toLowerCase().includes('facebook') ||
      message.toLowerCase().includes('twitter') ||
      message.toLowerCase().includes('linkedin') ||
      message.toLowerCase().includes('instagram') ||
      message.toLowerCase().includes('google') ||
      message.toLowerCase().includes('upload') ||
      message.toLowerCase().includes('share') ||
      message.toLowerCase().includes('connect') ||
      message.toLowerCase().includes('authenticate')
    );

    // Si la acción requiere autenticación pero no hay sesiones disponibles
    if (messageRequiresAuth && (!existingSessions || existingSessions.length === 0)) {
      console.log(`🔐 ACCIÓN REQUIERE AUTENTICACIÓN: ${message}`);
      
      // Registrar el error en logs
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'error',
        level: 'warning',
        message: `Acción bloqueada: se requiere autenticación para ejecutar: ${message}`,
        details: { 
          user_message: message,
          reason: 'No authentication sessions available',
          action_required: 'LOGIN_REQUIRED'
        },
        instance_id: instance_id,
        site_id: instance.site_id,
        user_id: instance.user_id,
        agent_id: instance.agent_id,
        command_id: instance.command_id,
      });

      return NextResponse.json(
        { 
          error: 'AUTHENTICATION_REQUIRED',
          message: 'No se puede ejecutar esta acción: se requiere autenticación en plataformas',
          action_blocked: message,
          action_required: {
            type: 'LOGIN_REQUIRED',
            message: 'Se requiere iniciar sesión en las plataformas necesarias para ejecutar esta acción',
            login_url: '/auth/platforms',
            platforms_needed: ['social_media', 'google'], // Plataformas sugeridas basadas en el mensaje
            instructions: 'Por favor, inicia sesión en las plataformas necesarias y vuelve a intentar la acción'
          }
        },
        { status: 403 },
      );
    }

    // 3. Nota: Usamos instance para logs pero creamos instancia temporal para ejecución

    // 3. Guardar el log del mensaje del usuario -----------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: message,
      details: { user_message: message },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });

    // 4. Obtener logs históricos para contexto ----------------------------------
    const { data: historicalLogs } = await supabaseAdmin
      .from('instance_logs')
      .select('log_type, message, created_at, details')
      .eq('instance_id', instance_id)
      .in('log_type', ['agent_action', 'user_action'])
      .order('created_at', { ascending: true })
      .limit(20); // Últimos 20 logs para contexto

    // Formatear logs como contexto histórico
    const logContext = historicalLogs
      ?.map(log => `[${log.created_at}] ${log.log_type === 'agent_action' ? 'AGENT' : 'USER'}: ${log.message}`)
      .join('\n') || 'No previous logs available.';

    // 5. Conectar con instancia existente usando client.get() ---------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    
    // ✅ Conectar con instancia existente (¡por fin!)
    const remoteInstance = await client.get(instance.provider_instance_id);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Connected to existing instance: [${instance.provider_instance_id}]`);
    
    // Verificar que es una instancia Ubuntu para las herramientas
    if (!('browser' in remoteInstance)) {
      return NextResponse.json({ 
        error: 'La instancia debe ser de tipo Ubuntu para usar las herramientas completas' 
      }, { status: 400 });
    }
    
    // Preparar herramientas (ahora sabemos que es UbuntuInstance)
    const ubuntuInstance = remoteInstance as any; // Cast temporal para resolver tipos
    const tools = [
      computerTool(ubuntuInstance), // Solo herramienta de navegación/UI
    ];

    // 6. Crear system prompt con contexto histórico ----------------------------
    const systemPromptWithContext = `${BROWSER_NAVIGATION_SYSTEM_PROMPT}

${context ? `ADDITIONAL CONTEXT:
${context}

` : ''}HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT

The current user message (not shown above) will be provided separately. Use this historical context to maintain continuity and understand previous actions taken.`;

    // 7. Ejecutar acción usando el SDK act() --------------------------------------
    const { steps, text, usage } = await client.act({
      model: anthropic(),
      tools,
      system: systemPromptWithContext,
      prompt: message,
      onStep: async (step: any) => {
        // Handle step siguiendo el patrón de Python
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: ${step.text}`);
        
        // Mostrar tool calls como en Python
        if (step.toolCalls) {
          for (const call of step.toolCalls) {
            const args = Object.entries(call.args || {})
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            console.log(`${call.toolName} [${remoteInstance.id}] → ${args}`);
          }
        }

        // Guardar en BD con referencia a la instancia existente
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: step.text || 'Executing step',
          details: {
            step: step,
            tool_calls: step.toolCalls,
            tool_results: step.toolResults,
            usage: step.usage,
            remote_instance_id: remoteInstance.id, // ✅ ID de instancia existente
          },
          instance_id: instance_id, // ID original para logs
          site_id: instance.site_id,
          user_id: instance.user_id,
          agent_id: instance.agent_id,
          command_id: instance.command_id,
        });
      },
    });

    // 6. Guardar el resultado final -----------------------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: text || 'Acción completada',
      details: {
        final_text: text,
        total_steps: steps.length,
        usage: usage,
        remote_instance_id: remoteInstance.id, // ✅ ID de instancia existente
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });

    // 7. Agregar esta actividad como step al plan del robot -----------------------
    await addActivityToPlan(instance_id, message, text || 'Acción completada', instance);

    // 8. Nota: No limpiamos la instancia ya que es persistente -----------------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Action completed on existing instance`);

    return NextResponse.json({ 
      data: {
        message: 'Acción ejecutada exitosamente',
        response: text,
        steps_executed: steps.length,
        token_usage: usage,
        remote_instance_id: remoteInstance.id,
        activity_added_to_plan: true,
        plan_updated: true
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
          message: `Error ejecutando acción: ${err.message}`,
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
        message: 'Individual activity execution failed',
        activity_added_to_plan: false,
        plan_updated: false
      }
    }, { status: 500 });
  }
}