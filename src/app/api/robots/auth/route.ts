import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectToInstance, validateInstanceStatus, verifyBrowserResponsive } from '@/lib/services/robot-plan-execution';

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
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = await request.json();
    console.log(`[robots/auth][${reqId}] Incoming request`, { keys: Object.keys(body || {}) });
    const { site_id, remote_instance_id, instance_id, auth_type } = AuthSchema.parse(body);
    console.log(`[robots/auth][${reqId}] Parsed payload`, { site_id, remote_instance_id, instance_id, auth_type });

    // 1. Recuperar instancia ----------------------------------------------------------------
    let instance, instanceError;

    if (instance_id) {
      console.log(`[robots/auth][${reqId}] Looking up instance by instance_id`, { instance_id, site_id });
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
      console.log(`[robots/auth][${reqId}] Looking up instance by remote_instance_id`, { remote_instance_id, site_id, isUUID });
      
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
    console.log(`[robots/auth][${reqId}] Instance found`, { id: instance.id, provider_instance_id: instance.provider_instance_id, user_id: instance.user_id });

    // Usar el provider_instance_id para las llamadas a Scrapybara
    const effectiveRemoteInstanceId = instance.provider_instance_id || remote_instance_id;
    console.log(`[robots/auth][${reqId}] Effective remote instance id`, { effectiveRemoteInstanceId });

    // 2. Preflight: conectar y validar instancia/navegador ----------------------------------
    const scrapybaraApiKey = process.env.SCRAPYBARA_API_KEY;
    if (!scrapybaraApiKey) {
      console.error(`[robots/auth][${reqId}] SCRAPYBARA_API_KEY not configured`);
      return NextResponse.json({ error: 'SCRAPYBARA_API_KEY no configurada' }, { status: 500 });
    }
    const apiKeySuffix = scrapybaraApiKey.slice(-4);
    console.log(`[robots/auth][${reqId}] SCRAPYBARA_API_KEY present`, { suffix: apiKeySuffix });

    // Conectarse a la instancia con el SDK y validar estado del navegador
    try {
      const { remoteInstance } = await connectToInstance(instance.provider_instance_id);
      const validation = validateInstanceStatus(remoteInstance);
      if (!validation.valid) {
        console.error(`[robots/auth][${reqId}] Instance not valid/running`, validation);
        return NextResponse.json({ error: validation.error, status: validation.status }, { status: 503 });
      }
      await verifyBrowserResponsive(remoteInstance);
      console.log(`[robots/auth][${reqId}] Preflight OK: browser responsive`);
    } catch (preflightError: any) {
      console.error(`[robots/auth][${reqId}] Preflight connection/validation failed`, { message: preflightError?.message });
      // Continuar igualmente a pedir current_url para obtener detalle del upstream
    }

    // 3. Obtener URL actual del navegador ---------------------------------------------------
    const instanceId = effectiveRemoteInstanceId;
    const currentUrlApiUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/current_url`;
    console.log(`[robots/auth][${reqId}] Fetching current URL`, { url: currentUrlApiUrl, instanceId });
    
    let currentUrlResponse;
    try {
      currentUrlResponse = await fetch(currentUrlApiUrl, {
        method: 'GET',
        headers: {
          'x-api-key': scrapybaraApiKey,
        },
      });
    } catch (networkError: any) {
      console.error(`[robots/auth][${reqId}] Network error fetching current_url`, { message: networkError?.message, stack: networkError?.stack });
      throw networkError;
    }
    console.log(`[robots/auth][${reqId}] current_url response`, { status: currentUrlResponse.status });

    if (!currentUrlResponse.ok) {
      const errorText = await currentUrlResponse.text();
      console.error(`[robots/auth][${reqId}] Error getting current URL`, { status: currentUrlResponse.status, body: errorText });
      return NextResponse.json(
        { error: 'Error obteniendo URL actual del navegador' },
        { status: currentUrlResponse.status }
      );
    }

    const { current_url } = await currentUrlResponse.json();
    console.log(`[robots/auth][${reqId}] Current URL obtained`, { current_url });
    
    // 3. Obtener título de la página actual ejecutando JavaScript -------------------
    const executeJsApiUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/evaluate`;
    console.log(`[robots/auth][${reqId}] Evaluating page title`, { url: executeJsApiUrl });
    
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
      console.log(`[robots/auth][${reqId}] evaluate response`, { status: titleResponse.status });

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
      console.warn(`[robots/auth][${reqId}] Error evaluating page title`, titleError);
      // Continuar con valor por defecto
    }
    
    // 4. Generar nombre de sesión basado en la URL ------------------------------------------
    const urlObj = new URL(current_url);
    const domain = urlObj.hostname;
    const sessionName = `${domain}_auth_${Date.now()}`;
    console.log(`[robots/auth][${reqId}] Session naming`, { domain, sessionName });

    // 5. Llamar API de Scrapybara para guardar auth ------------------------------------------
    const saveAuthUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/save_auth`;
    console.log(`[robots/auth][${reqId}] Saving auth state`, { url: saveAuthUrl, instanceId, sessionName });
    
    const saveAuthResponse = await fetch(saveAuthUrl, {
      method: 'POST',
      headers: {
        'x-api-key': scrapybaraApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: sessionName }),
    });
    console.log(`[robots/auth][${reqId}] save_auth response`, { status: saveAuthResponse.status });

    if (!saveAuthResponse.ok) {
      const errorText = await saveAuthResponse.text();
      console.error(`[robots/auth][${reqId}] Error saving auth state`, { status: saveAuthResponse.status, body: errorText });
      return NextResponse.json(
        { error: 'Error guardando autenticación en Scrapybara' },
        { status: saveAuthResponse.status }
      );
    }

    const authSaveResult = await saveAuthResponse.json();
    console.log(`[robots/auth][${reqId}] Auth state saved`, { auth_state_id: authSaveResult?.auth_state_id });

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
      console.error(`[robots/auth][${reqId}] Error inserting auth session`, authError);
      return NextResponse.json({ error: 'Error guardando sesión de auth' }, { status: 500 });
    }
    console.log(`[robots/auth][${reqId}] Auth session persisted`, { auth_session_id: authSession.id });

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
    console.error(`[robots/auth] Error in POST /robots/auth`, { message: err?.message, stack: err?.stack });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}