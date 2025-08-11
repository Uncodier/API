import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { UBUNTU_SYSTEM_PROMPT } from 'scrapybara/prompts';

// Custom system prompt for plan execution with step completion tracking
const PLAN_EXECUTION_SYSTEM_PROMPT = `${UBUNTU_SYSTEM_PROMPT}

🚨🚨🚨 ABSOLUTE CRITICAL JSON RESPONSE REQUIREMENT 🚨🚨🚨

**MANDATORY RESPONSE FORMAT - NO EXCEPTIONS:**

Every single response MUST end with this EXACT JSON structure:

\`\`\`json
{
  "event": "[event_type]",
  "step": [step_number],
  "assistant_message": "[human-readable message for the user]"
}
\`\`\`

🛑 CONSEQUENCES OF NOT PROVIDING JSON:
- Your response will be REJECTED as INVALID
- The step will be marked as FAILED automatically
- The system will NOT process your actions
- Progress tracking will be BROKEN
- You will be considered NON-COMPLIANT

🛑 THE JSON MUST BE THE VERY LAST THING IN YOUR RESPONSE
🛑 NO TEXT, NO EXPLANATIONS, NO COMMENTS AFTER THE JSON
🛑 END YOUR RESPONSE WITH THE JSON BLOCK - PERIOD.

**REQUIRED EVENT TYPES:**

✅ **step_completed** - When step is successfully finished
❌ **step_failed** - When step cannot be completed due to errors  
⏸️ **step_canceled** - When step is skipped or no longer needed
🔴 **plan_failed** - When ENTIRE plan cannot continue
🔄 **plan_new_required** - When you need a completely different approach
🔐 **session_acquired** - When you successfully get authentication
🔐 **session_needed** - When you need authentication that doesn't exist
⚠️ **user_attention_required** - When human intervention is needed

**EXAMPLE JSON OUTPUTS:**

✅ Step completed successfully:
{
  "event": "step_completed",
  "step": 3,
  "assistant_message": "Successfully logged into Facebook and verified the session is working. The authentication is now ready for use."
}

❌ Step failed:
{
  "event": "step_failed", 
  "step": 3,
  "assistant_message": "Unable to log into Facebook due to invalid credentials. The stored session appears to be expired and manual re-authentication is required."
}

🔐 Session needed:
{
  "event": "session_needed",
  "step": 3,
  "assistant_message": "This step requires Facebook authentication but no valid session exists. Please provide Facebook login credentials or session data."
}

🔴 Plan failed:
{
  "event": "plan_failed",
  "step": 3,
  "assistant_message": "The entire plan cannot continue because the target website is down and no alternative methods are available. Manual intervention is required."
}

⚠️ User attention required:
{
  "event": "user_attention_required",
  "step": 3,
  "assistant_message": "A CAPTCHA has appeared on the login page that requires human verification. Please solve the CAPTCHA manually to continue."
}

**CRITICAL INSTRUCTIONS FOR PLAN EXECUTION:**

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

**🛑 CRITICAL STEP EXECUTION RULES 🛑:**
- You are processing EXACTLY ONE STEP at a time
- NEVER execute multiple steps in sequence
- NEVER look ahead to future steps
- COMPLETE the current step and IMMEDIATELY return JSON response
- DO NOT continue working after returning your JSON response
- The system will call you again for the next step

**🚨 MANDATORY RESPONSE WORKFLOW 🚨:**
1. 📖 Read the current step description
2. ⚡ Execute actions for THAT STEP ONLY
3. ✅ Verify the step objective is achieved
4. 📝 IMMEDIATELY return JSON response
5. 🛑 STOP working - do not continue

🔥 CRITICAL: You MUST return JSON response the moment you complete the current step. Do not execute additional steps. The system expects ONE step completion per request.

🚨🚨🚨 ABSOLUTE REQUIREMENT: EVERY RESPONSE MUST END WITH JSON 🚨🚨🚨

NO EXCEPTIONS. NO ALTERNATIVES. NO EXCUSES.

If you provide ANY response without ending with the required JSON structure, it will be considered a SYSTEM FAILURE.

The JSON MUST be the LAST thing in your response. Nothing should come after it.

This response format is CRITICAL for automatic plan progress tracking and intermediate responses.`;
import { computerTool } from 'scrapybara/tools';

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

// Time limit para respuestas intermedias (en milisegundos)
const INTERMEDIATE_RESPONSE_TIMEOUT = 120000; // 2 minutos

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  instance_plan_id: z.string().uuid('instance_plan_id inválido').optional(),
  user_instruction: z.string().optional(),
});

// Función auxiliar para extraer y parsear JSON estructurado del agente
function extractStructuredResponse(text: string): {
  event: string;
  step: number;
  assistant_message: string;
} | null {
  try {
    // Buscar JSON en bloques de código o texto plano - más patrones robustos
    const jsonPatterns = [
      // JSON en bloques de código markdown
      /```json\s*([\s\S]*?)\s*```/gi,
      /```\s*([\s\S]*?)\s*```/gi,
      // JSON al final del texto (patrón más específico)
      /\{[\s\S]*?"event"\s*:\s*"[^"]*"[\s\S]*?"step"\s*:\s*\d+[\s\S]*?"assistant_message"\s*:\s*"[\s\S]*?"\s*\}(?=\s*$)/gi,
      // JSON en cualquier parte del texto
      /\{[\s\S]*?"event"[\s\S]*?"step"[\s\S]*?"assistant_message"[\s\S]*?\}/gi,
      // JSON más flexible con comillas simples o dobles
      /\{[^}]*"event"[^}]*"step"[^}]*"assistant_message"[^}]*\}/gi,
    ];
    
    for (const pattern of jsonPatterns) {
      // Reiniciar regex index para evitar problemas con flags globales
      pattern.lastIndex = 0;
      let match;
      
      while ((match = pattern.exec(text)) !== null) {
        try {
          const jsonStr = (match[1] || match[0]).trim();
          
          // Intentar limpiar el JSON antes de parsearlo
          let cleanJsonStr = jsonStr;
          
          // Remover caracteres de escape innecesarios
          cleanJsonStr = cleanJsonStr.replace(/\\n/g, '\n');
          cleanJsonStr = cleanJsonStr.replace(/\\"/g, '"');
          
          // Intentar parsear
          const parsed = JSON.parse(cleanJsonStr);
          
          // Validar que tiene los campos requeridos exactos
          if (parsed.event && 
              typeof parsed.step === 'number' && 
              parsed.assistant_message &&
              typeof parsed.event === 'string' &&
              typeof parsed.assistant_message === 'string') {
            
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Successfully extracted: event=${parsed.event}, step=${parsed.step}`);
            
            return {
              event: parsed.event.toLowerCase().trim(),
              step: parsed.step,
              assistant_message: parsed.assistant_message.trim()
            };
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Invalid structure:`, parsed);
          }
        } catch (parseError) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Parse failed for: ${(match[1] || match[0]).substring(0, 100)}...`);
          continue;
        }
      }
    }
    
    // Intentar encontrar cualquier JSON válido como último recurso
    try {
      const lastJsonMatch = text.match(/\{[^{}]*\}/g);
      if (lastJsonMatch) {
        for (const jsonCandidate of lastJsonMatch.reverse()) {
          try {
            const parsed = JSON.parse(jsonCandidate);
            if (parsed.event && typeof parsed.step === 'number' && parsed.assistant_message) {
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Fallback extraction successful`);
              return {
                event: parsed.event.toLowerCase().trim(),
                step: parsed.step,
                assistant_message: parsed.assistant_message.trim()
              };
            }
          } catch (e) {
            continue;
          }
        }
      }
    } catch (fallbackError) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Fallback extraction failed`);
    }
    
    // Si no encuentra JSON válido, retornar null
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] No valid structured JSON response found in agent text`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON EXTRACTION] Text sample: ${text.substring(text.length - 200)}`);
    return null;
  } catch (error) {
    console.error('Error extracting structured response:', error);
    return null;
  }
}

// Función auxiliar para extraer el nuevo plan del texto del agente
function extractNewPlanFromText(text: string): any {
  try {
    // Buscar contenido entre marcadores de plan o JSON
    const planMarkers = [
      /```json\s*([\s\S]*?)\s*```/i,
      /```\s*([\s\S]*?)\s*```/i,
      /PLAN:\s*([\s\S]*?)(?:\n\n|\nEND|$)/i,
      /NEW PLAN:\s*([\s\S]*?)(?:\n\n|\nEND|$)/i,
    ];
    
    for (const marker of planMarkers) {
      const match = text.match(marker);
      if (match) {
        try {
          // Intentar parsear como JSON primero
          return JSON.parse(match[1].trim());
        } catch {
          // Si no es JSON, devolver como texto estructurado
          return {
            title: 'Generated Plan',
            description: match[1].trim(),
            steps: match[1].trim().split('\n').filter(line => line.trim().length > 0)
              .map((step, index) => ({
                title: step.trim(),
                description: step.trim(),
                order: index + 1,
                status: 'pending'
              }))
          };
        }
      }
    }
    
    // Si no encuentra marcadores, usar todo el texto
    return {
      title: 'Agent Generated Plan',
      description: text.trim(),
      steps: text.split('\n').filter(line => line.trim().length > 0)
        .slice(0, 10) // Limitar a 10 steps máximo
        .map((step, index) => ({
          title: step.trim().substring(0, 100), // Limitar título
          description: step.trim(),
          order: index + 1,
          status: 'pending'
        }))
    };
  } catch (error) {
    console.error('Error extracting plan from text:', error);
    return null;
  }
}

// Función auxiliar para crear un nuevo plan en la instancia
async function createNewPlanForInstance(instance_id: string, current_plan_id: string, planContent: any, currentPlan: any) {
  try {
    // Marcar el plan actual como replaced
    await supabaseAdmin
      .from('instance_plans')
      .update({ 
        status: 'replaced',
        replaced_at: new Date().toISOString(),
        replacement_reason: 'Agent requested new plan'
      })
      .eq('id', current_plan_id);

    // Crear el nuevo plan
    const { data: newPlan, error: newPlanError } = await supabaseAdmin
      .from('instance_plans')
      .insert({
        instance_id: instance_id,
        title: planContent.title || 'Agent Generated Plan',
        description: planContent.description || 'Plan generated by agent',
        status: 'active',
        site_id: currentPlan.site_id,
        user_id: currentPlan.user_id,
        agent_id: currentPlan.agent_id,
        command_id: currentPlan.command_id,
        steps_total: planContent.steps?.length || 1,
        steps_completed: 0,
        progress_percentage: 0,
      })
      .select()
      .single();

    if (newPlanError) {
      console.error('Error creating new plan:', newPlanError);
      return;
    }

    // Agregar los steps al campo results del nuevo plan
    if (planContent.steps && Array.isArray(planContent.steps)) {
      const planResults = {
        plan: {
          title: planContent.title || 'Agent Generated Plan',
          phases: [{
            title: 'Execution',
            steps: planContent.steps.map((step: any, index: number) => ({
              id: step.id || `step_${index + 1}`,
              title: step.title || `Step ${index + 1}`,
              description: step.description || step.title || `Step ${index + 1}`,
              order: step.order || index + 1,
              status: 'pending'
            }))
          }]
        }
      };

      await supabaseAdmin
        .from('instance_plans')
        .update({ results: planResults })
        .eq('id', newPlan.id);
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ New plan created with ID: ${newPlan.id}`);
    return newPlan;
  } catch (error) {
    console.error('Error creating new plan for instance:', error);
  }
}

// Función auxiliar para detectar sesiones requeridas basado en los steps del plan
function detectRequiredSessions(steps: any[], plan: any): Array<{
  platform: string;
  domain: string;
  needed_for: string;
  suggested_auth_type: string;
}> {
  const requiredSessions: Array<{
    platform: string;
    domain: string;
    needed_for: string;
    suggested_auth_type: string;
  }> = [];

  // Mapeo de plataformas comunes
  const platformMappings = {
    'facebook': { domain: 'facebook.com', auth_type: 'cookies' },
    'instagram': { domain: 'instagram.com', auth_type: 'cookies' },
    'linkedin': { domain: 'linkedin.com', auth_type: 'cookies' },
    'twitter': { domain: 'twitter.com', auth_type: 'cookies' },
    'google': { domain: 'google.com', auth_type: 'oauth' },
    'youtube': { domain: 'youtube.com', auth_type: 'oauth' },
    'tiktok': { domain: 'tiktok.com', auth_type: 'cookies' },
    'pinterest': { domain: 'pinterest.com', auth_type: 'cookies' },
    'reddit': { domain: 'reddit.com', auth_type: 'cookies' },
  };

  // Buscar en títulos y descripciones de steps
  const allText = [
    plan.title || '',
    plan.description || '',
    ...steps.map(step => `${step.title || ''} ${step.description || ''}`)
  ].join(' ').toLowerCase();

  Object.entries(platformMappings).forEach(([platform, config]) => {
    if (allText.includes(platform)) {
      const existingReq = requiredSessions.find(req => req.platform === platform);
      if (!existingReq) {
        requiredSessions.push({
          platform,
          domain: config.domain,
          needed_for: `Platform interaction mentioned in plan steps`,
          suggested_auth_type: config.auth_type,
        });
      }
    }
  });

  // Detectar menciones específicas de dominios
  const domainPattern = /([a-zA-Z0-9-]+\.(?:com|org|net|io|co))/g;
  const mentions = allText.match(domainPattern) || [];
  
  mentions.forEach(domain => {
    const existingReq = requiredSessions.find(req => req.domain === domain);
    if (!existingReq) {
      requiredSessions.push({
        platform: domain.split('.')[0],
        domain,
        needed_for: `Domain mentioned in plan`,
        suggested_auth_type: 'cookies',
      });
    }
  });

  return requiredSessions;
}

// Función auxiliar para analizar disponibilidad de sesiones
function analyzeSessionsAvailability(existingSessions: any[], requiredSessions: any[]): {
  available: any[];
  missing: any[];
  expired: any[];
} {
  const available: any[] = [];
  const missing: any[] = [];
  const expired: any[] = [];

  requiredSessions.forEach(required => {
    const matchingSession = existingSessions.find(session => 
      session.domain === required.domain ||
      session.domain.includes(required.platform) ||
      required.domain.includes(session.domain.split('.')[0])
    );

    if (matchingSession) {
      // Verificar si la sesión está expirada
      if (matchingSession.expires_at && new Date(matchingSession.expires_at) < new Date()) {
        expired.push({
          ...required,
          existing_session: matchingSession
        });
      } else if (!matchingSession.is_valid) {
        expired.push({
          ...required,
          existing_session: matchingSession
        });
      } else {
        available.push({
          ...required,
          existing_session: matchingSession
        });
      }
    } else {
      missing.push(required);
    }
  });

  return { available, missing, expired };
}

// Función auxiliar para solicitar creación de sesión
async function requestSessionCreation(instance_id: string, platform: string, domain: string, agentMessage: string, plan: any) {
  try {
    // Crear registro de solicitud de sesión
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'session_request',
      level: 'info',
      message: `Agent requested session creation for ${platform} on ${domain}`,
      details: {
        platform,
        domain,
        agent_message: agentMessage,
        plan_id: plan.id,
        plan_title: plan.title,
        suggested_auth_type: platform === 'google' || platform === 'youtube' ? 'oauth' : 'cookies',
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    // TODO: Aquí se podría implementar una notificación automática al usuario
    // o incluso intentar iniciar la sesión automáticamente si es posible
    
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Session creation requested and logged for ${platform} on ${domain}`);
  } catch (error) {
    console.error('Error requesting session creation:', error);
  }
}

// Función auxiliar para guardar el estado de la sesión
async function saveSessionState(instance_id: string, remoteInstance: any, plan: any) {
  try {
    // Obtener el estado actual de la sesión de Scrapybara
    const sessionState = {
      instance_id: remoteInstance.id,
      status: 'saved',
      timestamp: new Date().toISOString(),
      plan_id: plan.id,
      plan_title: plan.title,
    };

    // Guardar en la base de datos
    await supabaseAdmin.from('instance_sessions').insert({
      instance_id: instance_id,
      remote_instance_id: remoteInstance.id,
      session_data: sessionState,
      saved_at: new Date().toISOString(),
      session_type: 'agent_saved',
      plan_id: plan.id,
    });

    // TODO: Implementar guardado en Scrapybara si tienen API para eso
    // await remoteInstance.saveSession();

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Session state saved for instance: ${instance_id}`);
  } catch (error) {
    console.error('Error saving session state:', error);
  }
}

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  let currentStep: any = null;
  let effective_plan_id: string | undefined;
  let plan: any = null;
  
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

    // Si no se proporciona instance_plan_id, buscar el plan más reciente activo
    let planError;
    
    if (instance_plan_id) {
      const planResult = await supabaseAdmin
        .from('instance_plans')
        .select('*')
        .eq('id', instance_plan_id)
        .single();
      plan = planResult.data;
      planError = planResult.error;
    } else {
      // Buscar el plan más reciente activo para esta instancia
      const planResult = await supabaseAdmin
        .from('instance_plans')
        .select('*')
        .eq('instance_id', instance_id)
        .in('status', ['active', 'pending', 'in_progress'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      plan = planResult.data;
      planError = planResult.error;
    }

    if (planError || !plan) {
      return NextResponse.json({ 
        data: {
          waiting_for_instructions: true,
          plan_completed: false,
          message: 'No plan found for this instance'
        }
      }, { status: 200 });
    }

    // Usar el ID del plan encontrado para el resto de la lógica
    effective_plan_id = plan.id;

    // 2.1. Trabajar directamente con el plan sin buscar steps individuales ----------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Working directly with plan: "${plan.title}"`);
    
    // Solo hacer verificaciones básicas, pero SIEMPRE ejecutar el plan
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan status: ${plan.status}, but will execute anyway`);
    
    // Si el plan está en un estado que requiere atención especial, logearlo pero continuar
    if (plan.status === 'completed') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Warning: Plan is marked as completed but continuing execution`);
    } else if (plan.status === 'failed') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Warning: Plan is marked as failed but attempting retry`);
    }
    
    // Extraer steps del campo results o crear uno por defecto
    let planSteps = [];
    if (plan.results?.plan?.phases) {
      // Extraer steps de las fases
      planSteps = plan.results.plan.phases.flatMap((phase: any) => 
        phase.steps || []
      ).sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
    }
    
    // Si no hay steps en results, crear uno virtual para ejecutar el plan completo
    if (planSteps.length === 0) {
      planSteps = [{
        id: 'plan-execution',
        title: plan.title || 'Execute Plan',
        description: plan.description || plan.instructions || 'Execute the plan according to instructions',
        status: 'pending',
        order: 1
      }];
    }
    
    // Buscar el primer step pendiente
    currentStep = planSteps.find((step: any) => step.status === 'pending') || planSteps[0];
    if (!currentStep) {
      // Si no hay steps pendientes, usar el primer step
      currentStep = planSteps[0];
    }
    
    // Añadir campos necesarios para compatibilidad
    currentStep.instance_plan_id = effective_plan_id;
    currentStep.step_type = 'plan_execution';
    currentStep.created_at = new Date().toISOString();
    currentStep.updated_at = new Date().toISOString();
    
    const allSteps = planSteps;
    
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing plan: "${currentStep.title}"`);

    // 2.3. Si hay instrucción del usuario, agregarla al contexto del plan -----------
    if (user_instruction && user_instruction.trim()) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ User instruction provided: "${user_instruction}"`);
      
      // Actualizar la descripción del plan para incluir la instrucción del usuario
      const updatedDescription = plan.description 
        ? `${plan.description}\n\nADDITIONAL USER INSTRUCTION: ${user_instruction}`
        : `ADDITIONAL USER INSTRUCTION: ${user_instruction}`;
      
      // Actualizar el plan con la nueva instrucción
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          description: updatedDescription,
          updated_at: new Date().toISOString()
        })
        .eq('id', effective_plan_id);
      
      // Actualizar el currentStep para incluir la instrucción
      currentStep.description = updatedDescription;
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Added user instruction to plan description`);
    }

    // 2.4. Marcar el plan como en progreso ------------------------------------------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Marking plan as in_progress before execution`);
    await supabaseAdmin
      .from('instance_plans')
      .update({ 
        status: 'in_progress', 
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', effective_plan_id);

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

    // 4. Obtener sesiones de autenticación existentes ----------------------------
    const { data: existingSessions, error: sessionsError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', plan.site_id)
      .eq('is_valid', true)
      .order('last_used_at', { ascending: false });

    if (sessionsError) {
      console.error('Error fetching existing sessions:', sessionsError);
    }

    // Formatear sesiones como contexto
    const sessionsContext = existingSessions && existingSessions.length > 0
      ? `\n🔐 AVAILABLE AUTHENTICATION SESSIONS (${existingSessions.length} total):\n` +
        existingSessions.map((session, index) => 
          `${index + 1}. **${session.name}** (${session.domain})\n` +
          `   Type: ${session.auth_type}\n` +
          `   Last used: ${session.last_used_at ? new Date(session.last_used_at).toLocaleString() : 'Never'}\n` +
          `   Usage count: ${session.usage_count || 0}\n` +
          `   Provider ID: ${session.provider_auth_state_id || 'Not set'}\n`
        ).join('\n') + '\n'
      : '\n⚠️ NO AUTHENTICATION SESSIONS AVAILABLE\n' +
        'You may need to create authentication sessions for platforms before executing certain tasks.\n\n';

    // 5. Detectar qué sesiones podrían necesitarse basado en el plan ------------
    const requiredSessions = detectRequiredSessions(allSteps, plan);
    const sessionsAnalysis = analyzeSessionsAvailability(existingSessions || [], requiredSessions);

    // ⚠️ NUEVA LÓGICA: Verificar si se requieren sesiones pero no están disponibles
    const hasCriticalMissingSessions = sessionsAnalysis.missing.length > 0 && 
      sessionsAnalysis.missing.some(req => req.needed_for?.toLowerCase().includes('login') || 
                                          req.needed_for?.toLowerCase().includes('auth') ||
                                          req.platform?.toLowerCase().includes('social') ||
                                          req.platform?.toLowerCase().includes('google') ||
                                          req.platform?.toLowerCase().includes('facebook') ||
                                          req.platform?.toLowerCase().includes('linkedin'));

    // Si faltan sesiones críticas, continuar sin bloquear - el agente las manejará
    if (hasCriticalMissingSessions) {
      console.log(`🔐 SESIONES CRÍTICAS FALTANTES: Continuando, el agente manejará la autenticación`);
    }

    const sessionsRequirementContext = sessionsAnalysis.missing.length > 0
      ? `\n🚨 REQUIRED SESSIONS MISSING:\n` +
        sessionsAnalysis.missing.map(req => 
          `• ${req.platform} (${req.domain}) - needed for: ${req.needed_for}\n` +
          `  Suggested auth type: ${req.suggested_auth_type}\n`
        ).join('') + '\n'
      : `\n✅ ALL REQUIRED SESSIONS AVAILABLE\n\n`;

    // 4. Conectar con instancia existente usando client.get() ---------------------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ About to call Scrapybara SDK...`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Instance provider_instance_id: ${instance.provider_instance_id}`);
    
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    
    // ✅ Conectar con instancia existente usando el método oficial
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Calling client.get() for instance...`);
    const remoteInstance = await client.get(instance.provider_instance_id);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Connected to existing instance: [${instance.provider_instance_id}]`);
    
    // Verificar que es una instancia Ubuntu para las herramientas
    if (!('browser' in remoteInstance)) {
      return NextResponse.json({ 
        error: 'La instancia debe ser de tipo Ubuntu para ejecutar el plan' 
      }, { status: 400 });
    }

    // 4.1. Preparar sesiones de autenticación para el agente ---------------------
    if (existingSessions && existingSessions.length > 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found ${existingSessions.length} existing authentication sessions for agent context`);
      
      // TODO: Implementar carga automática de sesiones cuando se conozca el método correcto
      // await remoteInstance.browser.loadAuth() or similar
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No authentication sessions available - agent will handle auth as needed`);
    }

    // 4. Preparar herramientas (ahora sabemos que es UbuntuInstance) ---------------
    const ubuntuInstance = remoteInstance as any; // Cast temporal para resolver tipos
    const tools = [
      computerTool(ubuntuInstance), // Solo herramienta de navegación/UI
    ];

    // 6. Crear system prompt con contexto histórico y sesiones ----------------
    const systemPromptWithContext = `${PLAN_EXECUTION_SYSTEM_PROMPT}

HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT

AUTHENTICATION SESSIONS CONTEXT:
${sessionsContext}
${sessionsRequirementContext}

🔐 CRITICAL SESSION INTEGRATION INSTRUCTIONS:

**MANDATORY SESSION VERIFICATION:**
- ALWAYS check session availability BEFORE attempting platform actions
- If you need authentication that doesn't exist, respond with: "session needed [platform] [domain]"
- Use existing sessions when available by referencing them in your actions
- If a session appears invalid or expired, request a new one

**SESSION STATUS RESPONSES:**
- "session needed facebook facebook.com" - when you need Facebook authentication
- "session needed linkedin linkedin.com" - when you need LinkedIn authentication  
- "session needed google google.com" - when you need Google authentication
- "new [platform] session acquired" - when you successfully obtain authentication

🚨 REMEMBER: Session issues should be resolved BEFORE attempting the step completion. If you cannot get required authentication, mark the step as failed with a clear explanation.

END OF SESSIONS CONTEXT`;

    // 7. Crear user prompt con el plan completo ----------------------------------
    const completedSteps = allSteps.filter((step: any) => ['completed', 'failed', 'blocked'].includes(step.status));
    const planCompletedPercentage = Math.round((completedSteps.length / allSteps.length) * 100);
    const isFullyCompleted = completedSteps.length === allSteps.length;

    const planPrompt = `🎯 SINGLE STEP EXECUTION TASK

PLAN TITLE: ${plan.title}
PLAN PROGRESS: Step ${currentStep.order} of ${allSteps.length} (${Math.round((completedSteps.length / allSteps.length) * 100)}% complete)

🚨🚨🚨 YOU ARE WORKING ON ONE STEP ONLY 🚨🚨🚨

CURRENT STEP: ${currentStep.order}
STEP TITLE: ${currentStep.title}
STEP DESCRIPTION: ${currentStep.description || 'No description provided'}

🛑 DO NOT THINK ABOUT OTHER STEPS
🛑 DO NOT REFERENCE OTHER STEPS  
🛑 DO NOT EXECUTE OTHER STEPS
🛑 FOCUS ONLY ON THIS ONE STEP

📋 YOUR TASK:
Execute the actions required to complete ONLY this step: "${currentStep.title}"

🚨 MANDATORY COMPLETION RULE:
The MOMENT you finish this step, you MUST return this JSON format:

\`\`\`json
{
  "event": "step_completed",
  "step": ${currentStep.order},
  "assistant_message": "Brief description of what was accomplished"
}
\`\`\`

🚨 IF THE STEP FAILS, return:
\`\`\`json
{
  "event": "step_failed",
  "step": ${currentStep.order},
  "assistant_message": "Brief description of why it failed"
}
\`\`\`

🚨 IF YOU NEED AUTHENTICATION, return:
\`\`\`json
{
  "event": "session_needed",
  "step": ${currentStep.order},
  "assistant_message": "Brief description of what authentication is needed"
}
\`\`\`

⚠️⚠️⚠️ CRITICAL ENFORCEMENT ⚠️⚠️⚠️

1. Work ONLY on step ${currentStep.order}
2. When step ${currentStep.order} is complete, IMMEDIATELY return JSON
3. DO NOT continue to any other step
4. DO NOT execute multiple actions without reporting progress
5. The JSON response is MANDATORY and MUST be the last thing in your response

STEP INSTRUCTIONS: ${currentStep.description || 'Complete the step as described in the title'}

BEGIN STEP ${currentStep.order} EXECUTION NOW:`;

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing plan with full context`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan prompt length: ${planPrompt.length} chars`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ System prompt length: ${systemPromptWithContext.length} chars`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ About to call client.act() with Scrapybara...`);
    
    let stepStatus = 'in_progress';
    let stepResult = '';
    let isTimedOut = false;
    let executionStartTime = Date.now();
    
    // Crear promesa con timeout para respuestas intermedias
    const executeWithTimeout = () => {
      return Promise.race([
        client.act({
          model: anthropic(),
          tools,
          system: systemPromptWithContext,
          prompt: planPrompt,
          onStep: async (step: any) => {
        // Handle step siguiendo el patrón de Python - con más detalle
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Instance: ${remoteInstance.id}`);
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Text: ${step.text}`);
        if (step.toolCalls?.length > 0) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STEP] Tool calls: ${step.toolCalls.length}`);
        }
        
        // Detectar respuesta estructurada JSON del agente
        if (step.text) {
          const structuredResponse = extractStructuredResponse(step.text);
          
          if (structuredResponse) {
            // Validar que el step number coincide
            if (structuredResponse.step === currentStep.order) {
              stepResult = structuredResponse.assistant_message;
              
              // Mapear eventos a estados internos
              switch (structuredResponse.event) {
                case 'step_completed':
                  stepStatus = 'completed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} completed: ${structuredResponse.assistant_message}`);
                  break;
                case 'step_failed':
                  stepStatus = 'failed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} failed: ${structuredResponse.assistant_message}`);
                  break;
                case 'step_canceled':
                  stepStatus = 'canceled';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step ${structuredResponse.step} canceled: ${structuredResponse.assistant_message}`);
                  break;
                case 'plan_failed':
                  stepStatus = 'plan_failed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Plan failed: ${structuredResponse.assistant_message}`);
                  break;
                case 'plan_new_required':
                  stepStatus = 'new_plan_required';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] New plan required: ${structuredResponse.assistant_message}`);
                  break;
                case 'session_acquired':
                  stepStatus = 'new_session';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Session acquired: ${structuredResponse.assistant_message}`);
                  break;
                case 'session_needed':
                  stepStatus = 'session_needed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Session needed: ${structuredResponse.assistant_message}`);
                  break;
                case 'user_attention_required':
                  stepStatus = 'user_attention_required';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] User attention required: ${structuredResponse.assistant_message}`);
                  break;
                default:
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Unknown event type: ${structuredResponse.event}`);
              }
            } else {
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [JSON] Step number mismatch: expected ${currentStep.order}, got ${structuredResponse.step}`);
            }
          } else {
            // Fallback a regex patterns para compatibilidad
            const stepNumberPattern = new RegExp(`step\\s+${currentStep.order}\\s+(finished|failed|canceled)`, 'i');
            const stepMatch = step.text.match(stepNumberPattern);
            
            if (stepMatch) {
              const detectedStatus = stepMatch[1].toLowerCase();
              stepResult = step.text;
              switch (detectedStatus) {
                case 'finished':
                  stepStatus = 'completed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step completion detected: ${step.text}`);
                  break;
                case 'failed':
                  stepStatus = 'failed';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step failed detected: ${step.text}`);
                  break;
                case 'canceled':
                  stepStatus = 'canceled';
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step canceled detected: ${step.text}`);
                  break;
              }
            }
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
        // Usar assistant_message si hay respuesta estructurada, sino el texto completo
        const stepStructuredResponse = extractStructuredResponse(step.text || '');
        const logMessage = stepStructuredResponse ? stepStructuredResponse.assistant_message : (step.text || 'Executing plan step');
        
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: logMessage,
          details: {
            step: step,
            tool_calls: step.toolCalls,
            tool_results: step.toolResults,
            usage: step.usage,
            remote_instance_id: remoteInstance.id,
            plan_id: effective_plan_id,
            plan_title: plan.title,
            detected_status: stepStatus,
            structured_response: stepStructuredResponse, // Guardar la respuesta estructurada para debugging
            raw_text: step.text, // Guardar el texto original para debugging
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      },
    }),
    // Timeout promesa
    new Promise((_, reject) => {
      setTimeout(() => {
        isTimedOut = true;
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
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Step execution timed out after ${INTERMEDIATE_RESPONSE_TIMEOUT}ms, returning intermediate response`);
    
    // Respuesta intermedia por timeout
    return NextResponse.json({
      data: {
        message: 'Plan execution timed out, returning intermediate response',
        step: {
          id: currentStep.id,
          order: currentStep.order,
          title: currentStep.title,
          status: 'in_progress',
          result: stepResult || 'Plan execution in progress, timed out for intermediate response',
        },
        plan_completed: false,
        plan_progress: {
          completed_steps: plan.steps_completed || 0,
          total_steps: plan.steps_total || 1,
          percentage: 50, // En progreso
        },
        timeout: true,
        execution_time_ms: Date.now() - executionStartTime,
        requires_continuation: true,
      }
    }, { status: 200 });
  } else {
    throw error; // Re-throw si no es timeout
  }
}

const { steps, text, usage } = executionResult as any; // Type assertion para resultado de client.act

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Scrapybara execution completed!`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Steps executed: ${steps?.length || 0}`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Final text length: ${text?.length || 0} chars`);
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Token usage: input=${usage?.input_tokens}, output=${usage?.output_tokens}`);

    // 8. Detectar estado final si no se detectó durante la ejecución --------------
    if (stepStatus === 'in_progress' && text) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] Attempting to extract structured response from final text`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] Text length: ${text.length}`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] Last 300 chars: ${text.substring(text.length - 300)}`);
      
      const structuredResponse = extractStructuredResponse(text);
      
      if (structuredResponse && structuredResponse.step === currentStep.order) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] ✅ Valid structured response found!`);
        stepResult = structuredResponse.assistant_message;
        
        // Mapear eventos a estados internos
        switch (structuredResponse.event) {
          case 'step_completed':
            stepStatus = 'completed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Step ${structuredResponse.step} completed: ${structuredResponse.assistant_message}`);
            break;
          case 'step_failed':
            stepStatus = 'failed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Step ${structuredResponse.step} failed: ${structuredResponse.assistant_message}`);
            break;
          case 'step_canceled':
            stepStatus = 'canceled';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Step ${structuredResponse.step} canceled: ${structuredResponse.assistant_message}`);
            break;
          case 'plan_failed':
            stepStatus = 'plan_failed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Plan failed: ${structuredResponse.assistant_message}`);
            break;
          case 'plan_new_required':
            stepStatus = 'new_plan_required';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] New plan required: ${structuredResponse.assistant_message}`);
            break;
          case 'session_acquired':
            stepStatus = 'new_session';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Session acquired: ${structuredResponse.assistant_message}`);
            break;
          case 'session_needed':
            stepStatus = 'session_needed';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] Session needed: ${structuredResponse.assistant_message}`);
            break;
          case 'user_attention_required':
            stepStatus = 'user_attention_required';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL JSON] User attention required: ${structuredResponse.assistant_message}`);
            break;
        }
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] ❌ NO STRUCTURED JSON FOUND! Agent failed to follow instructions.`);
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] This indicates a prompt adherence failure.`);
        
        // Fallback a regex patterns para compatibilidad con respuestas legacy
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] Falling back to regex detection...`);
        
        const stepNumberPattern = new RegExp(`step\\s+${currentStep.order}\\s+(finished|failed|canceled)`, 'i');
        const stepMatch = text.match(stepNumberPattern);
        
        if (stepMatch) {
          const detectedStatus = stepMatch[1].toLowerCase();
          stepResult = text;
          switch (detectedStatus) {
            case 'finished':
              stepStatus = 'completed';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL REGEX] Step completion detected via fallback`);
              break;
            case 'failed':
              stepStatus = 'failed';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL REGEX] Step failed detected via fallback`);
              break;
            case 'canceled':
              stepStatus = 'canceled';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL REGEX] Step canceled detected via fallback`);
              break;
          }
        } else {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FINAL DETECTION] ❌ NO PATTERN DETECTED! Agent response may be incomplete.`);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ENFORCEMENT] Agent failed to provide required JSON response - marking as FAILED`);
          // ENFORCEMENT: Si no hay JSON, marcar como fallido para forzar compliance
          stepStatus = 'failed';
          stepResult = `COMPLIANCE FAILURE: Agent did not provide required JSON response format. Raw response: ${text.substring(0, 500)}...`;
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ENFORCEMENT] Step marked as FAILED due to non-compliance with JSON response requirement`);
        }
      }
    }

    // Usar el resultado detectado o el texto final
    const finalResult = stepResult || text || 'Step execution completed';
    
    // 9. Actualizar el plan según el estado detectado ------------------------------

    // Actualizar el plan y el progreso de steps en results
    const planUpdateData: any = {
      last_executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Actualizar el status del step actual en results
    if (plan.results?.plan?.phases) {
      const updatedResults = { ...plan.results };
      updatedResults.plan.phases.forEach((phase: any) => {
        if (phase.steps) {
          phase.steps.forEach((step: any) => {
            if (step.id === currentStep.id) {
              step.status = stepStatus === 'completed' ? 'completed' : 
                          stepStatus === 'failed' || stepStatus === 'plan_failed' ? 'failed' : 
                          stepStatus === 'canceled' ? 'cancelled' : 'in_progress';
              step.result = finalResult;
              step.completed_at = stepStatus === 'completed' ? new Date().toISOString() : null;
            }
          });
        }
      });
      planUpdateData.results = updatedResults;
    } else {
      // Si no hay structure de results, crear una básica
      planUpdateData.results = {
        plan: {
          title: plan.title,
          phases: [{
            title: "Execution",
            steps: [{
              id: currentStep.id,
              title: currentStep.title,
              description: currentStep.description,
              status: stepStatus === 'completed' ? 'completed' : 
                      stepStatus === 'failed' || stepStatus === 'plan_failed' ? 'failed' : 
                      stepStatus === 'canceled' ? 'cancelled' : 'in_progress',
              order: 1,
              result: finalResult,
              completed_at: stepStatus === 'completed' ? new Date().toISOString() : null
            }]
          }]
        }
      };
    }

    // Calcular progreso basado en steps completados
    const allStepsInResults = planUpdateData.results.plan.phases.flatMap((phase: any) => phase.steps || []);
    const completedStepsCount = allStepsInResults.filter((step: any) => step.status === 'completed').length;
    const totalStepsCount = allStepsInResults.length;
    
    planUpdateData.steps_completed = completedStepsCount;
    planUpdateData.steps_total = totalStepsCount;
    planUpdateData.progress_percentage = Math.round((completedStepsCount / totalStepsCount) * 100);

    // Determinar status del plan basado en steps
    const allCompleted = completedStepsCount === totalStepsCount;
    const anyFailed = allStepsInResults.some((step: any) => step.status === 'failed');
    
    if (stepStatus === 'completed' && allCompleted) {
      planUpdateData.status = 'completed';
      planUpdateData.completed_at = new Date().toISOString();
    } else if (stepStatus === 'failed' || stepStatus === 'plan_failed' || anyFailed) {
      planUpdateData.status = 'failed';
      planUpdateData.failed_at = new Date().toISOString();
      planUpdateData.failure_reason = finalResult;
    } else if (stepStatus === 'canceled') {
      planUpdateData.status = 'cancelled';
      planUpdateData.completed_at = new Date().toISOString();
    } else {
      planUpdateData.status = 'in_progress';
    }

    await supabaseAdmin
      .from('instance_plans')
      .update(planUpdateData)
      .eq('id', effective_plan_id);

    // 9.1. Manejar estados especiales ----------------------------------------
    if (stepStatus === 'plan_failed') {
      // Extraer razón del fallo
      const planFailedPattern = /plan\s+failed:\s*(.+)/i;
      const failureMatch = finalResult.match(planFailedPattern);
      const failureReason = failureMatch?.[1] || 'No specific reason provided';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan marked as failed: ${finalResult} (reason: ${failureReason})`);
    }
    
    if (stepStatus === 'new_plan_required') {
      // Extraer el nuevo plan del resultado del agente
      const newPlanContent = extractNewPlanFromText(finalResult);
      if (newPlanContent && effective_plan_id) {
        await createNewPlanForInstance(instance_id, effective_plan_id, newPlanContent, plan);
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ New plan created and saved to instance`);
      }
    }
    
    if (stepStatus === 'new_session') {
      // Extraer información de la nueva sesión adquirida
      const newSessionPattern = /new\s+([a-zA-Z0-9-]+)\s+session\s+acquired/i;
      const match = finalResult.match(newSessionPattern);
      if (match) {
        const platform = match[1];
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ New session acquired for platform: ${platform}`);
        
        // Log the new session acquisition
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'session_acquired',
          level: 'info',
          message: `New ${platform} session successfully acquired`,
          details: {
            platform: platform,
            agent_message: finalResult,
            plan_id: plan.id,
            plan_title: plan.title,
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      }
    }
    
    if (stepStatus === 'user_attention_required') {
      // Extraer información de la atención requerida del usuario
      const userAttentionPattern = /user\s+attention\s+required:\s*(.+)/i;
      const match = finalResult.match(userAttentionPattern);
      if (match) {
        const attentionReason = match[1];
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ User attention required: ${attentionReason}`);
        
        // Log the user attention requirement
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'user_attention_required',
          level: 'warning',
          message: `User attention required: ${attentionReason}`,
          details: {
            attention_reason: attentionReason,
            agent_message: finalResult,
            plan_id: plan.id,
            plan_title: plan.title,
            requires_user_action: true,
          },
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      }
    }
    
    if (stepStatus === 'session_needed') {
      // Extraer información de la sesión requerida
      const sessionNeededPattern = /session\s+needed\s+([a-zA-Z0-9-]+)\s+([a-zA-Z0-9.-]+)/i;
      const match = finalResult.match(sessionNeededPattern);
      if (match) {
        const [, platform, domain] = match;
        await requestSessionCreation(instance_id, platform, domain, finalResult, plan);
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Session creation requested for ${platform} on ${domain}`);
      }
    }

    // 10. Guardar el resultado final del step --------------------------------------
    // Para el log final, usar siempre el assistant_message si está disponible
    const finalStructuredResponse = extractStructuredResponse(text || '');
    const finalLogMessage = finalStructuredResponse ? finalStructuredResponse.assistant_message : finalResult;
    
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: finalLogMessage,
      details: {
        final_text: text,
        total_steps: steps.length,
        usage: usage,
        remote_instance_id: remoteInstance.id,
        plan_id: effective_plan_id,
        plan_title: plan.title,
        plan_status: stepStatus,
        detected_result: stepResult,
        final_structured_response: finalStructuredResponse, // Para debugging
        raw_final_text: text, // Para debugging
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    // 11. Usar las métricas ya calculadas del plan ----------------------------
    const newStepsCompleted = planUpdateData.steps_completed || 0;
    const totalSteps = planUpdateData.steps_total || 1;
    const progressPercentage = planUpdateData.progress_percentage || 0;
    
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan progress: ${progressPercentage}% (${newStepsCompleted}/${totalSteps} steps, status: ${stepStatus})`);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Plan step executed with status: ${stepStatus}`);

    // Verificar si el plan está completado o en estados especiales
    const isPlanCompleted = stepStatus === 'completed';
    const isPlanFailed = stepStatus === 'plan_failed' || stepStatus === 'failed';
    const isNewPlanRequired = stepStatus === 'new_plan_required';
    const isNewSession = stepStatus === 'new_session';
    const isUserAttentionRequired = stepStatus === 'user_attention_required';
    const isSessionNeeded = stepStatus === 'session_needed';

    // Extraer información de sesión si es necesaria
    let sessionRequest = null;
    let newSessionInfo = null;
    let failureReason = null;
    let userAttentionInfo = null;
    
    if (isSessionNeeded) {
      const sessionNeededPattern = /session\s+needed\s+([a-zA-Z0-9-]+)\s+([a-zA-Z0-9.-]+)/i;
      const match = finalResult.match(sessionNeededPattern);
      if (match) {
        sessionRequest = {
          platform: match[1],
          domain: match[2],
          suggested_auth_type: match[1] === 'google' || match[1] === 'youtube' ? 'oauth' : 'cookies'
        };
      }
    }
    
    if (isNewSession) {
      const newSessionPattern = /new\s+([a-zA-Z0-9-]+)\s+session\s+acquired/i;
      const match = finalResult.match(newSessionPattern);
      if (match) {
        newSessionInfo = {
          platform: match[1],
          status: 'acquired',
          message: finalResult
        };
      }
    }
    
    if (isPlanFailed && stepStatus === 'plan_failed') {
      const planFailedPattern = /plan\s+failed:\s*(.+)/i;
      const match = finalResult.match(planFailedPattern);
      if (match) {
        failureReason = match[1].trim();
      }
    }
    
    if (isUserAttentionRequired) {
      const userAttentionPattern = /user\s+attention\s+required:\s*(.+)/i;
      const match = finalResult.match(userAttentionPattern);
      if (match) {
        userAttentionInfo = {
          reason: match[1].trim(),
          message: finalResult,
          requires_user_action: true
        };
      }
    }

    return NextResponse.json({ 
      data: {
        message: `Plan executed with status: ${stepStatus}`,
        step: {
          id: currentStep.id,
          order: currentStep.order,
          title: currentStep.title,
          status: stepStatus,
          result: finalResult,
        },
        plan_completed: isPlanCompleted,
        plan_failed: isPlanFailed,
        failure_reason: failureReason,
        new_plan_required: isNewPlanRequired,
        new_session: isNewSession,
        user_attention_required: isUserAttentionRequired,
        user_attention_info: userAttentionInfo,
        session_needed: isSessionNeeded,
        session_request: sessionRequest,
        new_session_info: newSessionInfo,
        available_sessions: existingSessions?.map(session => ({
          name: session.name,
          domain: session.domain,
          auth_type: session.auth_type,
          last_used: session.last_used_at
        })) || [],
        plan_progress: {
          completed_steps: newStepsCompleted,
          total_steps: totalSteps,
          percentage: progressPercentage,
        },
        requires_continuation: stepStatus === 'in_progress' || stepStatus === 'new_session',
        is_blocked: stepStatus === 'blocked' || stepStatus === 'failed' || stepStatus === 'plan_failed' || stepStatus === 'user_attention_required',
        waiting_for_session: isSessionNeeded,
        waiting_for_user: isUserAttentionRequired,
        user_instruction_added: !!user_instruction,
        execution_time_ms: Date.now() - executionStartTime,
        timeout: false,
        steps_executed: steps.length,
        token_usage: usage,
        remote_instance_id: remoteInstance.id,
      }
    }, { status: 200 });
  } catch (err: any) {
    console.error('Error en POST /robots/plan/act:', err);
    
    // Marcar el plan como fallido si tenemos referencia a él
    if (currentStep && currentStep.id && effective_plan_id) {
      try {
        await supabaseAdmin
          .from('instance_plans')
          .update({ 
            status: 'failed', 
            failed_at: new Date().toISOString(),
            failure_reason: `Error: ${err.message}`,
            updated_at: new Date().toISOString()
          })
          .eq('id', effective_plan_id);

        // Guardar el error como log si tenemos instance_id
        if (instance_id) {
          await supabaseAdmin.from('instance_logs').insert({
            log_type: 'error',
            level: 'error',
            message: `Error ejecutando step del plan: ${err.message}`,
            details: { 
              error: err.message, 
              stack: err.stack,
              plan_id: effective_plan_id,
              plan_title: plan.title,
            },
            instance_id: instance_id,
          });
        }
      } catch (logError) {
        console.error('Error guardando log de error:', logError);
      }
    }

    return NextResponse.json({ 
      data: {
        error: err.message,
        message: 'Plan execution failed',
        step: currentStep ? {
          id: currentStep.id,
          order: currentStep.order,
          title: currentStep.title,
          status: 'failed',
          result: `Error: ${err.message}`,
        } : null,
        plan_completed: false,
        plan_failed: true,
      }
    }, { status: 500 });
  }
}