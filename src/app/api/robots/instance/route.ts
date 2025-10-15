import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { autoAuthenticateInstance } from '@/lib/helpers/automation-auth';
import { createOrResumeInstance } from '@/lib/services/robot-instance/instance-lifecycle';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance
// Crea una instancia remota en Scrapybara y la registra en la BD
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos

const CreateInstanceSchema = z.object({
  site_id: z.string().uuid('site_id debe ser un UUID válido'),
  activity: z.string().min(3, 'activity es requerido'),
  instance_id: z.string().uuid('instance_id inválido').optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { site_id, activity, instance_id } = CreateInstanceSchema.parse(rawBody);

    // Use shared helper to create or resume based on presence of instance_id
    const { instanceRecord, justCreated } = await createOrResumeInstance({
      siteId: site_id,
      activity,
      instanceId: instance_id,
    });

    let authResult: any = { success: false };
    // Always attempt auto-authentication for new instances
    if (instanceRecord?.provider_instance_id) {
      try {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Attempting auto-authentication for site_id: ${site_id}`);
        authResult = await autoAuthenticateInstance(instanceRecord.provider_instance_id, site_id);
        if (authResult.success) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Browser authenticated successfully using session: ${authResult.session?.name}`);
        } else {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Auto-authentication not available: ${authResult.error}`);
        }
      } catch (authErr) {
        console.warn('₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Auto-authentication failed:', (authErr as any)?.message || authErr);
      }
    }

    return NextResponse.json(
      {
        instance_id: instanceRecord.id,
        provider_instance_id: instanceRecord.provider_instance_id,
        remote_instance_id: instanceRecord.provider_instance_id,
        cdp_url: instanceRecord.cdp_url,
        status: instanceRecord.status,
        message: 'Instancia creada correctamente',
        is_existing: false,
        authentication: {
          applied: !!authResult.success,
          session_name: authResult.session?.name,
          auth_state_id: authResult.auth_state_id,
          error: authResult.error
        }
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/instance:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}