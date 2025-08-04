import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/stop
// Detiene una instancia remota específica y actualiza su estado en la BD
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const StopInstanceSchema = z.object({
  instance_id: z.string().uuid('instance_id debe ser un UUID válido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_id } = StopInstanceSchema.parse(rawBody);

    // 1. Buscar la instancia en la BD -----------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    if (instance.status === 'stopped') {
      return NextResponse.json({ message: 'La instancia ya está detenida' }, { status: 200 });
    }

    // 2. Detener instancia en Scrapybara usando API REST --------------------------
    const scrapybaraInstanceId = instance.provider_instance_id ?? instance.id;
    
    const stopResponse = await fetch(`https://api.scrapybara.com/v1/instance/${scrapybaraInstanceId}/stop`, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
        'Content-Type': 'application/json',
      },
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error('Error deteniendo instancia en Scrapybara:', errorText);
      return NextResponse.json({ 
        error: `Error al detener instancia: ${stopResponse.status} ${errorText}` 
      }, { status: 500 });
    }

    const stopResult = await stopResponse.json();
    console.log('Instancia detenida en Scrapybara:', stopResult);

    // 3. Actualizar estado en la BD -----------------------------------------------
    const { error: updateError } = await supabaseAdmin
      .from('remote_instances')
      .update({ 
        status: 'stopped', 
        stopped_at: new Date().toISOString() 
      })
      .eq('id', instance_id);

    if (updateError) {
      console.error('Error actualizando estado de instancia:', updateError);
      return NextResponse.json({ error: 'Error al actualizar el estado' }, { status: 500 });
    }

    // 4. Marcar planes asociados como cancelados ----------------------------------
    await supabaseAdmin
      .from('instance_plans')
      .update({ 
        status: 'cancelled', 
        completed_at: new Date().toISOString() 
      })
      .eq('instance_id', instance_id)
      .in('status', ['pending', 'in_progress']);

    return NextResponse.json(
      {
        instance_id,
        status: 'stopped',
        message: 'Instancia detenida correctamente',
        scrapybara_response: stopResult,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/instance/stop:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}