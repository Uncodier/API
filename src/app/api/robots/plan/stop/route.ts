import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/stop
// Detiene la instancia remota y marca el plan como completado/cancelado
// ------------------------------------------------------------------------------------

export const maxDuration = 60; // 1 minuto

const StopSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  status: z.enum(['completed', 'cancelled']).default('completed'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { instance_id, status } = StopSchema.parse(body);

    // 1. Buscar la instancia en la BD -----------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // 2. Detener instancia en Scrapybara usando API REST ---------------------------
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

    // 3. Actualizar BD --------------------------------------------------------------
    await supabaseAdmin
      .from('remote_instances')
      .update({ status: 'stopped', stopped_at: new Date().toISOString() })
      .eq('id', instance_id);

    await supabaseAdmin
      .from('instance_plans')
      .update({ status, completed_at: new Date().toISOString(), progress_percentage: 100 })
      .eq('instance_id', instance_id);

    return NextResponse.json({ 
      message: 'Instancia detenida',
      instance_id,
      plan_status: status
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error en POST /robots/plan/stop:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}