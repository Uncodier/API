import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { anthropic } from 'scrapybara/anthropic';
import { UBUNTU_SYSTEM_PROMPT } from 'scrapybara/prompts';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/act
// Ejecuta una acción directa en la instancia usando un mensaje/prompt del usuario
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  message: z.string().min(1, 'message es requerido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id, message } = ActSchema.parse(rawBody);

    // 1. Obtener la instancia ------------------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // 2. Verificar que la instancia esté activa ------------------------------------
    if (instance.status !== 'running') {
      return NextResponse.json({ 
        error: 'La instancia debe estar en estado running para ejecutar acciones' 
      }, { status: 400 });
    }

    // 3. Guardar el log del mensaje del usuario -----------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user',
      level: 'info',
      message: message,
      details: { user_message: message },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });

    // 4. Conectar a la instancia vía Scrapybara -----------------------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });

    // Reanudar la instancia existente
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const remoteInstance = await client.resumeInstance(instance.provider_instance_id ?? instance.id);

    // Asegurar que el navegador esté iniciado si está disponible
    try {
      await remoteInstance.browser.start();
    } catch (error) {
      // Si falla el navegador, continuamos sin él (puede ser una instancia que no lo soporte)
      console.log('Browser no disponible o ya iniciado:', error);
    }

    // 5. Preparar las herramientas disponibles ------------------------------------
    const tools = [
      bashTool(remoteInstance),
      computerTool(remoteInstance),
      editTool(remoteInstance),
    ];

    // 6. Ejecutar la acción usando el SDK -----------------------------------------
    const { steps, text, usage } = await client.act({
      model: anthropic(),
      tools,
      system: UBUNTU_SYSTEM_PROMPT,
      prompt: message,
      onStep: async (step: any) => {
        // Guardar cada step como instance log
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'instance_step',
          level: 'info',
          message: step.text || 'Executing step',
          details: {
            step: step,
            tool_calls: step.toolCalls,
            tool_results: step.toolResults,
            usage: step.usage,
          },
          instance_id: instance_id,
          site_id: instance.site_id,
          user_id: instance.user_id,
          agent_id: instance.agent_id,
          command_id: instance.command_id,
        });
      },
    });

    // 7. Guardar el resultado final -----------------------------------------------
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_response',
      level: 'info',
      message: text || 'Acción completada',
      details: {
        final_text: text,
        total_steps: steps.length,
        usage: usage,
      },
      instance_id: instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      agent_id: instance.agent_id,
      command_id: instance.command_id,
    });

    return NextResponse.json({ 
      message: 'Acción ejecutada exitosamente',
      response: text,
      steps_executed: steps.length,
      token_usage: usage,
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error en POST /robots/instance/act:', err);
    
    // Guardar el error como log si tenemos instance_id
    try {
      const rawBody = await request.json();
      const { instance_id } = rawBody;
      if (instance_id) {
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'error',
          level: 'error',
          message: `Error ejecutando acción: ${err.message}`,
          details: { error: err.message, stack: err.stack },
          instance_id: instance_id,
        });
      }
    } catch (logError) {
      console.error('Error guardando log de error:', logError);
    }

    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}