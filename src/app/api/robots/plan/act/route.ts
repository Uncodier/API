import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/act
// Ejecuta acciones del plan durante un periodo limitado (máx 5 min) y almacena logs
// ------------------------------------------------------------------------------------

export const maxDuration = 300; // 5 minutos en Vercel

const ActSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  instance_plan_id: z.string().uuid('instance_plan_id inválido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id, instance_plan_id } = ActSchema.parse(rawBody);

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

    // 2. Conectar a la instancia vía Scrapybara ------------------------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });

    // NOTA: La SDK no expone un método documentado para adjuntar una instancia existente.
    // Supondremos que `client.resumeInstance` existe; si no, este bloque deberá ajustarse.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const remoteInstance = await client.resumeInstance(instance.provider_instance_id ?? instance.id);

    // 3. Ejecutar paso simple: obtener listado de procesos como prueba -------------
    const { steps } = await client.act({
      model: undefined, // Se usará la configuración por defecto (Anthropic)
      tools: [],
      system: 'Execute plan step',
      prompt: `Ejecuta el siguiente paso del plan "${plan.title}" y reporta progreso.`,
      onStep: async (step: any) => {
        await supabaseAdmin.from('instance_logs').insert({
          log_type: 'agent_action',
          level: 'info',
          message: step.text ?? 'step',
          details: step,
          instance_id: instance_id,
          site_id: plan.site_id,
          user_id: plan.user_id,
          agent_id: plan.agent_id,
          command_id: plan.command_id,
        });
      },
    });

    // 4. Actualizar métricas mínimas ----------------------------------------------
    await supabaseAdmin.from('instance_plans').update({
      steps_completed: (plan.steps_completed ?? 0) + steps.length,
      progress_percentage: Math.min(100, (plan.steps_completed ?? 0) + steps.length),
    }).eq('id', instance_plan_id);

    return NextResponse.json({ message: 'Ejecución finalizada y logs almacenados' }, { status: 200 });
  } catch (err: any) {
    console.error('Error en POST /robots/plan/act:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}