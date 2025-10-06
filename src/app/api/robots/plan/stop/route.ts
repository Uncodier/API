import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/stop
// Pausa la instancia remota y deja el plan pendiente para reanudar luego
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const PauseSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { instance_id } = PauseSchema.parse(body);

    // 1. Buscar la instancia en la BD -----------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    if (instance.status === 'paused') {
      return NextResponse.json({ message: 'La instancia ya está pausada', instance_id }, { status: 200 });
    }

    // 2. Pausar instancia en Scrapybara usando API REST -----------------------------
    const scrapybaraInstanceId = instance.provider_instance_id ?? instance.id;
    
    const pauseResponse = await fetch(`https://api.scrapybara.com/v1/instance/${scrapybaraInstanceId}/pause`, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
        'Content-Type': 'application/json',
      },
    });

    if (!pauseResponse.ok) {
      const errorText = await pauseResponse.text();
      console.error('Error pausando instancia en Scrapybara:', errorText);
      return NextResponse.json({ 
        error: `Error al pausar instancia: ${pauseResponse.status} ${errorText}` 
      }, { status: 500 });
    }

    // 3. Actualizar BD --------------------------------------------------------------
    await supabaseAdmin
      .from('remote_instances')
      .update({ status: 'paused' })
      .eq('id', instance_id);

    // Mover planes activos a 'paused' para permitir reanudación
    await supabaseAdmin
      .from('instance_plans')
      .update({ status: 'paused' })
      .eq('instance_id', instance_id)
      .in('status', ['pending', 'in_progress']);

    return NextResponse.json({ 
      message: 'Instancia pausada',
      instance_id,
      instance_status: 'paused',
      plan_status: 'paused'
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error en POST /robots/plan/stop:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}