import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

// ------------------------------------------------------------------------------------
// POST /api/robots/auth
// Guarda la sesión de autenticación del navegador para reutilizarla en futuras tareas
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos

const AuthSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido'),
  name: z.string().min(1, 'name requerido'),
  domain: z.string().url('domain debe ser URL válida'),
  auth_type: z.enum(['cookies', 'localStorage', 'sessionStorage', 'credentials', 'oauth']).default('cookies'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { instance_id, name, domain, auth_type } = AuthSchema.parse(body);

    // 1. Recuperar instancia ----------------------------------------------------------------
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 });
    }

    // 2. Conectar Scrapybara y guardar auth --------------------------------------------------
    const client = new ScrapybaraClient({ apiKey: process.env.SCRAPYBARA_API_KEY || '' });
    // @ts-ignore
    const remoteInstance = await client.resumeInstance(instance.provider_instance_id ?? instance.id);

    // Asegurarse de que el navegador esté iniciado
    await remoteInstance.browser.start();
    const authSaveResult = await remoteInstance.browser.saveAuth({ name });

    // 3. Registrar sesión en BD --------------------------------------------------------------
    const { data: authSession, error: authError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .insert({
        name,
        domain,
        auth_type,
        provider_auth_state_id: authSaveResult.authStateId,
        site_id: instance.site_id,
        user_id: instance.user_id,
        instance_id,
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
        provider_auth_state_id: authSaveResult.authStateId,
        message: 'Sesión guardada correctamente',
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/auth:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}