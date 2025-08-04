import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance
// Crea una instancia remota en Scrapybara y la registra en la BD
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos

const CreateInstanceSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  activity: z.string().min(3, 'activity es requerido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { site_id, activity } = CreateInstanceSchema.parse(rawBody);

    // 1. Buscar instancia existente para esta actividad ------------------------------
    const { data: existingInstance, error: searchError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('site_id', site_id)
      .eq('name', activity)
      .in('status', ['running', 'paused'])
      .single();

    // Si ya existe una instancia para esta actividad, devolverla
    if (existingInstance && !searchError) {
      return NextResponse.json(
        {
          instance_id: existingInstance.id,
          provider_instance_id: existingInstance.provider_instance_id,
          remote_instance_id: existingInstance.provider_instance_id, // Para compatibilidad con getStreamURL
          cdp_url: existingInstance.cdp_url,
          status: existingInstance.status,
          message: 'Instancia existente para esta actividad',
          is_existing: true,
        },
        { status: 200 },
      );
    }

    // 2. Obtener información del sitio para el user_id -------------------------------
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', site_id)
      .single();

    if (siteError || !site) {
      return NextResponse.json({ error: 'Sitio no encontrado' }, { status: 404 });
    }

    // 3. Crear instancia en Scrapybara --------------------------------------------
    const client = new ScrapybaraClient({
      apiKey: process.env.SCRAPYBARA_API_KEY || '',
    });

    // Iniciar instancia Ubuntu por defecto
    const remoteInstance = await client.startUbuntu({ timeoutHours: 1 });

    // Asegurarse de que el navegador esté iniciado
    const browserStartResult = await remoteInstance.browser.start();
    const cdpUrl = browserStartResult.cdpUrl;

    // 4. Registrar instancia en la base de datos ----------------------------------
    const { data: instanceRecord, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .insert({
        name: activity,
        instance_type: 'ubuntu',
        status: 'running',
        provider_instance_id: remoteInstance.id,
        cdp_url: cdpUrl,
        timeout_hours: 1,
        site_id: site_id,
        user_id: site.user_id,
        created_by: site.user_id,
      })
      .select()
      .single();

    if (instanceError) {
      console.error('Error guardando la instancia:', instanceError);
      return NextResponse.json({ error: 'Error al guardar la instancia' }, { status: 500 });
    }

    return NextResponse.json(
      {
        instance_id: instanceRecord.id,
        provider_instance_id: remoteInstance.id,
        remote_instance_id: remoteInstance.id, // Para compatibilidad con getStreamURL
        cdp_url: cdpUrl,
        status: instanceRecord.status,
        message: 'Instancia creada correctamente',
        is_existing: false,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/instance:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}