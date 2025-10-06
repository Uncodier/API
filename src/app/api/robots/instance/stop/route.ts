import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/stop
// Pausa una instancia remota específica y actualiza su estado en la BD
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const PauseInstanceSchema = z.object({
  instance_id: z.string().uuid('instance_id debe ser un UUID válido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id } = PauseInstanceSchema.parse(rawBody);

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
      return NextResponse.json({ message: 'La instancia ya está pausada' }, { status: 200 });
    }

    // 2. Pausar instancia en Scrapybara usando API REST ----------------------------
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

    // 3. Actualizar estado en la BD -----------------------------------------------
    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({ 
        status: 'paused'
      })
      .eq('id', instance_id);

    if (updateError) {
      console.error('Error actualizando estado de instancia:', updateError);
      return NextResponse.json({ error: 'Error al actualizar el estado' }, { status: 500 });
    }

    // 4. Mark in-progress and paused plans as failed -----------------------------------------
    const { data: affectedPlans } = await supabaseAdmin
      .from('instance_plans')
      .select('id, title')
      .eq('instance_id', instance_id)
      .in('status', ['in_progress', 'paused']);

    if (affectedPlans && affectedPlans.length > 0) {
      console.log(`Marking ${affectedPlans.length} plans as failed due to instance pause`);
      
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          status: 'failed',
          error_message: 'Instance was paused while plan was in progress',
          updated_at: new Date().toISOString()
        })
        .eq('instance_id', instance_id)
        .in('status', ['in_progress', 'paused']);
    }

    return NextResponse.json(
      {
        instance_id,
        status: 'paused',
        message: 'Instance paused successfully',
        affected_plans: affectedPlans?.length || 0,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/instance/stop:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}