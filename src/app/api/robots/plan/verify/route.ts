import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/verify
// Recupera logs y toma un screenshot para verificar el progreso de la instancia.
// Si detecta bloqueo puede devolver un mensaje para continuar el plan.
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos de verificación

const VerifySchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  instance_plan_id: z.string().uuid('instance_plan_id inválido'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { instance_id, instance_plan_id } = VerifySchema.parse(body);

    // 1. Obtener metadata -----------------------------------------------------------------
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

    // 2. Conectar Scrapybara y tomar screenshot -------------------------------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const remoteInstance = await client.resumeInstance(instance.provider_instance_id ?? instance.id);

    const screenshot = await remoteInstance.screenshot();
    const base64Image = screenshot?.base64Image || '';

    // 3. Obtener últimos logs --------------------------------------------------------------
    const { data: logs } = await supabaseAdmin
      .from('instance_logs')
      .select('*')
      .eq('instance_id', instance_id)
      .order('created_at', { ascending: false })
      .limit(50);

    // Guardar un log de verificación
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'system',
      level: 'info',
      message: 'Verification performed',
      details: { verification: true },
      screenshot_base64: base64Image,
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    return NextResponse.json(
      {
        logs,
        screenshot_base64: base64Image,
        message: 'Verificación completada',
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/plan/verify:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}