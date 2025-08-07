import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { UBUNTU_SYSTEM_PROMPT } from 'scrapybara/prompts';

// Custom system prompt for plan execution with step completion tracking
const PLAN_EXECUTION_SYSTEM_PROMPT = `${UBUNTU_SYSTEM_PROMPT}

CRITICAL INSTRUCTIONS FOR PLAN EXECUTION:

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

**PLAN STEP EXECUTION RULES:**
- Focus ONLY on completing the current step in the plan
- DO NOT execute multiple steps or jump ahead
- Work systematically through the current step requirements
- When you determine a step is completed, clearly state: "STEP_COMPLETED: [brief description of what was accomplished]"
- If a step cannot be completed, state: "STEP_BLOCKED: [reason why step cannot proceed]"
- If you need clarification or additional information, state: "STEP_NEEDS_INPUT: [what information or action is needed]"

**STEP COMPLETION INDICATORS:**
You must explicitly indicate when a step is complete by using one of these phrases:
- "STEP_COMPLETED: Successfully [action taken]"
- "STEP_BLOCKED: Cannot proceed because [reason]" 
- "STEP_NEEDS_INPUT: Require [specific need] to continue"

These verifications and step tracking are CRITICAL to maintain plan progress and context.`;
import { bashTool, computerTool, editTool } from 'scrapybara/tools';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/act
// Ejecuta el último step pendiente del plan usando instancia existente con client.get()
// 
// Funcionalidades adicionales:
// - Si se proporciona user_instruction, la inserta como nuevo paso en el plan
// - El nuevo paso se inserta después del paso actual (ej: si vamos en paso 8 de 20, pasa a ser 8 de 21)
// - Actualiza automáticamente el ordering de todos los pasos subsecuentes
// - Actualiza el total de pasos en el plan (steps_total)
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  instance_plan_id: z.string().uuid('instance_plan_id inválido'),
  user_instruction: z.string().optional(),
});

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  let currentStep: any = null;
  
  try {
    const rawBody = await request.json();
    const { instance_id: parsedInstanceId, instance_plan_id, user_instruction } = ActSchema.parse(rawBody);
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

    // 2.2. Si hay instrucción del usuario, insertar como nuevo paso ---------------
    if (user_instruction && user_instruction.trim()) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ User instruction provided: "${user_instruction}"`);
      
      // Primero obtener todos los steps que necesitan reordenarse
      const { data: stepsToUpdate, error: fetchError } = await supabaseAdmin
        .from('instance_plan_steps')
        .select('id, order')
        .eq('instance_plan_id', instance_plan_id)
        .gte('order', currentStep.order + 1)
        .order('order', { ascending: true });

      if (!fetchError && stepsToUpdate) {
        // Actualizar cada step individualmente para incrementar su order
        for (const step of stepsToUpdate) {
          await supabaseAdmin
            .from('instance_plan_steps')
            .update({ order: step.order + 1 })
            .eq('id', step.id);
        }
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Updated order for ${stepsToUpdate.length} subsequent steps`);
      }

      // Insertar el nuevo paso con order = currentStep.order + 1
      const { data: newStep, error: insertError } = await supabaseAdmin
        .from('instance_plan_steps')
        .insert({
          instance_plan_id: instance_plan_id,
          title: `User Instruction: ${user_instruction.substring(0, 50)}${user_instruction.length > 50 ? '...' : ''}`,
          description: user_instruction,
          order: currentStep.order + 1,
          status: 'pending',
          step_type: 'user_instruction',
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error inserting user instruction step:', insertError);
        // Continuar sin fallar completamente
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Inserted new step at position ${currentStep.order + 1}`);
        
        // Actualizar el total de steps en el plan
        await supabaseAdmin
          .from('instance_plans')
          .update({ 
            steps_total: (plan.steps_total || 1) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', instance_plan_id);
      }
    }

    // 2.3. Marcar el step actual como en progreso ----------------------------------
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
    const systemPromptWithContext = `${PLAN_EXECUTION_SYSTEM_PROMPT}

HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT

CURRENT PLAN STEP:
You are executing step "${currentStep.title}" (order: ${currentStep.order}) from the plan "${plan.title}".
Step Description: ${currentStep.description || 'No description provided'}

Focus ONLY on this specific step. Do not move to the next step until you clearly indicate completion with "STEP_COMPLETED", "STEP_BLOCKED", or "STEP_NEEDS_INPUT" as specified in the system instructions.`;

    // 7. Ejecutar el step específico del plan usando el SDK ----------------------
    const stepPrompt = `Continue working on the current step. Current context: ${currentStep.description || currentStep.title}`;
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing step with prompt: "${stepPrompt}"`);
    
    let stepStatus = 'in_progress';
    let stepResult = '';
    
    const { steps, text, usage } = await client.act({
      model: anthropic(),
      tools,
      system: systemPromptWithContext,
      prompt: stepPrompt,
      onStep: async (step: any) => {
        // Handle step siguiendo el patrón de Python
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: ${step.text}`);
        
        // Detectar indicadores de estado del paso
        if (step.text) {
          if (step.text.includes('STEP_COMPLETED:')) {
            stepStatus = 'completed';
            stepResult = step.text;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ Step completion detected: ${step.text}`);
          } else if (step.text.includes('STEP_BLOCKED:')) {
            stepStatus = 'blocked';
            stepResult = step.text;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ Step blocked detected: ${step.text}`);
          } else if (step.text.includes('STEP_NEEDS_INPUT:')) {
            stepStatus = 'needs_input';
            stepResult = step.text;
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ Step needs input detected: ${step.text}`);
          }
        }
        
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
            detected_status: stepStatus,
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      },
    });

    // 8. Detectar estado final si no se detectó durante la ejecución --------------
    if (stepStatus === 'in_progress' && text) {
      if (text.includes('STEP_COMPLETED:')) {
        stepStatus = 'completed';
        stepResult = text;
      } else if (text.includes('STEP_BLOCKED:')) {
        stepStatus = 'blocked';
        stepResult = text;
      } else if (text.includes('STEP_NEEDS_INPUT:')) {
        stepStatus = 'needs_input';
        stepResult = text;
      }
    }

    // Usar el resultado detectado o el texto final
    const finalResult = stepResult || text || 'Step execution completed';
    
    // 9. Actualizar el step según el estado detectado ------------------------------
    const updateData: any = {
      result: finalResult,
    };

    if (stepStatus === 'completed') {
      updateData.status = 'completed';
      updateData.completed_at = new Date().toISOString();
    } else if (stepStatus === 'blocked') {
      updateData.status = 'blocked';
      updateData.completed_at = new Date().toISOString();
    } else if (stepStatus === 'needs_input') {
      updateData.status = 'waiting_for_input';
      updateData.completed_at = new Date().toISOString();
    } else {
      // Si no se detectó ningún indicador específico, mantener como in_progress
      updateData.status = 'in_progress';
    }

    await supabaseAdmin
      .from('instance_plan_steps')
      .update(updateData)
      .eq('id', currentStep.id);

    // 10. Guardar el resultado final del step --------------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: finalResult,
      details: {
        final_text: text,
        total_steps: steps.length,
        usage: usage,
        remote_instance_id: remoteInstance.id,
        plan_step_id: currentStep.id,
        plan_step_title: currentStep.title,
        plan_step_status: stepStatus,
        detected_result: stepResult
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    // 11. Actualizar métricas del plan solo si el step está completado ------------
    let newStepsCompleted = plan.steps_completed ?? 0;
    if (stepStatus === 'completed') {
      newStepsCompleted = newStepsCompleted + 1;
      await supabaseAdmin.from('instance_plans').update({
        steps_completed: newStepsCompleted,
        progress_percentage: Math.min(100, newStepsCompleted * 10), // Asumiendo 10 steps max
        last_executed_at: new Date().toISOString(),
      }).eq('id', instance_plan_id);
    } else {
      // Solo actualizar timestamp sin cambiar steps completados
      await supabaseAdmin.from('instance_plans').update({
        last_executed_at: new Date().toISOString(),
      }).eq('id', instance_plan_id);
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Plan step executed with status: ${stepStatus}`);

    return NextResponse.json({ 
      message: `Plan step executed with status: ${stepStatus}`,
      step_title: currentStep.title,
      step_status: stepStatus,
      response: finalResult,
      steps_executed: steps.length,
      token_usage: usage,
      remote_instance_id: remoteInstance.id,
      plan_progress: newStepsCompleted,
      requires_continuation: stepStatus === 'in_progress',
      requires_input: stepStatus === 'needs_input',
      is_blocked: stepStatus === 'blocked',
      user_instruction_added: !!user_instruction,
      updated_plan_total: user_instruction ? (plan.steps_total || 1) + 1 : (plan.steps_total || 1)
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
      step_failed: currentStep?.title || 'Unknown step',
      step_status: 'failed'
    }, { status: 500 });
  }
}