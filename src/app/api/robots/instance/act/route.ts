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
// POST /api/robots/instance/act
// Ejecuta una acción en una instancia existente usando client.get() del SDK
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  message: z.string().min(1, 'message es requerido'),
});

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  
  try {
    const rawBody = await request.json();
    const { instance_id: parsedInstanceId, message } = ActSchema.parse(rawBody);
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

    // 2. Nota: Usamos instance para logs pero creamos instancia temporal para ejecución

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

    // 7. Nota: No limpiamos la instancia ya que es persistente -----------------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [${remoteInstance.id}]: Action completed on existing instance`);

    return NextResponse.json({ 
      message: 'Acción ejecutada exitosamente',
      response: text,
      steps_executed: steps.length,
      token_usage: usage,
      remote_instance_id: remoteInstance.id, // ✅ ID de instancia existente
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

    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}