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

**REQUIRED RESPONSE FORMAT:**
You MUST respond with a specific format indicating the step or plan status. Use EXACTLY one of these formats:

**For Individual Steps:**
- "step [number] finished" - when the step is successfully completed
- "step [number] failed" - when the step cannot be completed due to errors
- "step [number] canceled" - when the step is canceled or skipped

**For Plan-Level Actions:**
- "plan failed" - when there's no recovery plan possible and the entire plan cannot continue
- "new plan" - when you need to create a completely new plan (provide the new plan details)
- "session saved" - when you need to save the current session state to database and Scrapybara

Where [number] is the actual step number you are working on. This format is MANDATORY for proper plan tracking and updates.

**EXAMPLE RESPONSES:**
- "step 3 finished"
- "step 7 failed" 
- "step 12 canceled"
- "plan failed"
- "new plan"
- "session saved"

**WHEN TO USE PLAN-LEVEL RESPONSES:**
- Use "plan failed" when encountering unrecoverable errors that make the entire plan impossible
- Use "new plan" when the current plan is no longer viable and a completely different approach is needed
- Use "session saved" when you need to persist the current state before continuing or pausing

This response format is CRITICAL for automatic plan progress tracking and intermediate responses.`;
import { bashTool, computerTool, editTool } from 'scrapybara/tools';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/plan/act
// Ejecuta el último step pendiente del plan usando instancia existente con client.get()
// Este endpoint combina la funcionalidad de /robots/instance/act y /robots/plan/act
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

// Time limit para respuestas intermedias (en milisegundos)
const INTERMEDIATE_RESPONSE_TIMEOUT = 120000; // 2 minutos

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

    // 1. Obtener registros principales
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
      return NextResponse.json({ 
        message: 'No plan found for this instance',
        data: {
          waiting_for_instructions: true,
          plan_completed: false
        },
        waiting_for_instructions: true
      }, { status: 200 });
    }

    // 2. Obtener todos los steps del plan
    const { data: allSteps, error: allStepsError } = await supabaseAdmin
      .from('instance_plan_steps')
      .select('*')
      .eq('instance_plan_id', instance_plan_id)
      .order('order', { ascending: true });

    if (allStepsError) {
      return NextResponse.json({ error: 'Error obteniendo steps del plan' }, { status: 500 });
    }

    if (!allSteps || allSteps.length === 0) {
      return NextResponse.json({ 
        message: 'No steps found in this plan',
        data: { 
          waiting_for_instructions: true,
          plan_completed: false 
        },
        waiting_for_instructions: true
      }, { status: 200 });
    }

    // 3. Buscar el primer step pendiente
    const pendingSteps = allSteps.filter(step => step.status === 'pending');
    
    if (!pendingSteps || pendingSteps.length === 0) {
      return NextResponse.json({ 
        message: 'No pending steps in this plan',
        data: { 
          plan_completed: true,
          waiting_for_instructions: false 
        }
      }, { status: 200 });
    }

    currentStep = pendingSteps[0];
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing plan step: "${currentStep.title}"`);

    // 4. Si hay instrucción del usuario, insertar como nuevo paso
    if (user_instruction && user_instruction.trim()) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ User instruction provided: "${user_instruction}"`);
      
      // Reordenar steps subsecuentes
      const { data: stepsToUpdate } = await supabaseAdmin
        .from('instance_plan_steps')
        .select('id, order')
        .eq('instance_plan_id', instance_plan_id)
        .gte('order', currentStep.order + 1)
        .order('order', { ascending: true });

      if (stepsToUpdate) {
        for (const step of stepsToUpdate) {
          await supabaseAdmin
            .from('instance_plan_steps')
            .update({ order: step.order + 1 })
            .eq('id', step.id);
        }
      }

      // Insertar nuevo paso
      await supabaseAdmin
        .from('instance_plan_steps')
        .insert({
          instance_plan_id: instance_plan_id,
          title: `User Instruction: ${user_instruction.substring(0, 50)}${user_instruction.length > 50 ? '...' : ''}`,
          description: user_instruction,
          order: currentStep.order + 1,
          status: 'pending',
          step_type: 'user_instruction',
        });

      // Actualizar total de steps
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          steps_total: (plan.steps_total || 1) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', instance_plan_id);
    }

    // 5. Marcar step actual como en progreso
    await supabaseAdmin
      .from('instance_plan_steps')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', currentStep.id);

    // 6. Obtener logs históricos para contexto
    const { data: historicalLogs } = await supabaseAdmin
      .from('instance_logs')
      .select('log_type, message, created_at, details')
      .eq('instance_id', instance_id)
      .in('log_type', ['agent_action', 'user_action'])
      .order('created_at', { ascending: true })
      .limit(20);

    const logContext = historicalLogs
      ?.map(log => `[${log.created_at}] ${log.log_type === 'agent_action' ? 'AGENT' : 'USER'}: ${log.message}`)
      .join('\n') || 'No previous logs available.';

    // 7. Conectar con instancia existente
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    const remoteInstance = await client.get(instance.provider_instance_id);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Connected to existing instance: [${instance.provider_instance_id}]`);
    
    if (!('browser' in remoteInstance)) {
      return NextResponse.json({ 
        error: 'La instancia debe ser de tipo Ubuntu para ejecutar el plan' 
      }, { status: 400 });
    }

    // 8. Preparar herramientas
    const ubuntuInstance = remoteInstance as any;
    const tools = [
      bashTool(ubuntuInstance),
      computerTool(ubuntuInstance),
      editTool(ubuntuInstance),
    ];

    // 9. Crear system prompt con contexto
    const systemPromptWithContext = `${PLAN_EXECUTION_SYSTEM_PROMPT}

HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT`;

    // 10. Crear user prompt con el plan completo
    const completedSteps = allSteps.filter(step => ['completed', 'failed', 'blocked'].includes(step.status));
    const planCompletedPercentage = Math.round((completedSteps.length / allSteps.length) * 100);

    const planPrompt = `PLAN: ${plan.title}
${plan.description ? `Description: ${plan.description}` : ''}

PLAN PROGRESS: ${completedSteps.length}/${allSteps.length} steps completed (${planCompletedPercentage}%)

COMPLETE PLAN STEPS:
${allSteps.map((step, index) => {
  const statusIndicator = step.status === 'completed' ? '✅' : 
                         step.status === 'failed' ? '❌' : 
                         step.status === 'blocked' ? '🚫' :
                         step.status === 'in_progress' ? '🔄' : '⏸️';
  const isCurrentStep = step.id === currentStep.id;
  const marker = isCurrentStep ? ' ← CURRENT STEP' : '';
  
  return `${index + 1}. [${statusIndicator}] ${step.title}${marker}
   Status: ${step.status}
   ${step.description ? `Description: ${step.description}` : ''}
   ${step.result ? `Result: ${step.result}` : ''}`;
}).join('\n\n')}

INSTRUCTIONS:
You are currently working on step ${currentStep.order}: "${currentStep.title}"
Focus ONLY on this step. When you complete it, respond with exactly: "step ${currentStep.order} finished"
If you cannot complete it, respond with: "step ${currentStep.order} failed" 
If you need to cancel it, respond with: "step ${currentStep.order} canceled"

Current step description: ${currentStep.description || 'No description provided'}`;

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing step ${currentStep.order} with full plan context`);
    
    let stepStatus = 'in_progress';
    let stepResult = '';
    let executionStartTime = Date.now();
    
    // 11. Ejecutar step con timeout
    const executeWithTimeout = () => {
      return Promise.race([
        client.act({
          model: anthropic(),
          tools,
          system: systemPromptWithContext,
          prompt: planPrompt,
          onStep: async (step: any) => {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: ${step.text}`);
            
            // Detectar estado del paso
            if (step.text) {
              const stepNumberPattern = new RegExp(`step\\s+${currentStep.order}\\s+(finished|failed|canceled)`, 'i');
              const stepMatch = step.text.match(stepNumberPattern);
              
              if (stepMatch) {
                const detectedStatus = stepMatch[1].toLowerCase();
                switch (detectedStatus) {
                  case 'finished':
                    stepStatus = 'completed';
                    stepResult = step.text;
                    break;
                  case 'failed':
                    stepStatus = 'failed';
                    stepResult = step.text;
                    break;
                  case 'canceled':
                    stepStatus = 'canceled';
                    stepResult = step.text;
                    break;
                }
              }
            }
            
            // Guardar logs
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
        }),
        // Timeout
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('TIMEOUT'));
          }, INTERMEDIATE_RESPONSE_TIMEOUT);
        })
      ]);
    };

    let executionResult;
    try {
      executionResult = await executeWithTimeout();
    } catch (error: any) {
      if (error.message === 'TIMEOUT') {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Step execution timed out, returning intermediate response`);
        
        return NextResponse.json({
          message: `Step execution timed out, returning intermediate response`,
          data: {
            step: {
              id: currentStep.id,
              order: currentStep.order,
              title: currentStep.title,
              status: 'in_progress',
              result: stepResult || 'Step execution in progress, timed out for intermediate response',
            },
            plan_completed: false,
            plan_progress: {
              completed_steps: plan.steps_completed ?? 0,
              total_steps: allSteps.length,
              percentage: Math.round(((plan.steps_completed ?? 0) / allSteps.length) * 100),
            }
          },
          step_title: currentStep.title,
          step_status: 'in_progress',
          response: stepResult || 'Step execution in progress',
          timeout: true,
          execution_time_ms: Date.now() - executionStartTime,
          requires_continuation: true,
        }, { status: 200 });
      } else {
        throw error;
      }
    }

    const { steps, text, usage } = executionResult as any;

    // 12. Detectar estado final si no se detectó durante la ejecución
    if (stepStatus === 'in_progress' && text) {
      const stepNumberPattern = new RegExp(`step\\s+${currentStep.order}\\s+(finished|failed|canceled)`, 'i');
      const stepMatch = text.match(stepNumberPattern);
      
      if (stepMatch) {
        const detectedStatus = stepMatch[1].toLowerCase();
        switch (detectedStatus) {
          case 'finished':
            stepStatus = 'completed';
            stepResult = text;
            break;
          case 'failed':
            stepStatus = 'failed';
            stepResult = text;
            break;
          case 'canceled':
            stepStatus = 'canceled';
            stepResult = text;
            break;
        }
      }
    }

    const finalResult = stepResult || text || 'Step execution completed';
    
    // 13. Actualizar el step según el estado detectado
    const updateData: any = {
      result: finalResult,
    };

    if (['completed', 'failed', 'canceled'].includes(stepStatus)) {
      updateData.status = stepStatus;
      updateData.completed_at = new Date().toISOString();
    } else {
      updateData.status = 'in_progress';
    }

    await supabaseAdmin
      .from('instance_plan_steps')
      .update(updateData)
      .eq('id', currentStep.id);

    // 14. Guardar log del resultado final
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

    // 15. Actualizar métricas del plan
    let newStepsCompleted = plan.steps_completed ?? 0;
    
    if (['completed', 'failed', 'canceled'].includes(stepStatus)) {
      const { data: finishedSteps } = await supabaseAdmin
        .from('instance_plan_steps')
        .select('id')
        .eq('instance_plan_id', instance_plan_id)
        .in('status', ['completed', 'failed', 'canceled']);
      
      newStepsCompleted = finishedSteps?.length || 0;
      const totalSteps = allSteps.length;
      const progressPercentage = Math.round((newStepsCompleted / totalSteps) * 100);
      
      await supabaseAdmin.from('instance_plans').update({
        steps_completed: newStepsCompleted,
        progress_percentage: progressPercentage,
        last_executed_at: new Date().toISOString(),
      }).eq('id', instance_plan_id);
    } else {
      await supabaseAdmin.from('instance_plans').update({
        last_executed_at: new Date().toISOString(),
      }).eq('id', instance_plan_id);
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Plan step executed with status: ${stepStatus}`);

    const isPlanCompleted = newStepsCompleted === allSteps.length;

    return NextResponse.json({ 
      message: `Plan step executed with status: ${stepStatus}`,
      data: {
        step: {
          id: currentStep.id,
          order: currentStep.order,
          title: currentStep.title,
          status: stepStatus,
          result: finalResult,
        },
        plan_completed: isPlanCompleted,
        plan_progress: {
          completed_steps: newStepsCompleted,
          total_steps: allSteps.length,
          percentage: Math.round((newStepsCompleted / allSteps.length) * 100),
        }
      },
      step_title: currentStep.title,
      step_status: stepStatus,
      response: finalResult,
      steps_executed: steps.length,
      token_usage: usage,
      remote_instance_id: remoteInstance.id,
      plan_progress: newStepsCompleted,
      requires_continuation: stepStatus === 'in_progress',
      is_blocked: stepStatus === 'blocked' || stepStatus === 'failed',
      user_instruction_added: !!user_instruction,
      updated_plan_total: user_instruction ? (plan.steps_total || 1) + 1 : (plan.steps_total || 1),
      execution_time_ms: Date.now() - executionStartTime,
      timeout: false
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error en POST /robots/instance/plan/act:', err);
    
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
      data: {
        step: currentStep ? {
          id: currentStep.id,
          order: currentStep.order,
          title: currentStep.title,
          status: 'failed',
          result: `Error: ${err.message}`,
        } : null,
        plan_completed: false,
      },
      step_failed: currentStep?.title || 'Unknown step',
      step_status: 'failed'
    }, { status: 500 });
  }
}









