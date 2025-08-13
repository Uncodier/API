import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// POST /api/robots/auth
// Guarda la sesión de autenticación del navegador para reutilizarla en futuras tareas
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos

const AuthSchema = z.object({
  site_id: z.string().uuid('site_id inválido'),
  remote_instance_id: z.string().min(1, 'remote_instance_id requerido').optional(),
  instance_id: z.string().uuid('instance_id inválido').optional(),
  auth_type: z.enum(['cookies', 'localStorage', 'sessionStorage', 'credentials', 'oauth']).default('cookies'),
}).refine(
  (data) => data.remote_instance_id || data.instance_id,
  { message: 'Se requiere remote_instance_id o instance_id' }
);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, remote_instance_id, instance_id, auth_type } = AuthSchema.parse(body);

    // 1. Recuperar instancia ----------------------------------------------------------------
    let instance, instanceError;

    if (instance_id) {
      // Buscar por ID interno de la BD
      const result = await supabaseAdmin
        .from('remote_instances')
        .select('*')
        .eq('id', instance_id)
        .eq('site_id', site_id)
        .single();
      instance = result.data;
      instanceError = result.error;
    } else if (remote_instance_id) {
      // Determinar si es un UUID (ID interno) o provider_instance_id
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(remote_instance_id);
      
      let result;
      if (isUUID) {
        // Buscar por ID interno de la BD
        result = await supabaseAdmin
          .from('remote_instances')
          .select('*')
          .eq('site_id', site_id)
          .eq('id', remote_instance_id)
          .single();
      } else {
        // Buscar por provider_instance_id (método original)
        result = await supabaseAdmin
          .from('remote_instances')
          .select('*')
          .eq('site_id', site_id)
          .eq('provider_instance_id', remote_instance_id)
          .single();
      }
      
      instance = result.data;
      instanceError = result.error;
    }

    if (instanceError || !instance) {
      console.error('Error buscando instancia:', instanceError);
      if (instance_id) {
        console.log('Búsqueda por:', `instance_id: ${instance_id}`);
      } else if (remote_instance_id) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(remote_instance_id);
        console.log('Búsqueda por:', `remote_instance_id: ${remote_instance_id} (${isUUID ? 'ID interno' : 'provider_instance_id'})`);
      }
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // Usar el provider_instance_id para las llamadas a Scrapybara
    const effectiveRemoteInstanceId = instance.provider_instance_id || remote_instance_id;

    // 2. Obtener URL actual del navegador ---------------------------------------------------
    const scrapybaraApiKey = process.env.SCRAPYBARA_API_KEY;
    if (!scrapybaraApiKey) {
      return NextResponse.json({ error: 'SCRAPYBARA_API_KEY no configurada' }, { status: 500 });
    }

    const instanceId = effectiveRemoteInstanceId;
    const currentUrlApiUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/current_url`;
    
    const currentUrlResponse = await fetch(currentUrlApiUrl, {
      method: 'GET',
      headers: {
        'x-api-key': scrapybaraApiKey,
      },
    });

    if (!currentUrlResponse.ok) {
      const errorText = await currentUrlResponse.text();
      console.error('Error obteniendo URL actual:', errorText);
      return NextResponse.json(
        { error: 'Error obteniendo URL actual del navegador' },
        { status: currentUrlResponse.status }
      );
    }

    const { current_url } = await currentUrlResponse.json();
    
    // 3. Obtener título de la página actual ejecutando JavaScript -------------------
    const executeJsApiUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/evaluate`;
    
    let pageTitle = 'Sin título';
    try {
      const titleResponse = await fetch(executeJsApiUrl, {
        method: 'POST',
        headers: {
          'x-api-key': scrapybaraApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: 'document.title || "Sin título"'
        }),
      });

      if (titleResponse.ok) {
        const titleData = await titleResponse.json();
        pageTitle = titleData.result || 'Sin título';
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Page title obtained: ${pageTitle}`);
      } else {
        console.warn('No se pudo obtener el título de la página, usando valor por defecto');
        console.warn('Response status:', titleResponse.status);
        const errorText = await titleResponse.text();
        console.warn('Response body:', errorText);
      }
    } catch (titleError) {
      console.warn('Error obteniendo título de la página:', titleError);
      // Continuar con valor por defecto
    }
    
    // 4. Generar nombre de sesión basado en la URL ------------------------------------------
    const urlObj = new URL(current_url);
    const domain = urlObj.hostname;
    const sessionName = `${domain}_auth_${Date.now()}`;

    // 5. Llamar API de Scrapybara para guardar auth ------------------------------------------
    const saveAuthUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/save_auth`;
    
    const saveAuthResponse = await fetch(saveAuthUrl, {
      method: 'POST',
      headers: {
        'x-api-key': scrapybaraApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: sessionName }),
    });

    if (!saveAuthResponse.ok) {
      const errorText = await saveAuthResponse.text();
      console.error('Error llamando API Scrapybara:', errorText);
      return NextResponse.json(
        { error: 'Error guardando autenticación en Scrapybara' },
        { status: saveAuthResponse.status }
      );
    }

    const authSaveResult = await saveAuthResponse.json();

    // 6. Registrar sesión en BD --------------------------------------------------------------
    const { data: authSession, error: authError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .insert({
        name: sessionName,
        description: pageTitle,
        domain: current_url,
        auth_type,
        provider_auth_state_id: authSaveResult.auth_state_id,
        site_id: site_id,
        user_id: instance.user_id,
        instance_id: instance.id,
        created_by: instance.user_id,
      })
      .select()
      .single();

    if (authError) {
      console.error('Error guardando sesión de auth:', authError);
      return NextResponse.json({ error: 'Error guardando sesión de auth' }, { status: 500 });
    }

    return NextResponse.json(
      {
        auth_session_id: authSession.id,
        provider_auth_state_id: authSaveResult.auth_state_id,
        session_name: sessionName,
        current_url: current_url,
        domain: domain,
        page_title: pageTitle,
        message: 'Sesión guardada correctamente',
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/auth:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}