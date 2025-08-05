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
1. Execute 'bash -c "pgrep -f firefox || pgrep -f chrome || pgrep -f chromium"' to verify browser is open
2. If browser is open, take a screenshot to see the current page
3. Check the current URL using browser tools or bash
4. Mentally note which page/application is currently active

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
import { bashTool, computerTool, editTool } from 'scrapybara/tools';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/act
// Ejecuta el último step pendiente del plan usando instancia existente con client.get()
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  instance_plan_id: z.string().uuid('instance_plan_id inválido'),
});

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  let currentStep: any = null;
  
  try {
    const rawBody = await request.json();
    const { instance_id: parsedInstanceId, instance_plan_id } = ActSchema.parse(rawBody);
    instance_id = parsedInstanceId;

    // 1. Obtener registros principales --------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    const { data: plan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('id', instance_plan_id)
      .single();

    if (planError || !plan) {
      return NextResponse.json({ error: 'Plan no encontrado' }, { status: 404 });
    }

    // 2.1. Buscar el último step pendiente del plan --------------------------------
    const { data: pendingSteps, error: stepsError } = await supabaseAdmin
      .from('instance_plan_steps')
      .select('*')
      .eq('instance_plan_id', instance_plan_id)
      .eq('status', 'pending')
      .order('order', { ascending: true })
      .limit(1);

    if (stepsError) {
      return NextResponse.json({ error: 'Error obteniendo steps del plan' }, { status: 500 });
    }

    if (!pendingSteps || pendingSteps.length === 0) {
      return NextResponse.json({ 
        message: 'No hay steps pendientes en este plan',
        plan_completed: true 
      }, { status: 200 });
    }

    currentStep = pendingSteps[0];
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing plan step: "${currentStep.title}"`);

    // 2.2. Marcar el step como en progreso ----------------------------------------
    await supabaseAdmin
      .from('instance_plan_steps')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', currentStep.id);

    // 3. Obtener logs históricos para contexto ----------------------------------
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

    // 4. Conectar con instancia existente usando client.get() ---------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    
    // ✅ Conectar con instancia existente usando el método oficial
    const remoteInstance = await client.get(instance.provider_instance_id);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Connected to existing instance: [${instance.provider_instance_id}]`);
    
    // Verificar que es una instancia Ubuntu para las herramientas
    if (!('browser' in remoteInstance)) {
      return NextResponse.json({ 
        error: 'La instancia debe ser de tipo Ubuntu para ejecutar el plan' 
      }, { status: 400 });
    }

    // 4. Preparar herramientas (ahora sabemos que es UbuntuInstance) ---------------
    const ubuntuInstance = remoteInstance as any; // Cast temporal para resolver tipos
    const tools = [
      bashTool(ubuntuInstance),
      computerTool(ubuntuInstance),
      editTool(ubuntuInstance),
    ];

    // 6. Crear system prompt con contexto histórico ----------------------------
    const systemPromptWithContext = `${BROWSER_NAVIGATION_SYSTEM_PROMPT}

HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT

The current step instructions (not shown above) will be provided separately. Use this historical context to maintain continuity and understand previous actions taken.`;

    // 7. Ejecutar el step específico del plan usando el SDK ----------------------
    const stepPrompt = currentStep.description || `Ejecuta el step "${currentStep.title}" del plan "${plan.title}"`;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing step with prompt: "${stepPrompt}"`);
    
    const { steps, text, usage } = await client.act({
      model: anthropic(),
      tools,
      system: systemPromptWithContext,
      prompt: stepPrompt,
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

        // Guardar en BD con referencia al step del plan
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: step.text || 'Executing plan step',
          details: {
            step: step,
            tool_calls: step.toolCalls,
            tool_results: step.toolResults,
            usage: step.usage,
            remote_instance_id: remoteInstance.id,
            plan_step_id: currentStep.id,
            plan_step_title: currentStep.title,
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      },
    });

    // 6. Marcar el step como completado y guardar resultado final -----------------
    await supabaseAdmin
      .from('instance_plan_steps')
      .update({ 
        status: 'completed', 
        completed_at: new Date().toISOString(),
        result: text || 'Step completed successfully'
      })
      .eq('id', currentStep.id);

    // 7. Guardar el resultado final del step --------------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: text || 'Plan step completed',
      details: {
        final_text: text,
        total_steps: steps.length,
        usage: usage,
        remote_instance_id: remoteInstance.id,
        plan_step_id: currentStep.id,
        plan_step_title: currentStep.title,
        plan_step_status: 'completed'
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    // 8. Actualizar métricas del plan --------------------------------------------
    const newStepsCompleted = (plan.steps_completed ?? 0) + 1;
    await supabaseAdmin.from('instance_plans').update({
      steps_completed: newStepsCompleted,
      progress_percentage: Math.min(100, newStepsCompleted * 10), // Asumiendo 10 steps max
      last_executed_at: new Date().toISOString(),
    }).eq('id', instance_plan_id);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Plan step completed successfully`);

    return NextResponse.json({ 
      message: 'Plan step ejecutado exitosamente',
      step_completed: currentStep.title,
      response: text,
      steps_executed: steps.length,
      token_usage: usage,
      remote_instance_id: remoteInstance.id,
      plan_progress: newStepsCompleted
    }, { status: 200 });
  } catch (err: any) {
    console.error('Error en POST /robots/plan/act:', err);
    
    // Marcar el step como fallido si tenemos referencia a él
    if (currentStep && currentStep.id) {
      try {
        await supabaseAdmin
          .from('instance_plan_steps')
          .update({ 
            status: 'failed', 
            completed_at: new Date().toISOString(),
            result: `Error: ${err.message}`
          })
          .eq('id', currentStep.id);

        // Guardar el error como log si tenemos instance_id
        if (instance_id) {
          await supabaseAdmin.from('instance_logs').insert({
            log_type: 'error',
            level: 'error',
            message: `Error ejecutando step del plan: ${err.message}`,
            details: { 
              error: err.message, 
              stack: err.stack,
              plan_step_id: currentStep.id,
              plan_step_title: currentStep.title,
            },
            instance_id: instance_id,
          });
        }
      } catch (logError) {
        console.error('Error guardando log de error:', logError);
      }
    }

    return NextResponse.json({ 
      error: err.message,
      step_failed: currentStep?.title || 'Unknown step'
    }, { status: 500 });
  }
}